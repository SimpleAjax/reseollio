//! SQLite storage implementation

use super::{InternalJob, JobFilter, JobOptions, JobResult, JobStatus, NewJob, Storage};
use crate::error::{ReseolioError, Result, StorageError};
use async_trait::async_trait;
use chrono::{DateTime, TimeZone, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{debug, info};

/// SQLite-based storage implementation
#[derive(Clone)]
pub struct SqliteStorage {
    conn: Arc<Mutex<Connection>>,
}

impl SqliteStorage {
    /// Create a new SQLite storage at the given path
    pub async fn new(path: &Path) -> Result<Self> {
        let conn = Connection::open(path).map_err(StorageError::from)?;

        // Enable WAL mode for better concurrent access
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")
            .map_err(StorageError::from)?;

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// Create an in-memory database for testing
    #[cfg(test)]
    pub async fn in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory().map_err(StorageError::from)?;
        let storage = Self {
            conn: Arc::new(Mutex::new(conn)),
        };
        storage.migrate().await?;
        Ok(storage)
    }
}

#[async_trait]
impl Storage for SqliteStorage {
    async fn migrate(&self) -> Result<()> {
        let conn = self.conn.lock().await;

        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS jobs (
                id              TEXT PRIMARY KEY,
                name            TEXT NOT NULL,
                args            BLOB NOT NULL,
                options         TEXT NOT NULL,
                status          TEXT NOT NULL,
                attempt         INTEGER NOT NULL DEFAULT 0,
                created_at      INTEGER NOT NULL,
                scheduled_at    INTEGER NOT NULL,
                started_at      INTEGER,
                completed_at    INTEGER,
                error           TEXT,
                result          BLOB,
                worker_id       TEXT,
                idempotency_key TEXT UNIQUE
            );

            CREATE INDEX IF NOT EXISTS idx_jobs_status_scheduled 
                ON jobs(status, scheduled_at);
            CREATE INDEX IF NOT EXISTS idx_jobs_name 
                ON jobs(name);
            CREATE INDEX IF NOT EXISTS idx_jobs_idempotency 
                ON jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;

            CREATE TABLE IF NOT EXISTS schema_version (
                version INTEGER PRIMARY KEY
            );

            INSERT OR IGNORE INTO schema_version (version) VALUES (1);
            "#,
        )
        .map_err(StorageError::from)?;

        info!("SQLite migrations applied successfully");
        Ok(())
    }

    async fn insert_job(&self, new_job: NewJob) -> Result<InternalJob> {
        let job = new_job.into_job();
        let conn = self.conn.lock().await;

        let options_json = serde_json::to_string(&job.options)?;

        conn.execute(
            r#"
            INSERT INTO jobs (id, name, args, options, status, attempt, 
                              created_at, scheduled_at, idempotency_key)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            "#,
            params![
                &job.id,
                &job.name,
                &job.args,
                &options_json,
                job.status.as_str(),
                job.attempt,
                job.created_at.timestamp(),
                job.scheduled_at.timestamp(),
                &job.idempotency_key,
            ],
        )
        .map_err(StorageError::from)?;

        debug!("Inserted job: {} ({})", job.id, job.name);
        Ok(job)
    }

    async fn get_job(&self, job_id: &str) -> Result<Option<InternalJob>> {
        let conn = self.conn.lock().await;

        let result = conn
            .query_row(
                r#"
            SELECT id, name, args, options, status, attempt, 
                   created_at, scheduled_at, started_at, completed_at,
                   error, result, worker_id, idempotency_key
            FROM jobs WHERE id = ?1
            "#,
                params![job_id],
                |row| row_to_job(row),
            )
            .optional()
            .map_err(StorageError::from)?;

        Ok(result)
    }

    async fn get_job_by_idempotency_key(&self, key: &str) -> Result<Option<InternalJob>> {
        let conn = self.conn.lock().await;

        let result = conn
            .query_row(
                r#"
            SELECT id, name, args, options, status, attempt, 
                   created_at, scheduled_at, started_at, completed_at,
                   error, result, worker_id, idempotency_key
            FROM jobs WHERE idempotency_key = ?1
            "#,
                params![key],
                |row| row_to_job(row),
            )
            .optional()
            .map_err(StorageError::from)?;

        Ok(result)
    }

    async fn get_pending_jobs(&self, limit: usize) -> Result<Vec<InternalJob>> {
        let conn = self.conn.lock().await;
        let now = Utc::now().timestamp();

        let mut stmt = conn
            .prepare(
                r#"
            SELECT id, name, args, options, status, attempt, 
                   created_at, scheduled_at, started_at, completed_at,
                   error, result, worker_id, idempotency_key
            FROM jobs 
            WHERE status = 'PENDING' AND scheduled_at <= ?1
            ORDER BY scheduled_at ASC
            LIMIT ?2
            "#,
            )
            .map_err(StorageError::from)?;

        let jobs = stmt
            .query_map(params![now, limit as i64], |row| row_to_job(row))
            .map_err(StorageError::from)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(StorageError::from)?;

        Ok(jobs)
    }

    async fn claim_job(&self, job_id: &str, worker_id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        let now = Utc::now().timestamp();

        let rows = conn
            .execute(
                r#"
            UPDATE jobs 
            SET status = 'RUNNING', 
                worker_id = ?2, 
                started_at = ?3,
                attempt = attempt + 1
            WHERE id = ?1 AND status = 'PENDING'
            "#,
                params![job_id, worker_id, now],
            )
            .map_err(StorageError::from)?;

        Ok(rows > 0)
    }

    async fn update_job_result(&self, job_id: &str, result: JobResult) -> Result<InternalJob> {
        let conn = self.conn.lock().await;
        let now = Utc::now().timestamp();

        match result {
            JobResult::Success { return_value } => {
                conn.execute(
                    r#"
                    UPDATE jobs 
                    SET status = 'SUCCESS', 
                        completed_at = ?2,
                        result = ?3,
                        error = NULL
                    WHERE id = ?1
                    "#,
                    params![job_id, now, return_value],
                )
                .map_err(StorageError::from)?;
            }
            JobResult::Failed {
                error,
                should_retry,
            } => {
                // Get current job to check attempt count
                let job = self
                    .get_job(job_id)
                    .await?
                    .ok_or_else(|| ReseolioError::JobNotFound(job_id.to_string()))?;

                if should_retry && job.attempt < job.options.max_attempts {
                    // Schedule retry with backoff
                    let delay = calculate_backoff(&job.options, job.attempt);
                    let next_run = now + delay as i64;

                    conn.execute(
                        r#"
                        UPDATE jobs 
                        SET status = 'PENDING', 
                            scheduled_at = ?2,
                            error = ?3,
                            worker_id = NULL,
                            started_at = NULL
                        WHERE id = ?1
                        "#,
                        params![job_id, next_run, &error],
                    )
                    .map_err(StorageError::from)?;
                } else {
                    // Max retries exceeded, mark as dead
                    conn.execute(
                        r#"
                        UPDATE jobs 
                        SET status = 'DEAD', 
                            completed_at = ?2,
                            error = ?3
                        WHERE id = ?1
                        "#,
                        params![job_id, now, &error],
                    )
                    .map_err(StorageError::from)?;
                }
            }
        }

        drop(conn);
        self.get_job(job_id)
            .await?
            .ok_or_else(|| ReseolioError::JobNotFound(job_id.to_string()))
    }

    async fn mark_job_dead(&self, job_id: &str, error: &str) -> Result<InternalJob> {
        let conn = self.conn.lock().await;
        let now = Utc::now().timestamp();

        conn.execute(
            r#"
            UPDATE jobs 
            SET status = 'DEAD', 
                completed_at = ?2,
                error = ?3
            WHERE id = ?1
            "#,
            params![job_id, now, error],
        )
        .map_err(StorageError::from)?;

        drop(conn);
        self.get_job(job_id)
            .await?
            .ok_or_else(|| ReseolioError::JobNotFound(job_id.to_string()))
    }

    async fn cancel_job(&self, job_id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        let now = Utc::now().timestamp();

        let rows = conn
            .execute(
                r#"
            UPDATE jobs 
            SET status = 'CANCELLED', 
                completed_at = ?2
            WHERE id = ?1 AND status = 'PENDING'
            "#,
                params![job_id, now],
            )
            .map_err(StorageError::from)?;

        Ok(rows > 0)
    }

    async fn get_stale_running_jobs(&self, stale_threshold_secs: i64) -> Result<Vec<InternalJob>> {
        let conn = self.conn.lock().await;
        let threshold = Utc::now().timestamp() - stale_threshold_secs;

        let mut stmt = conn
            .prepare(
                r#"
            SELECT id, name, args, options, status, attempt, 
                   created_at, scheduled_at, started_at, completed_at,
                   error, result, worker_id, idempotency_key
            FROM jobs 
            WHERE status = 'RUNNING' AND started_at < ?1
            "#,
            )
            .map_err(StorageError::from)?;

        let jobs = stmt
            .query_map(params![threshold], |row| row_to_job(row))
            .map_err(StorageError::from)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(StorageError::from)?;

        Ok(jobs)
    }

    async fn reset_stale_job(&self, job_id: &str) -> Result<()> {
        let conn = self.conn.lock().await;
        let now = Utc::now().timestamp();

        conn.execute(
            r#"
            UPDATE jobs 
            SET status = 'PENDING', 
                scheduled_at = ?2,
                worker_id = NULL,
                started_at = NULL
            WHERE id = ?1 AND status = 'RUNNING'
            "#,
            params![job_id, now],
        )
        .map_err(StorageError::from)?;

        Ok(())
    }

    async fn list_jobs(&self, filter: JobFilter) -> Result<(Vec<InternalJob>, i32)> {
        let conn = self.conn.lock().await;

        let mut sql = String::from(
            r#"
            SELECT id, name, args, options, status, attempt, 
                   created_at, scheduled_at, started_at, completed_at,
                   error, result, worker_id, idempotency_key
            FROM jobs WHERE 1=1
            "#,
        );

        // Build WHERE clauses
        if !filter.statuses.is_empty() {
            let status_list: Vec<String> = filter
                .statuses
                .iter()
                .map(|s| format!("'{}'", s.as_str()))
                .collect();
            sql.push_str(&format!(" AND status IN ({})", status_list.join(",")));
        }

        if !filter.names.is_empty() {
            let name_list: Vec<String> = filter
                .names
                .iter()
                .map(|n| format!("'{}'", n.replace("'", "''")))
                .collect();
            sql.push_str(&format!(" AND name IN ({})", name_list.join(",")));
        }

        // Order
        let order_col = filter.order_by.as_deref().unwrap_or("created_at");
        let order_dir = if filter.ascending { "ASC" } else { "DESC" };
        sql.push_str(&format!(" ORDER BY {} {}", order_col, order_dir));

        // Pagination
        let limit = filter.limit.unwrap_or(100);
        let offset = filter.offset.unwrap_or(0);
        sql.push_str(&format!(" LIMIT {} OFFSET {}", limit, offset));

        let mut stmt = conn.prepare(&sql).map_err(StorageError::from)?;
        let jobs = stmt
            .query_map([], |row| row_to_job(row))
            .map_err(StorageError::from)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(StorageError::from)?;

        // Get total count
        let total: i32 = conn
            .query_row("SELECT COUNT(*) FROM jobs", [], |row| row.get(0))
            .map_err(StorageError::from)?;

        Ok((jobs, total))
    }
}

/// Convert a database row to a Job struct
fn row_to_job(row: &rusqlite::Row) -> rusqlite::Result<InternalJob> {
    let options_str: String = row.get(3)?;
    let options: JobOptions = serde_json::from_str(&options_str).unwrap_or_default();

    let status_str: String = row.get(4)?;
    let status = JobStatus::from_str(&status_str).unwrap_or(JobStatus::Pending);

    Ok(InternalJob {
        id: row.get(0)?,
        name: row.get(1)?,
        args: row.get(2)?,
        options,
        status,
        attempt: row.get(5)?,
        created_at: timestamp_to_datetime(row.get(6)?),
        scheduled_at: timestamp_to_datetime(row.get(7)?),
        started_at: row.get::<_, Option<i64>>(8)?.map(timestamp_to_datetime),
        completed_at: row.get::<_, Option<i64>>(9)?.map(timestamp_to_datetime),
        error: row.get(10)?,
        result: row.get(11)?,
        worker_id: row.get(12)?,
        idempotency_key: row.get(13)?,
    })
}

fn timestamp_to_datetime(ts: i64) -> DateTime<Utc> {
    Utc.timestamp_opt(ts, 0).unwrap()
}

/// Calculate backoff delay in seconds based on strategy
fn calculate_backoff(options: &JobOptions, attempt: i32) -> i32 {
    use super::BackoffStrategy;

    let base_delay = match options.backoff {
        BackoffStrategy::Fixed => options.initial_delay_ms,
        BackoffStrategy::Exponential => options.initial_delay_ms * 2_i32.pow(attempt as u32 - 1),
        BackoffStrategy::Linear => options.initial_delay_ms * attempt,
    };

    // Apply max delay cap
    let capped = base_delay.min(options.max_delay_ms);

    // Apply jitter
    if options.jitter > 0.0 {
        use rand::Rng;
        let mut rng = rand::thread_rng();
        let jitter_range = (capped as f32 * options.jitter) as i32;
        let jitter = rng.gen_range(-jitter_range..=jitter_range);
        (capped + jitter).max(0) / 1000 // Convert to seconds
    } else {
        capped / 1000
    }
}
