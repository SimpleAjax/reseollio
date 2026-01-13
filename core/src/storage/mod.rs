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

    /// Get a job by idempotency key
    async fn get_job_by_idempotency_key(&self, key: &str) -> Result<Option<InternalJob>>;

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
    async fn update_job_results(&self, updates: Vec<(String, JobResult)>) -> Result<()>;

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
        (capped + jitter).max(0) / 1000 // Convert to seconds
    } else {
        capped / 1000
    }
}
