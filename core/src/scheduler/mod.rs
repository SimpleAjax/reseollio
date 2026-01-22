//! Push-Based Job Scheduler for Reseolio
//!
//! This scheduler uses a push-based architecture where jobs are assigned
//! directly to workers instead of workers polling for jobs. This eliminates:
//! - Thundering herd problem (all workers racing for jobs)
//! - Wasted DB queries (only scheduler reads pending jobs)
//! - Failed claim attempts (jobs are pre-assigned)
//!
//! ## Architecture
//!
//! ```text
//! ┌─────────────────────────────────────────────────┐
//! │                   SCHEDULER                      │
//! │  ┌─────────────────────────────────────────┐    │
//! │  │  1. Poll DB for pending jobs             │    │
//! │  │  2. Match job to best available worker   │    │
//! │  │  3. Claim job in DB                      │    │
//! │  │  4. Push job to worker's channel         │    │
//! │  └─────────────────────────────────────────┘    │
//! │                     │                            │
//! │         ┌───────────┴───────────┐               │
//! │         ▼                       ▼               │
//! │  ┌──────────────┐        ┌──────────────┐      │
//! │  │   Worker 1   │        │   Worker 2   │      │
//! │  │   receives   │        │   (idle)     │      │
//! │  │   job via    │        │              │      │
//! │  │   channel    │        │              │      │
//! │  └──────────────┘        └──────────────┘      │
//! └─────────────────────────────────────────────────┘
//! ```

mod cron;
mod registry;

pub use cron::CronScheduler;
pub use registry::{WorkerInfo, WorkerRegistry};

use crate::error::Result;
use crate::storage::Storage;
use std::sync::Arc;
use tokio::sync::Notify;
use tokio::time::{interval, Duration};
use tracing::{debug, error, info, warn};

/// The push-based job scheduler
///
/// TODO: Leader Election for HA
/// Currently runs on a single instance. For high availability in multi-node deployments,
/// implement leader election using:
/// - PostgreSQL advisory locks (SELECT pg_try_advisory_lock(...))
/// - Redis SETNX with TTL auto-renewal
/// - External coordination service (etcd, Consul, ZooKeeper)
/// Only the leader should run the scheduling loop. On leader failure, another instance
/// should automatically take over within a few seconds.
pub struct Scheduler<S: Storage> {
    storage: S,
    registry: WorkerRegistry,
    poll_interval: Duration,
    batch_size: usize,
    /// Notify channel for immediate scheduling (when new job arrives or worker completes)
    notify: Arc<Notify>,
    shutdown: Arc<Notify>,
}

impl<S: Storage> Scheduler<S> {
    /// Create a new scheduler with the given storage and worker registry
    pub fn new(
        storage: S,
        registry: WorkerRegistry,
        notify: Arc<Notify>,
        shutdown: Arc<Notify>,
    ) -> Self {
        Self {
            storage,
            registry,
            poll_interval: Duration::from_millis(30), // Faster response with smart scheduler
            batch_size: 100,                          // Balanced batch size
            notify,
            shutdown,
        }
    }

    /// Set the poll interval
    pub fn with_poll_interval(mut self, interval: Duration) -> Self {
        self.poll_interval = interval;
        self
    }

    /// Set the batch size for fetching pending jobs
    pub fn with_batch_size(mut self, size: usize) -> Self {
        self.batch_size = size;
        self
    }

    /// Run the scheduler loop
    ///
    /// This is the main scheduling loop that:
    /// 1. Polls for pending jobs from the database
    /// 2. Matches each job to the best available worker
    /// 3. Claims the job in the database
    /// 4. Pushes the job to the worker's channel
    pub async fn run(&self) {
        info!(
            "Push-based scheduler started (poll_interval={}ms, batch_size={})",
            self.poll_interval.as_millis(),
            self.batch_size
        );

        let mut ticker = interval(self.poll_interval);

        loop {
            tokio::select! {
                // Regular polling
                _ = ticker.tick() => {
                    if let Err(e) = self.schedule_pending_jobs().await {
                        error!("Scheduler error during polling: {}", e);
                    }
                }

                // Immediate scheduling when notified (new job or worker freed up)
                _ = self.notify.notified() => {
                    if let Err(e) = self.schedule_pending_jobs().await {
                        error!("Scheduler error after notification: {}", e);
                    }
                }

                // Shutdown signal
                _ = self.shutdown.notified() => {
                    info!("Scheduler received shutdown signal");
                    break;
                }
            }
        }

        info!("Push-based scheduler stopped");
    }

    /// Signal the scheduler to shut down
    pub fn shutdown(&self) {
        self.shutdown.notify_one();
    }

    /// Schedule pending jobs to available workers
    ///
    /// Uses atomic claim_and_fetch_jobs with FOR UPDATE SKIP LOCKED (PostgreSQL)
    /// to ensure no duplicate job execution in multi-node deployments.
    /// Each worker gets jobs claimed atomically - other schedulers automatically
    /// skip those rows and claim different jobs.
    async fn schedule_pending_jobs(&self) -> Result<()> {
        use std::time::Instant;

        let total_start = Instant::now();

        // Phase 1: Get snapshot of workers state (cheap, in-memory check FIRST)
        let snapshot_start = Instant::now();
        let workers = self.registry.get_snapshot().await;
        let snapshot_time = snapshot_start.elapsed();

        if workers.is_empty() {
            return Ok(());
        }

        // Build list of workers with available capacity
        let workers_with_capacity: Vec<_> = workers
            .iter()
            .filter_map(|w| {
                let used = w.active_jobs.len() as i32;
                let available = (w.concurrency - used).max(0) as usize;
                if available > 0 {
                    Some((w.clone(), available))
                } else {
                    None
                }
            })
            .collect();

        if workers_with_capacity.is_empty() {
            debug!("[SCHEDULER] All workers saturated (capacity=0), skipping DB fetch");
            return Ok(());
        }

        let total_capacity: usize = workers_with_capacity.iter().map(|(_, cap)| cap).sum();
        debug!(
            "[SCHEDULER] {} workers have total capacity={}, claiming jobs...",
            workers_with_capacity.len(),
            total_capacity
        );

        // Phase 2: Atomic claim per worker using SKIP LOCKED
        // Each worker gets its own atomic claim - no race conditions!
        let claim_start = Instant::now();
        let mut total_claimed = 0;
        let mut total_assigned = 0;

        for (worker, available_capacity) in workers_with_capacity {
            // Limit to worker's capacity or batch size
            let limit = available_capacity.min(self.batch_size);

            // Get list of function names this worker can handle
            let job_names: Vec<String> = worker.registered_names.iter().cloned().collect();

            // Atomic claim: SELECT ... FOR UPDATE SKIP LOCKED + UPDATE in one transaction
            let claimed_jobs = self
                .storage
                .claim_and_fetch_jobs(&worker.worker_id, &job_names, limit)
                .await?;

            if claimed_jobs.is_empty() {
                continue;
            }

            total_claimed += claimed_jobs.len();

            // Phase 3: Push claimed jobs to worker
            for job in claimed_jobs {
                if let Some(tx) = self
                    .registry
                    .try_assign_job(&worker.worker_id, &job.id)
                    .await
                {
                    match tx.try_send(job.clone()) {
                        Ok(()) => {
                            total_assigned += 1;
                        }
                        Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
                            warn!(
                                "Worker {} channel full, resetting job {}",
                                worker.worker_id, job.id
                            );
                            self.registry.job_completed(&job.id).await;
                            let _ = self.storage.reset_stale_job(&job.id).await;
                        }
                        Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                            warn!(
                                "Worker {} disconnected, job {} recovered",
                                worker.worker_id, job.id
                            );
                            self.registry.job_completed(&job.id).await;
                            // Job will be picked up by stale recovery
                        }
                    }
                } else {
                    warn!(
                        "Worker {} unavailable after claim, resetting job {}",
                        worker.worker_id, job.id
                    );
                    let _ = self.storage.reset_stale_job(&job.id).await;
                }
            }
        }

        let claim_time = claim_start.elapsed();
        let total_time = total_start.elapsed();

        // Log timing summary (only when we actually did work)
        if total_assigned > 0 {
            info!(
                "[TIMING] Scheduler cycle: total={}ms | snapshot={}us | claim+push={}ms | claimed={} assigned={}",
                total_time.as_millis(),
                snapshot_time.as_micros(),
                claim_time.as_millis(),
                total_claimed,
                total_assigned
            );
        }

        Ok(())
    }
}

/// Recover stale jobs from a previous crash
///
/// This function finds RUNNING jobs that haven't been updated in a while
/// and resets them to PENDING so they can be re-scheduled.
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::SqliteStorage;
    use std::time::Duration;

    #[tokio::test]
    async fn test_scheduler_creation() {
        let storage = SqliteStorage::in_memory().await.unwrap();
        let registry = WorkerRegistry::new();
        let notify = Arc::new(Notify::new());

        let scheduler = Scheduler::new(storage, registry, notify, Arc::new(Notify::new()))
            .with_poll_interval(Duration::from_millis(100))
            .with_batch_size(50);

        assert_eq!(scheduler.poll_interval, Duration::from_millis(100));
        assert_eq!(scheduler.batch_size, 50);
    }
}
