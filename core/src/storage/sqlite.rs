//! SQLite storage implementation

use super::{
    calculate_backoff, timestamp_to_datetime, InternalJob, JobFilter, JobOptions, JobResult,
    JobStatus, NewJob, Storage,
};
use crate::error::{ReseolioError, Result, StorageError};
use async_trait::async_trait;
use chrono::Utc;
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
                idempotency_key TEXT,
                UNIQUE(name, idempotency_key)
            );

            CREATE INDEX IF NOT EXISTS idx_jobs_status_scheduled 
                ON jobs(status, scheduled_at);
            CREATE INDEX IF NOT EXISTS idx_jobs_name 
                ON jobs(name);
            CREATE INDEX IF NOT EXISTS idx_jobs_name_idempotency 
                ON jobs(name, idempotency_key) WHERE idempotency_key IS NOT NULL;

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

    async fn get_job_by_idempotency_key(
        &self,
        name: &str,
        key: &str,
    ) -> Result<Option<InternalJob>> {
        let conn = self.conn.lock().await;

        let result = conn
            .query_row(
                r#"
            SELECT id, name, args, options, status, attempt, 
                   created_at, scheduled_at, started_at, completed_at,
                   error, result, worker_id, idempotency_key
            FROM jobs WHERE name = ?1 AND idempotency_key = ?2
            "#,
                params![name, key],
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

    async fn claim_jobs(&self, claims: Vec<(String, String)>) -> Result<Vec<String>> {
        let mut conn = self.conn.lock().await;
        let now = Utc::now().timestamp();
        let mut successfully_claimed = Vec::new();

        let tx = conn.transaction().map_err(StorageError::from)?;

        {
            let mut stmt = tx
                .prepare(
                    r#"
                    UPDATE jobs 
                    SET status = 'RUNNING', 
                        worker_id = ?2, 
                        started_at = ?3,
                        attempt = attempt + 1
                    WHERE id = ?1 AND status = 'PENDING'
                    "#,
                )
                .map_err(StorageError::from)?;

            for (job_id, worker_id) in claims {
                let rows = stmt
                    .execute(params![job_id, worker_id, now])
                    .map_err(StorageError::from)?;

                if rows > 0 {
                    successfully_claimed.push(job_id);
                }
            }
        } // stmt dropped here

        tx.commit().map_err(StorageError::from)?;

        Ok(successfully_claimed)
    }

    async fn claim_and_fetch_jobs(
        &self,
        worker_id: &str,
        job_names: &[String],
        limit: usize,
    ) -> Result<Vec<InternalJob>> {
        let mut conn = self.conn.lock().await;
        let now = Utc::now().timestamp();

        let tx = conn.transaction().map_err(StorageError::from)?;

        // SQLite doesn't support FOR UPDATE SKIP LOCKED, but since we're
        // single-threaded through the Mutex anyway, we can do this in a transaction

        // Step 1: Find pending job IDs
        let sql = if job_names.is_empty() {
            r#"
            SELECT id FROM jobs 
            WHERE status = 'PENDING' AND scheduled_at <= ?1
            ORDER BY scheduled_at ASC
            LIMIT ?2
            "#
            .to_string()
        } else {
            let name_list: Vec<String> = job_names
                .iter()
                .map(|n| format!("'{}'", n.replace("'", "''")))
                .collect();
            format!(
                r#"
                SELECT id FROM jobs 
                WHERE status = 'PENDING' AND scheduled_at <= ?1
                  AND name IN ({})
                ORDER BY scheduled_at ASC
                LIMIT ?2
                "#,
                name_list.join(",")
            )
        };

        let job_ids: Vec<String> = {
            let mut stmt = tx.prepare(&sql).map_err(StorageError::from)?;
            let rows = stmt
                .query_map(params![now, limit as i64], |row| row.get(0))
                .map_err(StorageError::from)?;
            let mut ids = Vec::new();
            for row in rows {
                ids.push(row.map_err(StorageError::from)?);
            }
            ids
        };

        if job_ids.is_empty() {
            return Ok(Vec::new());
        }

        // Step 2: Update those jobs to RUNNING
        // Build placeholders starting from ?3 (since ?1 is worker_id, ?2 is now)
        let placeholders: String = (3..3 + job_ids.len())
            .map(|i| format!("?{}", i))
            .collect::<Vec<_>>()
            .join(",");

        let update_sql = format!(
            r#"
            UPDATE jobs 
            SET status = 'RUNNING', 
                worker_id = ?1, 
                started_at = ?2,
                attempt = attempt + 1
            WHERE id IN ({}) AND status = 'PENDING'
            "#,
            placeholders
        );

        {
            use rusqlite::ToSql;
            let mut params_vec: Vec<&dyn ToSql> = Vec::new();
            let worker_id_owned = worker_id.to_string();
            params_vec.push(&worker_id_owned);
            params_vec.push(&now);
            for id in &job_ids {
                params_vec.push(id);
            }
            tx.execute(&update_sql, params_vec.as_slice())
                .map_err(StorageError::from)?;
        }

        // Step 3: Fetch the full job data
        let select_placeholders: String = (1..=job_ids.len())
            .map(|i| format!("?{}", i))
            .collect::<Vec<_>>()
            .join(",");

        let select_sql = format!(
            r#"
            SELECT id, name, args, options, status, attempt, 
                   created_at, scheduled_at, started_at, completed_at,
                   error, result, worker_id, idempotency_key
            FROM jobs WHERE id IN ({})
            "#,
            select_placeholders
        );

        let jobs: Vec<InternalJob> = {
            use rusqlite::ToSql;
            let params_refs: Vec<&dyn ToSql> = job_ids.iter().map(|s| s as &dyn ToSql).collect();
            let mut stmt = tx.prepare(&select_sql).map_err(StorageError::from)?;
            let rows = stmt
                .query_map(params_refs.as_slice(), |row| row_to_job(row))
                .map_err(StorageError::from)?;
            let mut result = Vec::new();
            for row in rows {
                result.push(row.map_err(StorageError::from)?);
            }
            result
        };

        tx.commit().map_err(StorageError::from)?;

        debug!(
            "Worker {} claimed {} jobs via pull (SQLite)",
            worker_id,
            jobs.len()
        );

        Ok(jobs)
    }

    async fn update_job_results(&self, updates: Vec<(String, JobResult)>) -> Result<()> {
        let mut conn = self.conn.lock().await;
        let now = Utc::now().timestamp();

        let tx = conn.transaction().map_err(StorageError::from)?;

        {
            // Prepare statements for Success, Retry, and Dead updates
            let mut stmt_success = tx
                .prepare(
                    r#"
                    UPDATE jobs 
                    SET status = 'SUCCESS', 
                        completed_at = ?2,
                        result = ?3,
                        error = NULL
                    WHERE id = ?1
                    "#,
                )
                .map_err(StorageError::from)?;

            let mut stmt_retry = tx
                .prepare(
                    r#"
                    UPDATE jobs 
                    SET status = 'PENDING', 
                        scheduled_at = ?2,
                        error = ?3,
                        worker_id = NULL,
                        started_at = NULL
                    WHERE id = ?1
                    "#,
                )
                .map_err(StorageError::from)?;

            let mut stmt_dead = tx
                .prepare(
                    r#"
                    UPDATE jobs 
                    SET status = 'DEAD', 
                        completed_at = ?2,
                        error = ?3
                    WHERE id = ?1
                    "#,
                )
                .map_err(StorageError::from)?;

            // We need to fetch job info for retries.
            // Since we can't easily interleave SELECT and UPDATE on the same transaction
            // with prepared statements in this loop structure without complexity,
            // AND we already have the job ID, we optimally just need the 'options' and 'attempt' count.
            // For now, to keep it correct and robust, we'll do a quick SELECT for failed jobs.
            // This is still MUCH faster than separate transactions.
            let mut stmt_get_job = tx
                .prepare("SELECT options, attempt FROM jobs WHERE id = ?1")
                .map_err(StorageError::from)?;

            for (job_id, result) in updates {
                match result {
                    JobResult::Success { return_value } => {
                        stmt_success
                            .execute(params![job_id, now, return_value])
                            .map_err(StorageError::from)?;
                    }
                    JobResult::Failed {
                        error,
                        should_retry,
                    } => {
                        // We need job details to calculate backoff
                        let job_row = stmt_get_job
                            .query_row(params![job_id], |row| {
                                let options_str: String = row.get(0)?;
                                let options: JobOptions =
                                    serde_json::from_str(&options_str).unwrap_or_default();
                                let attempt: i32 = row.get(1)?;
                                Ok((options, attempt))
                            })
                            .optional()
                            .map_err(StorageError::from)?;

                        if let Some((options, attempt)) = job_row {
                            if should_retry && attempt < options.max_attempts {
                                // Schedule retry
                                let delay = calculate_backoff(&options, attempt);
                                let next_run = now + delay as i64;
                                stmt_retry
                                    .execute(params![job_id, next_run, &error])
                                    .map_err(StorageError::from)?;
                            } else {
                                // Mark dead
                                stmt_dead
                                    .execute(params![job_id, now, &error])
                                    .map_err(StorageError::from)?;
                            }
                        }
                    }
                }
            }
        } // Drop statements

        tx.commit().map_err(StorageError::from)?;

        Ok(())
    }

    async fn update_job_result(&self, job_id: &str, result: JobResult) -> Result<InternalJob> {
        let conn = self.conn.lock().await;
        // ... (existing implementation)
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
                // Query current job using already-held connection to avoid deadlock
                let job = conn
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
                    .map_err(StorageError::from)?;

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

    async fn get_stale_running_jobs(&self, _stale_threshold_secs: i64) -> Result<Vec<InternalJob>> {
        let conn = self.conn.lock().await;
        let now_ms = Utc::now().timestamp_millis();

        let mut stmt = conn
            .prepare(
                r#"
            SELECT id, name, args, options, status, attempt, 
                   created_at, scheduled_at, started_at, completed_at,
                   error, result, worker_id, idempotency_key
            FROM jobs 
            WHERE status = 'RUNNING' 
              AND started_at IS NOT NULL
              AND (?1 - started_at * 1000) > COALESCE(
                  CAST(json_extract(options, '$.timeout_ms') AS INTEGER),
                  30000
              )
            "#,
            )
            .map_err(StorageError::from)?;

        let jobs = stmt
            .query_map(params![now_ms], |row| row_to_job(row))
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
