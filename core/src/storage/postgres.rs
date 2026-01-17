//! PostgreSQL storage implementation

use super::{
    calculate_backoff, next_cron_time, timestamp_to_datetime, InternalJob, JobFilter, JobOptions,
    JobResult, JobStatus, NewJob, NewSchedule, Schedule, ScheduleFilter, ScheduleStatus, Storage,
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
                idempotency_key TEXT,
                UNIQUE(name, idempotency_key)
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
            CREATE INDEX IF NOT EXISTS idx_jobs_name_idempotency 
                ON jobs(name, idempotency_key) WHERE idempotency_key IS NOT NULL
            "#,
        )
        .execute(&self.pool)
        .await
        .map_err(StorageError::from)?;

        // Partial index for PENDING jobs only
        // This index is very small (only pending jobs) and speeds up get_pending_jobs()
        // As jobs complete, they leave this index, keeping it compact
        sqlx::query(
            r#"
            CREATE INDEX IF NOT EXISTS idx_jobs_pending 
                ON jobs(scheduled_at) WHERE status = 'PENDING'
            "#,
        )
        .execute(&self.pool)
        .await
        .map_err(StorageError::from)?;

        // Partial index for RUNNING jobs
        // Used for stale job recovery - finding jobs that have been running too long
        sqlx::query(
            r#"
            CREATE INDEX IF NOT EXISTS idx_jobs_running 
                ON jobs(worker_id, started_at) WHERE status = 'RUNNING'
            "#,
        )
        .execute(&self.pool)
        .await
        .map_err(StorageError::from)?;

        // Add schedule reference columns if they don't exist (migration)
        sqlx::query(
            r#"
            DO $$ 
            BEGIN 
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                               WHERE table_name = 'jobs' AND column_name = 'schedule_id') THEN
                    ALTER TABLE jobs ADD COLUMN schedule_id TEXT;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                               WHERE table_name = 'jobs' AND column_name = 'schedule_run_id') THEN
                    ALTER TABLE jobs ADD COLUMN schedule_run_id TEXT;
                END IF;
            END $$;
            "#,
        )
        .execute(&self.pool)
        .await
        .map_err(StorageError::from)?;

        // Index for schedule-related jobs
        sqlx::query(
            r#"
            CREATE INDEX IF NOT EXISTS idx_jobs_schedule 
                ON jobs(schedule_id) WHERE schedule_id IS NOT NULL
            "#,
        )
        .execute(&self.pool)
        .await
        .map_err(StorageError::from)?;

        // Create schedules table
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS schedules (
                id              TEXT PRIMARY KEY,
                name            TEXT NOT NULL UNIQUE,
                cron_expression TEXT NOT NULL,
                timezone        TEXT NOT NULL DEFAULT 'UTC',
                handler_options TEXT NOT NULL,
                status          TEXT NOT NULL DEFAULT 'active',
                next_run_at     BIGINT NOT NULL,
                last_run_at     BIGINT,
                created_at      BIGINT NOT NULL,
                updated_at      BIGINT NOT NULL
            )
            "#,
        )
        .execute(&self.pool)
        .await
        .map_err(StorageError::from)?;

        // Index for efficient due schedule queries
        sqlx::query(
            r#"
            CREATE INDEX IF NOT EXISTS idx_schedules_next_run 
                ON schedules(status, next_run_at)
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

        // Use INSERT ON CONFLICT DO NOTHING to handle race conditions with idempotency keys.
        // If concurrent requests try to insert the same (name, idempotency_key), only one succeeds.
        let result = sqlx::query(
            r#"
            INSERT INTO jobs (id, name, args, options, status, attempt, 
                              created_at, scheduled_at, idempotency_key)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (name, idempotency_key) DO NOTHING
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

        // If no rows were affected, the job already exists (lost the race)
        // Return the existing job instead
        if result.rows_affected() == 0 {
            if let Some(ref key) = job.idempotency_key {
                // Fetch and return the existing job
                if let Some(existing) = self.get_job_by_idempotency_key(&job.name, key).await? {
                    debug!(
                        "Job with idempotency key {} already exists, returning existing: {}",
                        key, existing.id
                    );
                    return Ok(existing);
                }
            }
            // This shouldn't happen - conflict was triggered but job not found
            // Fall through to return the original job structure
        }

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

    async fn get_job_by_idempotency_key(
        &self,
        name: &str,
        key: &str,
    ) -> Result<Option<InternalJob>> {
        let row = sqlx::query(
            r#"
            SELECT id, name, args, options, status, attempt, 
                   created_at, scheduled_at, started_at, completed_at,
                   error, result, worker_id, idempotency_key
            FROM jobs WHERE name = $1 AND idempotency_key = $2
            "#,
        )
        .bind(name)
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
        use std::time::Instant;

        if claims.is_empty() {
            return Ok(Vec::new());
        }

        let claim_start = Instant::now();
        let now = Utc::now().timestamp();
        let n = claims.len();

        // Separate job_ids and worker_ids into two arrays
        let mut job_ids: Vec<String> = Vec::with_capacity(n);
        let mut worker_ids: Vec<String> = Vec::with_capacity(n);

        for (job_id, worker_id) in claims {
            job_ids.push(job_id);
            worker_ids.push(worker_id);
        }

        // Use UNNEST with two arrays instead of dynamic VALUES clause
        // This is a fixed query that PostgreSQL can cache/prepare
        let rows = sqlx::query(
            r#"
            UPDATE jobs 
            SET status = 'RUNNING', 
                worker_id = v.worker_id, 
                started_at = $1,
                attempt = attempt + 1
            FROM UNNEST($2::TEXT[], $3::TEXT[]) AS v(job_id, worker_id)
            WHERE jobs.id = v.job_id AND jobs.status = 'PENDING'
            RETURNING jobs.id
            "#,
        )
        .bind(now)
        .bind(&job_ids)
        .bind(&worker_ids)
        .fetch_all(&self.pool)
        .await
        .map_err(StorageError::from)?;

        let claimed: Vec<String> = rows.iter().map(|r| r.get::<String, _>("id")).collect();

        let claim_time = claim_start.elapsed();
        info!(
            "[TIMING] claim_jobs: count={} claimed={} time={}ms",
            n,
            claimed.len(),
            claim_time.as_millis()
        );

        Ok(claimed)
    }

    async fn claim_and_fetch_jobs(
        &self,
        worker_id: &str,
        job_names: &[String],
        limit: usize,
    ) -> Result<Vec<InternalJob>> {
        let now = Utc::now().timestamp();

        // Use CTE with FOR UPDATE SKIP LOCKED for efficient concurrent claiming
        // This is the gold standard for PostgreSQL job queues
        let rows = if job_names.is_empty() {
            // Claim any pending job
            sqlx::query(
                r#"
                WITH claimable AS (
                    SELECT id FROM jobs
                    WHERE status = 'PENDING' AND scheduled_at <= $1
                    ORDER BY scheduled_at
                    LIMIT $2
                    FOR UPDATE SKIP LOCKED
                )
                UPDATE jobs
                SET status = 'RUNNING',
                    worker_id = $3,
                    started_at = $1,
                    attempt = attempt + 1
                WHERE id IN (SELECT id FROM claimable)
                RETURNING id, name, args, options, status, attempt,
                          created_at, scheduled_at, started_at, completed_at,
                          error, result, worker_id, idempotency_key
                "#,
            )
            .bind(now)
            .bind(limit as i64)
            .bind(worker_id)
            .fetch_all(&self.pool)
            .await
            .map_err(StorageError::from)?
        } else {
            // Claim jobs matching specific names
            sqlx::query(
                r#"
                WITH claimable AS (
                    SELECT id FROM jobs
                    WHERE status = 'PENDING' 
                      AND scheduled_at <= $1 
                      AND name = ANY($4)
                    ORDER BY scheduled_at
                    LIMIT $2
                    FOR UPDATE SKIP LOCKED
                )
                UPDATE jobs
                SET status = 'RUNNING',
                    worker_id = $3,
                    started_at = $1,
                    attempt = attempt + 1
                WHERE id IN (SELECT id FROM claimable)
                RETURNING id, name, args, options, status, attempt,
                          created_at, scheduled_at, started_at, completed_at,
                          error, result, worker_id, idempotency_key
                "#,
            )
            .bind(now)
            .bind(limit as i64)
            .bind(worker_id)
            .bind(job_names)
            .fetch_all(&self.pool)
            .await
            .map_err(StorageError::from)?
        };

        let mut jobs = Vec::with_capacity(rows.len());
        for row in rows {
            jobs.push(row_to_job(&row)?);
        }

        debug!("Worker {} claimed {} jobs via pull", worker_id, jobs.len());

        Ok(jobs)
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

    async fn update_job_results(
        &self,
        updates: Vec<(String, JobResult)>,
    ) -> Result<Vec<(String, JobStatus)>> {
        use std::time::Instant;

        if updates.is_empty() {
            return Ok(Vec::new());
        }

        let total_start = Instant::now();
        let now = Utc::now().timestamp();

        // Track final statuses for notification purposes
        let mut final_statuses: Vec<(String, JobStatus)> = Vec::with_capacity(updates.len());

        // Separate SUCCESS results (can be batched) from FAILED results (need individual handling)
        let mut success_ids: Vec<String> = Vec::new();
        let mut success_results: Vec<Option<Vec<u8>>> = Vec::new();
        let mut failed_updates: Vec<(String, String, bool)> = Vec::new(); // (job_id, error, should_retry)

        for (job_id, result) in updates {
            match result {
                JobResult::Success { return_value } => {
                    final_statuses.push((job_id.clone(), JobStatus::Success));
                    success_ids.push(job_id);
                    success_results.push(return_value);
                }
                JobResult::Failed {
                    error,
                    should_retry,
                } => {
                    // We'll update the status after checking attempt count below
                    failed_updates.push((job_id, error, should_retry));
                }
            }
        }

        let success_count = success_ids.len();
        let failed_count = failed_updates.len();

        // Batch update all SUCCESS jobs in a single query using UPDATE FROM VALUES
        let success_time = if !success_ids.is_empty() {
            let n = success_ids.len();
            let success_start = Instant::now();

            // Build VALUES clause: ($1, $2), ($3, $4), ...
            let mut values_parts = Vec::with_capacity(n);
            for i in 0..n {
                let id_param = i * 2 + 1;
                let result_param = i * 2 + 2;
                values_parts.push(format!("(${}::TEXT, ${}::BYTEA)", id_param, result_param));
            }

            let query_str = format!(
                r#"
                UPDATE jobs 
                SET status = 'SUCCESS', 
                    completed_at = {},
                    result = v.result_value,
                    error = NULL
                FROM (VALUES {}) AS v(job_id, result_value)
                WHERE jobs.id = v.job_id
                "#,
                now,
                values_parts.join(", ")
            );

            let mut query = sqlx::query(&query_str);
            for i in 0..n {
                query = query.bind(&success_ids[i]);
                query = query.bind(&success_results[i]);
            }

            query
                .execute(&self.pool)
                .await
                .map_err(StorageError::from)?;

            success_start.elapsed()
        } else {
            std::time::Duration::ZERO
        };

        // Handle FAILED jobs individually (need backoff calculation per job)
        let failed_time = if !failed_updates.is_empty() {
            let failed_start = Instant::now();
            let mut tx = self.pool.begin().await.map_err(StorageError::from)?;

            for (job_id, error, should_retry) in failed_updates {
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
                        // Job will be retried - status is PENDING
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

                        final_statuses.push((job_id, JobStatus::Pending));
                    } else {
                        // Job is DEAD (no more retries)
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

                        final_statuses.push((job_id, JobStatus::Dead));
                    }
                }
            }

            tx.commit().await.map_err(StorageError::from)?;
            failed_start.elapsed()
        } else {
            std::time::Duration::ZERO
        };

        let total_time = total_start.elapsed();

        info!(
            "[TIMING] update_job_results: total={}ms | success_count={} success_time={}ms | failed_count={} failed_time={}ms",
            total_time.as_millis(),
            success_count,
            success_time.as_millis(),
            failed_count,
            failed_time.as_millis()
        );

        Ok(final_statuses)
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

    async fn get_stale_running_jobs(&self, _stale_threshold_secs: i64) -> Result<Vec<InternalJob>> {
        let now_ms = Utc::now().timestamp_millis();

        // Find jobs where (NOW - started_at) > timeout_ms from job options
        // This uses per-job timeout instead of global threshold
        let rows = sqlx::query(
            r#"
            SELECT id, name, args, options, status, attempt, 
                   created_at, scheduled_at, started_at, completed_at,
                   error, result, worker_id, idempotency_key
            FROM jobs 
            WHERE status = 'RUNNING' 
              AND started_at IS NOT NULL
              AND ($1 - started_at * 1000) > COALESCE(
                  (options::json->>'timeout_ms')::integer,
                  30000
              )
            "#,
        )
        .bind(now_ms)
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

    async fn retry_job(&self, job_id: &str) -> Result<bool> {
        let now = Utc::now().timestamp();

        // Only allow retrying DEAD or FAILED jobs
        let result = sqlx::query(
            r#"
            UPDATE jobs 
            SET status = 'PENDING', 
                attempt = 0,
                scheduled_at = $2,
                started_at = NULL,
                completed_at = NULL,
                error = NULL,
                worker_id = NULL
            WHERE id = $1 AND status IN ('DEAD', 'FAILED')
            "#,
        )
        .bind(job_id)
        .bind(now)
        .execute(&self.pool)
        .await
        .map_err(StorageError::from)?;

        Ok(result.rows_affected() > 0)
    }

    // === Schedule Method Implementations ===

    async fn create_schedule(&self, new_schedule: NewSchedule) -> Result<Schedule> {
        // Calculate the first next_run_at
        let next_run = next_cron_time(
            &new_schedule.cron_expression,
            new_schedule.timezone.as_deref().unwrap_or("UTC"),
            Utc::now(),
        )?;

        let schedule = new_schedule.into_schedule(next_run);
        let options_json = serde_json::to_string(&schedule.handler_options)?;

        sqlx::query(
            r#"
            INSERT INTO schedules (id, name, cron_expression, timezone, handler_options, 
                                   status, next_run_at, last_run_at, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            "#,
        )
        .bind(&schedule.id)
        .bind(&schedule.name)
        .bind(&schedule.cron_expression)
        .bind(&schedule.timezone)
        .bind(&options_json)
        .bind(schedule.status.as_str())
        .bind(schedule.next_run_at.timestamp())
        .bind(schedule.last_run_at.map(|t| t.timestamp()))
        .bind(schedule.created_at.timestamp())
        .bind(schedule.updated_at.timestamp())
        .execute(&self.pool)
        .await
        .map_err(StorageError::from)?;

        debug!("Created schedule: {} ({})", schedule.id, schedule.name);
        Ok(schedule)
    }

    async fn get_schedule(&self, schedule_id: &str) -> Result<Option<Schedule>> {
        let row = sqlx::query(
            r#"
            SELECT id, name, cron_expression, timezone, handler_options, 
                   status, next_run_at, last_run_at, created_at, updated_at
            FROM schedules WHERE id = $1
            "#,
        )
        .bind(schedule_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(StorageError::from)?;

        match row {
            Some(row) => Ok(Some(row_to_schedule(&row)?)),
            None => Ok(None),
        }
    }

    async fn get_schedule_by_name(&self, name: &str) -> Result<Option<Schedule>> {
        let row = sqlx::query(
            r#"
            SELECT id, name, cron_expression, timezone, handler_options, 
                   status, next_run_at, last_run_at, created_at, updated_at
            FROM schedules WHERE name = $1
            "#,
        )
        .bind(name)
        .fetch_optional(&self.pool)
        .await
        .map_err(StorageError::from)?;

        match row {
            Some(row) => Ok(Some(row_to_schedule(&row)?)),
            None => Ok(None),
        }
    }

    async fn list_schedules(&self, filter: ScheduleFilter) -> Result<(Vec<Schedule>, i32)> {
        let mut builder = sqlx::QueryBuilder::new(
            "SELECT id, name, cron_expression, timezone, handler_options, \
             status, next_run_at, last_run_at, created_at, updated_at \
             FROM schedules WHERE 1=1",
        );

        // Don't show deleted schedules by default
        if let Some(status) = &filter.status {
            builder.push(" AND status = ");
            builder.push_bind(status.as_str().to_string());
        } else {
            builder.push(" AND status != 'deleted'");
        }

        builder.push(" ORDER BY next_run_at ASC");

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

        let mut schedules = Vec::new();
        for row in rows {
            schedules.push(row_to_schedule(&row)?);
        }

        // Count
        let total: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM schedules WHERE status != 'deleted'")
                .fetch_one(&self.pool)
                .await
                .map_err(StorageError::from)?;

        Ok((schedules, total as i32))
    }

    async fn update_schedule(
        &self,
        schedule_id: &str,
        cron_expression: Option<&str>,
        timezone: Option<&str>,
        handler_options: Option<&JobOptions>,
    ) -> Result<Option<Schedule>> {
        let now = Utc::now().timestamp();

        // Get current schedule first
        let current = match self.get_schedule(schedule_id).await? {
            Some(s) if s.status != ScheduleStatus::Deleted => s,
            _ => return Ok(None),
        };

        // Determine final values
        let final_cron = cron_expression.unwrap_or(&current.cron_expression);
        let final_tz = timezone.unwrap_or(&current.timezone);
        let final_opts = handler_options
            .cloned()
            .unwrap_or(current.handler_options.clone());

        // Recalculate next_run if cron or timezone changed
        let new_next_run = if cron_expression.is_some() || timezone.is_some() {
            next_cron_time(final_cron, final_tz, Utc::now())?
        } else {
            current.next_run_at
        };

        let opts_json = serde_json::to_string(&final_opts)?;

        sqlx::query(
            r#"
            UPDATE schedules 
            SET cron_expression = $1, timezone = $2, handler_options = $3,
                next_run_at = $4, updated_at = $5
            WHERE id = $6 AND status != 'deleted'
            "#,
        )
        .bind(final_cron)
        .bind(final_tz)
        .bind(&opts_json)
        .bind(new_next_run.timestamp())
        .bind(now)
        .bind(schedule_id)
        .execute(&self.pool)
        .await
        .map_err(StorageError::from)?;

        self.get_schedule(schedule_id).await
    }

    async fn pause_schedule(&self, schedule_id: &str) -> Result<bool> {
        let now = Utc::now().timestamp();

        let result = sqlx::query(
            r#"
            UPDATE schedules 
            SET status = 'paused', updated_at = $2
            WHERE id = $1 AND status = 'active'
            "#,
        )
        .bind(schedule_id)
        .bind(now)
        .execute(&self.pool)
        .await
        .map_err(StorageError::from)?;

        Ok(result.rows_affected() > 0)
    }

    async fn resume_schedule(&self, schedule_id: &str) -> Result<bool> {
        // Get the schedule to recalculate next_run_at
        let schedule = match self.get_schedule(schedule_id).await? {
            Some(s) if s.status == ScheduleStatus::Paused => s,
            _ => return Ok(false),
        };

        let next_run = next_cron_time(&schedule.cron_expression, &schedule.timezone, Utc::now())?;
        let now = Utc::now().timestamp();

        let result = sqlx::query(
            r#"
            UPDATE schedules 
            SET status = 'active', next_run_at = $2, updated_at = $3
            WHERE id = $1
            "#,
        )
        .bind(schedule_id)
        .bind(next_run.timestamp())
        .bind(now)
        .execute(&self.pool)
        .await
        .map_err(StorageError::from)?;

        Ok(result.rows_affected() > 0)
    }

    async fn delete_schedule(&self, schedule_id: &str) -> Result<bool> {
        let now = Utc::now().timestamp();

        let result = sqlx::query(
            r#"
            UPDATE schedules 
            SET status = 'deleted', updated_at = $2
            WHERE id = $1 AND status != 'deleted'
            "#,
        )
        .bind(schedule_id)
        .bind(now)
        .execute(&self.pool)
        .await
        .map_err(StorageError::from)?;

        Ok(result.rows_affected() > 0)
    }

    async fn get_due_schedules(&self) -> Result<Vec<Schedule>> {
        let now = Utc::now().timestamp();

        let rows = sqlx::query(
            r#"
            SELECT id, name, cron_expression, timezone, handler_options, 
                   status, next_run_at, last_run_at, created_at, updated_at
            FROM schedules 
            WHERE status = 'active' AND next_run_at <= $1
            "#,
        )
        .bind(now)
        .fetch_all(&self.pool)
        .await
        .map_err(StorageError::from)?;

        let mut schedules = Vec::new();
        for row in rows {
            schedules.push(row_to_schedule(&row)?);
        }

        Ok(schedules)
    }

    async fn update_schedule_after_trigger(
        &self,
        schedule_id: &str,
        next_run_at: chrono::DateTime<chrono::Utc>,
    ) -> Result<()> {
        let now = Utc::now().timestamp();

        sqlx::query(
            r#"
            UPDATE schedules 
            SET next_run_at = $2, last_run_at = $3, updated_at = $3
            WHERE id = $1
            "#,
        )
        .bind(schedule_id)
        .bind(next_run_at.timestamp())
        .bind(now)
        .execute(&self.pool)
        .await
        .map_err(StorageError::from)?;

        Ok(())
    }

    async fn insert_scheduled_job(
        &self,
        new_job: NewJob,
        schedule_id: &str,
        schedule_run_id: &str,
    ) -> Result<(InternalJob, bool)> {
        let job = new_job.into_job();
        let options_json = serde_json::to_string(&job.options)?;

        // Use INSERT ON CONFLICT DO NOTHING for idempotency
        let result = sqlx::query(
            r#"
            INSERT INTO jobs (id, name, args, options, status, attempt, 
                              created_at, scheduled_at, idempotency_key,
                              schedule_id, schedule_run_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            ON CONFLICT (name, idempotency_key) DO NOTHING
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
        .bind(schedule_run_id) // Use schedule_run_id as idempotency key
        .bind(schedule_id)
        .bind(schedule_run_id)
        .execute(&self.pool)
        .await
        .map_err(StorageError::from)?;

        let was_deduplicated = result.rows_affected() == 0;

        if was_deduplicated {
            // Job already existed, fetch it
            if let Some(existing) = self
                .get_job_by_idempotency_key(&job.name, schedule_run_id)
                .await?
            {
                return Ok((existing, true));
            }
        }

        debug!(
            "Inserted scheduled job: {} ({}) for schedule {}",
            job.id, job.name, schedule_id
        );
        Ok((job, was_deduplicated))
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

fn row_to_schedule(row: &sqlx::postgres::PgRow) -> Result<Schedule> {
    let options_str: String = row.get("handler_options");
    let handler_options: JobOptions = serde_json::from_str(&options_str)?;

    let status_str: String = row.get("status");
    let status = ScheduleStatus::from_str(&status_str).unwrap_or(ScheduleStatus::Active);

    Ok(Schedule {
        id: row.get("id"),
        name: row.get("name"),
        cron_expression: row.get("cron_expression"),
        timezone: row.get("timezone"),
        handler_options,
        status,
        next_run_at: timestamp_to_datetime(row.get("next_run_at")),
        last_run_at: row
            .get::<Option<i64>, _>("last_run_at")
            .map(timestamp_to_datetime),
        created_at: timestamp_to_datetime(row.get("created_at")),
        updated_at: timestamp_to_datetime(row.get("updated_at")),
    })
}
