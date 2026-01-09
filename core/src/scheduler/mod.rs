//! Job scheduler for Reseolio
//!
//! Manages the scheduling loop and crash recovery.

use crate::error::Result;
use crate::storage::Storage;
use std::sync::Arc;
use tokio::sync::Notify;
use tokio::time::{interval, Duration};
use tracing::{debug, error, info, warn};

/// The job scheduler polls for pending jobs and dispatches them to workers
pub struct Scheduler<S: Storage> {
    storage: S,
    poll_interval: Duration,
    shutdown: Arc<Notify>,
}

impl<S: Storage> Scheduler<S> {
    /// Create a new scheduler with the given storage
    pub fn new(storage: S) -> Self {
        Self {
            storage,
            poll_interval: Duration::from_millis(100),
            shutdown: Arc::new(Notify::new()),
        }
    }

    /// Run the scheduler loop
    pub async fn run(&self) {
        info!(
            "Scheduler started with {}ms poll interval",
            self.poll_interval.as_millis()
        );

        let mut ticker = interval(self.poll_interval);

        loop {
            tokio::select! {
                _ = ticker.tick() => {
                    if let Err(e) = self.poll_and_dispatch().await {
                        error!("Scheduler error: {}", e);
                    }
                }
                _ = self.shutdown.notified() => {
                    info!("Scheduler received shutdown signal");
                    break;
                }
            }
        }

        info!("Scheduler stopped");
    }

    /// Poll for pending jobs
    async fn poll_and_dispatch(&self) -> Result<()> {
        let jobs = self.storage.get_pending_jobs(100).await?;

        if !jobs.is_empty() {
            debug!("Found {} pending jobs ready to run", jobs.len());
        }

        Ok(())
    }
}

/// Recover stale jobs from a previous crash
pub async fn recover_stale_jobs<S: Storage>(storage: &S) -> Result<usize> {
    let stale_threshold_secs = 60;

    let stale_jobs = storage.get_stale_running_jobs(stale_threshold_secs).await?;
    let count = stale_jobs.len();

    for job in stale_jobs {
        if job.attempt < job.options.max_attempts {
            storage.reset_stale_job(&job.id).await?;
            info!(
                "Recovered stale job {} ({}) - attempt {}/{}",
                job.id, job.name, job.attempt, job.options.max_attempts
            );
        } else {
            storage
                .mark_job_dead(&job.id, "Server crashed during execution")
                .await?;
            warn!(
                "Marked stale job {} ({}) as dead - exceeded max attempts",
                job.id, job.name
            );
        }
    }

    if count > 0 {
        info!("Crash recovery complete: {} jobs recovered", count);
    }

    Ok(count)
}
