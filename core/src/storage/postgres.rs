//! PostgreSQL storage implementation

use super::{
    calculate_backoff, timestamp_to_datetime, InternalJob, JobFilter, JobOptions, JobResult,
    JobStatus, NewJob, Storage,
};
use crate::error::{ReseolioError, Result, StorageError};
use async_trait::async_trait;
use chrono::Utc;
use sqlx::{postgres::PgPoolOptions, PgPool, Row};

use tracing::{debug, info};

/// PostgreSQL-based storage implementation
#[derive(Clone)]
pub struct PostgresStorage {
    pool: PgPool,
}

impl PostgresStorage {
    /// Create a new PostgreSQL storage with the given connection string
    pub async fn new(connection_string: &str) -> Result<Self> {
        let pool = PgPoolOptions::new()
            .max_connections(50)
            .connect(connection_string)
            .await
            .map_err(StorageError::from)?;

        Ok(Self { pool })
    }
}

#[async_trait]
impl Storage for PostgresStorage {
    async fn migrate(&self) -> Result<()> {
        // Create the jobs table
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS jobs (
                id              TEXT PRIMARY KEY,
                name            TEXT NOT NULL,
                args            BYTEA NOT NULL,
                options         TEXT NOT NULL,
                status          TEXT NOT NULL,
                attempt         INTEGER NOT NULL DEFAULT 0,
                created_at      BIGINT NOT NULL,
                scheduled_at    BIGINT NOT NULL,
                started_at      BIGINT,
                completed_at    BIGINT,
                error           TEXT,
                result          BYTEA,
                worker_id       TEXT,
                idempotency_key TEXT UNIQUE
            )
            "#,
        )
        .execute(&self.pool)
        .await
        .map_err(StorageError::from)?;

        // Create indexes
        sqlx::query(
            r#"
            CREATE INDEX IF NOT EXISTS idx_jobs_status_scheduled 
                ON jobs(status, scheduled_at)
            "#,
        )
        .execute(&self.pool)
        .await
        .map_err(StorageError::from)?;

        sqlx::query(
            r#"
            CREATE INDEX IF NOT EXISTS idx_jobs_name 
                ON jobs(name)
            "#,
        )
        .execute(&self.pool)
        .await
        .map_err(StorageError::from)?;

        sqlx::query(
            r#"
            CREATE INDEX IF NOT EXISTS idx_jobs_idempotency 
                ON jobs(idempotency_key) WHERE idempotency_key IS NOT NULL
            "#,
        )
        .execute(&self.pool)
        .await
        .map_err(StorageError::from)?;

        info!("PostgreSQL migrations applied successfully");
        Ok(())
    }

    async fn insert_job(&self, new_job: NewJob) -> Result<InternalJob> {
        let job = new_job.into_job();
        let options_json = serde_json::to_string(&job.options)?;

        sqlx::query(
            r#"
            INSERT INTO jobs (id, name, args, options, status, attempt, 
                              created_at, scheduled_at, idempotency_key)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            "#,
        )
        .bind(&job.id)
        .bind(&job.name)
        .bind(&job.args)
        .bind(&options_json)
        .bind(job.status.as_str())
        .bind(job.attempt)
        .bind(job.created_at.timestamp())
        .bind(job.scheduled_at.timestamp())
        .bind(&job.idempotency_key)
        .execute(&self.pool)
        .await
        .map_err(StorageError::from)?;

        debug!("Inserted job: {} ({})", job.id, job.name);
        Ok(job)
    }

    async fn get_job(&self, job_id: &str) -> Result<Option<InternalJob>> {
        let row = sqlx::query(
            r#"
            SELECT id, name, args, options, status, attempt, 
                   created_at, scheduled_at, started_at, completed_at,
                   error, result, worker_id, idempotency_key
            FROM jobs WHERE id = $1
            "#,
        )
        .bind(job_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(StorageError::from)?;

        match row {
            Some(row) => Ok(Some(row_to_job(&row)?)),
            None => Ok(None),
        }
    }

    async fn get_job_by_idempotency_key(&self, key: &str) -> Result<Option<InternalJob>> {
        let row = sqlx::query(
            r#"
            SELECT id, name, args, options, status, attempt, 
                   created_at, scheduled_at, started_at, completed_at,
                   error, result, worker_id, idempotency_key
            FROM jobs WHERE idempotency_key = $1
            "#,
        )
        .bind(key)
        .fetch_optional(&self.pool)
        .await
        .map_err(StorageError::from)?;

        match row {
            Some(row) => Ok(Some(row_to_job(&row)?)),
            None => Ok(None),
        }
    }

    async fn get_pending_jobs(&self, limit: usize) -> Result<Vec<InternalJob>> {
        let now = Utc::now().timestamp();

        let rows = sqlx::query(
            r#"
            SELECT id, name, args, options, status, attempt, 
                   created_at, scheduled_at, started_at, completed_at,
                   error, result, worker_id, idempotency_key
            FROM jobs 
            WHERE status = 'PENDING' AND scheduled_at <= $1
            ORDER BY scheduled_at ASC
            LIMIT $2
            "#,
        )
        .bind(now)
        .bind(limit as i64)
        .fetch_all(&self.pool)
        .await
        .map_err(StorageError::from)?;

        let mut jobs = Vec::new();
        for row in rows {
            jobs.push(row_to_job(&row)?);
        }
        Ok(jobs)
    }

    async fn claim_job(&self, job_id: &str, worker_id: &str) -> Result<bool> {
        let now = Utc::now().timestamp();

        let result = sqlx::query(
            r#"
            UPDATE jobs 
            SET status = 'RUNNING', 
                worker_id = $2, 
                started_at = $3,
                attempt = attempt + 1
            WHERE id = $1 AND status = 'PENDING'
            "#,
        )
        .bind(job_id)
        .bind(worker_id)
        .bind(now)
        .execute(&self.pool)
        .await
        .map_err(StorageError::from)?;

        Ok(result.rows_affected() > 0)
    }

    async fn claim_jobs(&self, claims: Vec<(String, String)>) -> Result<Vec<String>> {
        let now = Utc::now().timestamp();
        let mut successfully_claimed = Vec::new();
        let mut tx = self.pool.begin().await.map_err(StorageError::from)?;

        for (job_id, worker_id) in claims {
            let result = sqlx::query(
                r#"
                UPDATE jobs 
                SET status = 'RUNNING', 
                    worker_id = $2, 
                    started_at = $3,
                    attempt = attempt + 1
                WHERE id = $1 AND status = 'PENDING'
                "#,
            )
            .bind(&job_id)
            .bind(&worker_id)
            .bind(now)
            .execute(&mut *tx)
            .await
            .map_err(StorageError::from)?;

            if result.rows_affected() > 0 {
                successfully_claimed.push(job_id);
            }
        }

        tx.commit().await.map_err(StorageError::from)?;
        Ok(successfully_claimed)
    }

    async fn update_job_result(&self, job_id: &str, result: JobResult) -> Result<InternalJob> {
        let now = Utc::now().timestamp();

        match result {
            JobResult::Success { return_value } => {
                sqlx::query(
                    r#"
                    UPDATE jobs 
                    SET status = 'SUCCESS', 
                        completed_at = $2,
                        result = $3,
                        error = NULL
                    WHERE id = $1
                    "#,
                )
                .bind(job_id)
                .bind(now)
                .bind(return_value)
                .execute(&self.pool)
                .await
                .map_err(StorageError::from)?;
            }
            JobResult::Failed {
                error,
                should_retry,
            } => {
                let job_opt = self.get_job(job_id).await?;
                if let Some(job) = job_opt {
                    if should_retry && job.attempt < job.options.max_attempts {
                        let delay = calculate_backoff(&job.options, job.attempt);
                        let next_run = now + delay as i64;

                        sqlx::query(
                            r#"
                            UPDATE jobs 
                            SET status = 'PENDING', 
                                scheduled_at = $2,
                                error = $3,
                                worker_id = NULL,
                                started_at = NULL
                            WHERE id = $1
                            "#,
                        )
                        .bind(job_id)
                        .bind(next_run)
                        .bind(error)
                        .execute(&self.pool)
                        .await
                        .map_err(StorageError::from)?;
                    } else {
                        sqlx::query(
                            r#"
                            UPDATE jobs 
                            SET status = 'DEAD', 
                                completed_at = $2,
                                error = $3
                            WHERE id = $1
                            "#,
                        )
                        .bind(job_id)
                        .bind(now)
                        .bind(error)
                        .execute(&self.pool)
                        .await
                        .map_err(StorageError::from)?;
                    }
                } else {
                    return Err(ReseolioError::JobNotFound(job_id.to_string()));
                }
            }
        }

        self.get_job(job_id)
            .await?
            .ok_or_else(|| ReseolioError::JobNotFound(job_id.to_string()))
    }

    async fn update_job_results(&self, updates: Vec<(String, JobResult)>) -> Result<()> {
        let now = Utc::now().timestamp();
        let mut tx = self.pool.begin().await.map_err(StorageError::from)?;

        for (job_id, result) in updates {
            match result {
                JobResult::Success { return_value } => {
                    sqlx::query(
                        r#"
                        UPDATE jobs 
                        SET status = 'SUCCESS', 
                            completed_at = $2,
                            result = $3,
                            error = NULL
                        WHERE id = $1
                        "#,
                    )
                    .bind(&job_id)
                    .bind(now)
                    .bind(return_value)
                    .execute(&mut *tx)
                    .await
                    .map_err(StorageError::from)?;
                }
                JobResult::Failed {
                    error,
                    should_retry,
                } => {
                    // Fetch job details for backoff calculation
                    let row = sqlx::query("SELECT options, attempt FROM jobs WHERE id = $1")
                        .bind(&job_id)
                        .fetch_optional(&mut *tx)
                        .await
                        .map_err(StorageError::from)?;

                    if let Some(row) = row {
                        let options_str: String = row.get(0);
                        let options: JobOptions =
                            serde_json::from_str(&options_str).unwrap_or_default();
                        let attempt: i32 = row.get(1);

                        if should_retry && attempt < options.max_attempts {
                            let delay = calculate_backoff(&options, attempt);
                            let next_run = now + delay as i64;

                            sqlx::query(
                                r#"
                                UPDATE jobs 
                                SET status = 'PENDING', 
                                    scheduled_at = $2,
                                    error = $3,
                                    worker_id = NULL,
                                    started_at = NULL
                                WHERE id = $1
                                "#,
                            )
                            .bind(&job_id)
                            .bind(next_run)
                            .bind(&error)
                            .execute(&mut *tx)
                            .await
                            .map_err(StorageError::from)?;
                        } else {
                            sqlx::query(
                                r#"
                                UPDATE jobs 
                                SET status = 'DEAD', 
                                    completed_at = $2,
                                    error = $3
                                WHERE id = $1
                                "#,
                            )
                            .bind(&job_id)
                            .bind(now)
                            .bind(&error)
                            .execute(&mut *tx)
                            .await
                            .map_err(StorageError::from)?;
                        }
                    }
                }
            }
        }

        tx.commit().await.map_err(StorageError::from)?;
        Ok(())
    }

    async fn mark_job_dead(&self, job_id: &str, error: &str) -> Result<InternalJob> {
        let now = Utc::now().timestamp();

        sqlx::query(
            r#"
            UPDATE jobs 
            SET status = 'DEAD', 
                completed_at = $2,
                error = $3
            WHERE id = $1
            "#,
        )
        .bind(job_id)
        .bind(now)
        .bind(error)
        .execute(&self.pool)
        .await
        .map_err(StorageError::from)?;

        self.get_job(job_id)
            .await?
            .ok_or_else(|| ReseolioError::JobNotFound(job_id.to_string()))
    }

    async fn cancel_job(&self, job_id: &str) -> Result<bool> {
        let now = Utc::now().timestamp();

        let result = sqlx::query(
            r#"
            UPDATE jobs 
            SET status = 'CANCELLED', 
                completed_at = $2
            WHERE id = $1 AND status = 'PENDING'
            "#,
        )
        .bind(job_id)
        .bind(now)
        .execute(&self.pool)
        .await
        .map_err(StorageError::from)?;

        Ok(result.rows_affected() > 0)
    }

    async fn get_stale_running_jobs(&self, stale_threshold_secs: i64) -> Result<Vec<InternalJob>> {
        let threshold = Utc::now().timestamp() - stale_threshold_secs;

        let rows = sqlx::query(
            r#"
            SELECT id, name, args, options, status, attempt, 
                   created_at, scheduled_at, started_at, completed_at,
                   error, result, worker_id, idempotency_key
            FROM jobs 
            WHERE status = 'RUNNING' AND started_at < $1
            "#,
        )
        .bind(threshold)
        .fetch_all(&self.pool)
        .await
        .map_err(StorageError::from)?;

        let mut jobs = Vec::new();
        for row in rows {
            jobs.push(row_to_job(&row)?);
        }
        Ok(jobs)
    }

    async fn reset_stale_job(&self, job_id: &str) -> Result<()> {
        let now = Utc::now().timestamp();

        sqlx::query(
            r#"
            UPDATE jobs 
            SET status = 'PENDING', 
                scheduled_at = $2,
                worker_id = NULL,
                started_at = NULL
            WHERE id = $1 AND status = 'RUNNING'
            "#,
        )
        .bind(job_id)
        .bind(now)
        .execute(&self.pool)
        .await
        .map_err(StorageError::from)?;

        Ok(())
    }

    async fn list_jobs(&self, filter: JobFilter) -> Result<(Vec<InternalJob>, i32)> {
        // Since dynamic queries with sqlx are a bit tricky, we can use QueryBuilder
        // or just construct the string. For simplicity and robust parameter binding,
        // we might need QueryBuilder.
        // However, manual string construction with care is fine if we can't depend on QueryBuilder easily.
        // But QueryBuilder is safer. 'sqlx' feature 'postgres' + 'macros' doesn't necessarily include QueryBuilder?
        // QueryBuilder IS available in sqlx 0.7.

        let mut builder = sqlx::QueryBuilder::new(
            "SELECT id, name, args, options, status, attempt, \
             created_at, scheduled_at, started_at, completed_at, \
             error, result, worker_id, idempotency_key \
             FROM jobs WHERE 1=1",
        );

        if !filter.statuses.is_empty() {
            builder.push(" AND status = ANY(");
            let statuses: Vec<String> = filter
                .statuses
                .iter()
                .map(|s| s.as_str().to_string())
                .collect();
            builder.push_bind(statuses);
            builder.push(")");
        }

        if !filter.names.is_empty() {
            builder.push(" AND name = ANY(");
            builder.push_bind(&filter.names);
            builder.push(")");
        }

        // Order
        let order_col = match filter.order_by.as_deref() {
            Some("scheduled_at") => "scheduled_at",
            Some("created_at") | _ => "created_at",
        };
        // Sanitize sort direction
        let order_dir = if filter.ascending { "ASC" } else { "DESC" };

        builder.push(format!(" ORDER BY {} {}", order_col, order_dir));

        if let Some(limit) = filter.limit {
            builder.push(" LIMIT ");
            builder.push_bind(limit as i64);
        }

        if let Some(offset) = filter.offset {
            builder.push(" OFFSET ");
            builder.push_bind(offset as i64);
        }

        let rows = builder
            .build()
            .fetch_all(&self.pool)
            .await
            .map_err(StorageError::from)?;

        let mut jobs = Vec::new();
        for row in rows {
            jobs.push(row_to_job(&row)?);
        }

        // Count
        let mut count_builder = sqlx::QueryBuilder::new("SELECT COUNT(*) FROM jobs WHERE 1=1");
        if !filter.statuses.is_empty() {
            count_builder.push(" AND status = ANY(");
            let statuses: Vec<String> = filter
                .statuses
                .iter()
                .map(|s| s.as_str().to_string())
                .collect();
            count_builder.push_bind(statuses);
            count_builder.push(")");
        }
        if !filter.names.is_empty() {
            count_builder.push(" AND name = ANY(");
            count_builder.push_bind(&filter.names);
            count_builder.push(")");
        }

        let total: i64 = count_builder
            .build()
            .fetch_one(&self.pool)
            .await
            .map_err(StorageError::from)?
            .get(0);

        Ok((jobs, total as i32))
    }
}

fn row_to_job(row: &sqlx::postgres::PgRow) -> Result<InternalJob> {
    let options_str: String = row.get("options");
    let options: JobOptions = serde_json::from_str(&options_str)?;

    let status_str: String = row.get("status");
    let status = JobStatus::from_str(&status_str).unwrap_or(JobStatus::Pending);

    Ok(InternalJob {
        id: row.get("id"),
        name: row.get("name"),
        args: row.get("args"),
        options,
        status,
        attempt: row.get("attempt"),
        created_at: timestamp_to_datetime(row.get("created_at")),
        scheduled_at: timestamp_to_datetime(row.get("scheduled_at")),
        started_at: row
            .get::<Option<i64>, _>("started_at")
            .map(timestamp_to_datetime),
        completed_at: row
            .get::<Option<i64>, _>("completed_at")
            .map(timestamp_to_datetime),
        error: row.get("error"),
        result: row.get("result"),
        worker_id: row.get("worker_id"),
        idempotency_key: row.get("idempotency_key"),
    })
}
