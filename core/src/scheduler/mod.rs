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

mod registry;

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
    pub fn new(storage: S, registry: WorkerRegistry, notify: Arc<Notify>) -> Self {
        Self {
            storage,
            registry,
            poll_interval: Duration::from_millis(50), // Fast polling since we're the only reader
            batch_size: 100,                          // Fetch more jobs per batch
            notify,
            shutdown: Arc::new(Notify::new()),
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
    async fn schedule_pending_jobs(&self) -> Result<()> {
        // Fetch pending jobs from database
        let pending_jobs = self.storage.get_pending_jobs(self.batch_size).await?;

        if pending_jobs.is_empty() {
            return Ok(());
        }

        // Get snapshot of workers state for planning
        let workers = self.registry.get_snapshot().await;

        if workers.is_empty() {
            return Ok(());
        }

        debug!(
            "Scheduler found {} pending jobs, {} workers connected",
            pending_jobs.len(),
            workers.len()
        );

        // Plan assignments locally (in-memory)
        let mut planned_assignments = Vec::new();
        let mut claims = Vec::new();

        // Track local usage to simulate capacity
        let mut local_usage: std::collections::HashMap<String, i32> = workers
            .iter()
            .map(|w| (w.worker_id.clone(), w.active_jobs.len() as i32))
            .collect();

        for job in &pending_jobs {
            // Find best worker using local simulation of capacity
            // Note: This logic duplicates registry.find_best_worker but uses local state map
            let best_worker = workers
                .iter()
                .filter(|w| w.can_handle(&job.name))
                .map(|w| {
                    let used = *local_usage.get(&w.worker_id).unwrap_or(&0);
                    let available = w.concurrency - used;
                    (w, available)
                })
                .filter(|(_, available)| *available > 0)
                .max_by_key(|(_, available)| *available);

            if let Some((worker, _)) = best_worker {
                claims.push((job.id.clone(), worker.worker_id.clone()));
                planned_assignments.push((job, worker.worker_id.clone()));

                // Decrement local capacity
                *local_usage.entry(worker.worker_id.clone()).or_insert(0) += 1;
            }
        }

        if claims.is_empty() {
            return Ok(());
        }

        // Execute batch claim in DB (One Transaction)
        // This returns only job_ids that were successfully claimed in DB
        // (handles race conditions if another scheduler claimed them)
        let claimed_ids = self.storage.claim_jobs(claims).await?;
        let claimed_set: std::collections::HashSet<_> = claimed_ids.iter().collect();

        let mut assigned_count = 0;

        // Push successfully claimed jobs to workers
        for (job, worker_id) in planned_assignments {
            if claimed_set.contains(&job.id) {
                // Now perform the in-memory assignment
                // This might fail if worker disconnected in the millisecond between snapshot and now
                if let Some(tx) = self.registry.try_assign_job(&worker_id, &job.id).await {
                    match tx.try_send(job.clone()) {
                        Ok(()) => {
                            assigned_count += 1;
                            debug!(
                                "Pushed job {} ({}) to worker {}",
                                job.id, job.name, worker_id
                            );
                        }
                        Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
                            warn!(
                                "Worker {} channel full, resetting job {}",
                                worker_id, job.id
                            );
                            self.registry.job_completed(&job.id).await;
                            let _ = self.storage.reset_stale_job(&job.id).await;
                        }
                        Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                            warn!(
                                "Worker {} disconnected, job {} recovered",
                                worker_id, job.id
                            );
                            self.registry.job_completed(&job.id).await;
                            // reset_stale_job isn't strictly needed as recovery handles it, but good practice
                        }
                    }
                } else {
                    warn!(
                        "Worker {} unavailable after claim, resetting job {}",
                        worker_id, job.id
                    );
                    let _ = self.storage.reset_stale_job(&job.id).await;
                }
            }
        }

        if assigned_count > 0 {
            debug!(
                "Batch scheduling: {} jobs requested, {} planned, {} claimed/assigned",
                pending_jobs.len(),
                claimed_ids.len(),
                assigned_count
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

        let scheduler = Scheduler::new(storage, registry, notify)
            .with_poll_interval(Duration::from_millis(100))
            .with_batch_size(50);

        assert_eq!(scheduler.poll_interval, Duration::from_millis(100));
        assert_eq!(scheduler.batch_size, 50);
    }
}
