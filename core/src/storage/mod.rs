//! Storage layer for Reseolio
//!
//! This module provides the storage abstraction and SQLite implementation.

mod models;
mod sqlite;

pub use models::*;
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

    /// Update job status after execution
    async fn update_job_result(&self, job_id: &str, result: JobResult) -> Result<InternalJob>;

    /// Mark job as dead (exceeded max attempts)
    async fn mark_job_dead(&self, job_id: &str, error: &str) -> Result<InternalJob>;

    /// Cancel a pending job
    async fn cancel_job(&self, job_id: &str) -> Result<bool>;

    /// Get stale running jobs (for crash recovery)
    async fn get_stale_running_jobs(&self, stale_threshold_secs: i64) -> Result<Vec<InternalJob>>;

    /// Reset stale jobs to pending
    async fn reset_stale_job(&self, job_id: &str) -> Result<()>;

    /// List jobs with filters
    async fn list_jobs(&self, filter: JobFilter) -> Result<(Vec<InternalJob>, i32)>;
}
