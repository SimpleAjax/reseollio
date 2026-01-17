//! Storage layer for Reseolio
//!
//! This module provides the storage abstraction and SQLite implementation.

mod models;
#[cfg(feature = "postgres")]
mod postgres;
mod sqlite;

pub use models::*;
#[cfg(feature = "postgres")]
pub use postgres::PostgresStorage;
pub use sqlite::SqliteStorage;

use crate::error::Result;
use async_trait::async_trait;

/// Storage trait for job persistence
#[async_trait]
pub trait Storage: Clone + Send + Sync + 'static {
    /// Run database migrations
    async fn migrate(&self) -> Result<()>;

    /// Insert a new job
    async fn insert_job(&self, job: NewJob) -> Result<InternalJob>;

    /// Get a job by ID
    async fn get_job(&self, job_id: &str) -> Result<Option<InternalJob>>;

    /// Get a job by function name and idempotency key
    /// Idempotency keys are scoped per function to prevent collisions
    async fn get_job_by_idempotency_key(
        &self,
        name: &str,
        key: &str,
    ) -> Result<Option<InternalJob>>;

    /// Get pending jobs ready to run (scheduled_at <= now)
    async fn get_pending_jobs(&self, limit: usize) -> Result<Vec<InternalJob>>;

    /// Claim a job for processing (atomic: PENDING -> RUNNING)
    async fn claim_job(&self, job_id: &str, worker_id: &str) -> Result<bool>;

    /// Batch claim jobs (atomic per job, single transaction)
    /// Returns list of job IDs that were successfully claimed
    async fn claim_jobs(&self, claims: Vec<(String, String)>) -> Result<Vec<String>>;

    /// Claim and fetch jobs directly for a worker (pull-based mode)
    /// Uses FOR UPDATE SKIP LOCKED for efficient concurrent claiming
    /// Returns the actual job data (not just IDs) for immediate processing
    async fn claim_and_fetch_jobs(
        &self,
        worker_id: &str,
        job_names: &[String],
        limit: usize,
    ) -> Result<Vec<InternalJob>>;

    /// Update job status after execution
    async fn update_job_result(&self, job_id: &str, result: JobResult) -> Result<InternalJob>;

    /// Batch update job results (atomic transaction)
    /// Returns Vec of (job_id, final_status) - the actual status after processing
    /// This is needed because should_retry may still result in DEAD if max_attempts reached
    async fn update_job_results(
        &self,
        updates: Vec<(String, JobResult)>,
    ) -> Result<Vec<(String, JobStatus)>>;

    /// Mark job as dead (exceeded max attempts)
    async fn mark_job_dead(&self, job_id: &str, error: &str) -> Result<InternalJob>;

    /// Cancel a pending job
    async fn cancel_job(&self, job_id: &str) -> Result<bool>;

    /// Get stale running jobs (for crash recovery)
    /// Note: stale_threshold_secs is deprecated - jobs now use their individual timeout_ms value
    async fn get_stale_running_jobs(&self, _stale_threshold_secs: i64) -> Result<Vec<InternalJob>>;

    /// Reset stale jobs to pending
    async fn reset_stale_job(&self, job_id: &str) -> Result<()>;

    /// List jobs with filters
    async fn list_jobs(&self, filter: JobFilter) -> Result<(Vec<InternalJob>, i32)>;

    /// Retry a dead/failed job (resets status to PENDING and attempt to 0)
    async fn retry_job(&self, job_id: &str) -> Result<bool>;

    // === Schedule Methods for Cron Scheduling ===

    /// Create a new schedule
    async fn create_schedule(&self, schedule: NewSchedule) -> Result<Schedule>;

    /// Get a schedule by ID
    async fn get_schedule(&self, schedule_id: &str) -> Result<Option<Schedule>>;

    /// Get a schedule by name (unique)
    async fn get_schedule_by_name(&self, name: &str) -> Result<Option<Schedule>>;

    /// List schedules with filters
    async fn list_schedules(&self, filter: ScheduleFilter) -> Result<(Vec<Schedule>, i32)>;

    /// Update a schedule's cron expression, timezone, or options
    async fn update_schedule(
        &self,
        schedule_id: &str,
        cron_expression: Option<&str>,
        timezone: Option<&str>,
        handler_options: Option<&JobOptions>,
    ) -> Result<Option<Schedule>>;

    /// Pause a schedule
    async fn pause_schedule(&self, schedule_id: &str) -> Result<bool>;

    /// Resume a paused schedule
    async fn resume_schedule(&self, schedule_id: &str) -> Result<bool>;

    /// Delete a schedule (soft delete - marks as deleted)
    async fn delete_schedule(&self, schedule_id: &str) -> Result<bool>;

    /// Get schedules that are due to run (active and next_run_at <= now)
    async fn get_due_schedules(&self) -> Result<Vec<Schedule>>;

    /// Update schedule's next_run_at and last_run_at after triggering
    async fn update_schedule_after_trigger(
        &self,
        schedule_id: &str,
        next_run_at: chrono::DateTime<chrono::Utc>,
    ) -> Result<()>;

    /// Insert a scheduled job with schedule reference (uses idempotency)
    async fn insert_scheduled_job(
        &self,
        job: NewJob,
        schedule_id: &str,
        schedule_run_id: &str,
    ) -> Result<(InternalJob, bool)>; // Returns (job, was_deduplicated)
}

/// Convert unix timestamp to DateTime<Utc>
pub fn timestamp_to_datetime(ts: i64) -> chrono::DateTime<chrono::Utc> {
    use chrono::TimeZone;
    chrono::Utc.timestamp_opt(ts, 0).unwrap()
}

/// Calculate backoff delay in seconds based on strategy
pub fn calculate_backoff(options: &JobOptions, attempt: i32) -> i32 {
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
        // Use ceiling division to round up (ensures sub-second delays become at least 1 second)
        ((capped + jitter).max(0) + 999) / 1000
    } else {
        // Use ceiling division: (n + 999) / 1000 rounds up to nearest second
        // This prevents delays like 200ms from being truncated to 0 seconds
        (capped + 999) / 1000
    }
}

/// Calculate the next execution time for a cron expression
///
/// Uses the cron crate to parse the expression and find the next occurrence.
/// Supports timezone-aware scheduling via chrono-tz.
///
/// # Arguments
/// * `cron_expr` - A valid cron expression (5 or 6 fields)
/// * `timezone` - IANA timezone name (e.g., "America/New_York", "UTC")
/// * `after` - Calculate next run after this time
///
/// # Returns
/// * `Ok(DateTime<Utc>)` - The next execution time in UTC
/// * `Err(_)` - If the cron expression is invalid or no next time can be found
pub fn next_cron_time(
    cron_expr: &str,
    timezone: &str,
    after: chrono::DateTime<chrono::Utc>,
) -> Result<chrono::DateTime<chrono::Utc>> {
    use cron::Schedule;
    use std::str::FromStr;

    // Parse the cron expression
    // The cron crate expects 6-7 fields, so we may need to prepend seconds
    // Standard 5-field: minute hour day-of-month month day-of-week
    // Cron crate 6-field: second minute hour day-of-month month day-of-week
    let expr_parts: Vec<&str> = cron_expr.split_whitespace().collect();
    let full_expr = if expr_parts.len() == 5 {
        // Add "0" seconds to make it 6-field
        format!("0 {}", cron_expr)
    } else {
        cron_expr.to_string()
    };

    let schedule = Schedule::from_str(&full_expr)
        .map_err(|e| crate::error::ReseolioError::InvalidCronExpression(e.to_string()))?;

    // Parse timezone
    let tz: chrono_tz::Tz = timezone.parse().unwrap_or(chrono_tz::Tz::UTC);

    // Convert 'after' to the target timezone
    let after_in_tz = after.with_timezone(&tz);

    // Find the next occurrence
    let next = schedule.after(&after_in_tz).next().ok_or_else(|| {
        crate::error::ReseolioError::InvalidCronExpression("No next occurrence found".to_string())
    })?;

    // Convert back to UTC
    Ok(next.with_timezone(&chrono::Utc))
}
