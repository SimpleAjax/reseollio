//! Worker Registry for Push-Based Job Scheduling
//!
//! This module maintains a registry of all connected workers and their capacity.
//! The scheduler uses this to intelligently assign jobs to workers without
//! the thundering herd problem.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::{mpsc, RwLock};
use tracing::{debug, info};

use crate::storage::InternalJob;

/// Information about a connected worker
#[derive(Debug, Clone)]
pub struct WorkerInfo {
    /// Unique worker identifier
    pub worker_id: String,
    /// Channel to push jobs to this worker
    pub tx: mpsc::Sender<InternalJob>,
    /// Job names this worker can handle (empty = all jobs)
    pub registered_names: Vec<String>,
    /// Maximum concurrent jobs this worker can process
    pub concurrency: i32,
    /// Job IDs currently being processed by this worker
    pub active_jobs: HashSet<String>,
    /// Last time we heard from this worker
    pub last_heartbeat: Instant,
}

impl WorkerInfo {
    /// Get the available capacity for this worker
    pub fn available_capacity(&self) -> i32 {
        self.concurrency - self.active_jobs.len() as i32
    }

    /// Check if this worker can handle the given job name
    pub fn can_handle(&self, job_name: &str) -> bool {
        self.registered_names.is_empty() || self.registered_names.contains(&job_name.to_string())
    }
}

/// Thread-safe worker registry
///
/// TODO: Leader Election for HA
/// Currently, the scheduler runs on a single instance. For high availability,
/// implement leader election so that only one instance runs the scheduler at a time.
/// Options:
/// - PostgreSQL advisory locks (when Postgres storage is implemented)
/// - Redis SETNX with TTL renewal
/// - etcd/Consul for distributed coordination
/// This ensures no duplicate job assignments across multiple instances.
#[derive(Clone)]
pub struct WorkerRegistry {
    inner: Arc<RwLock<RegistryInner>>,
}

struct RegistryInner {
    /// Map of worker_id -> WorkerInfo
    workers: HashMap<String, WorkerInfo>,
    /// Map of job_id -> worker_id (to track which worker is processing which job)
    job_assignments: HashMap<String, String>,
}

impl WorkerRegistry {
    /// Create a new empty registry
    pub fn new() -> Self {
        Self {
            inner: Arc::new(RwLock::new(RegistryInner {
                workers: HashMap::new(),
                job_assignments: HashMap::new(),
            })),
        }
    }

    /// Register a new worker
    pub async fn register(&self, worker: WorkerInfo) {
        let worker_id = worker.worker_id.clone();
        let concurrency = worker.concurrency;
        let names = worker.registered_names.clone();

        let mut inner = self.inner.write().await;
        inner.workers.insert(worker_id.clone(), worker);

        info!(
            "Registered worker {} (concurrency={}, names={:?})",
            worker_id, concurrency, names
        );
    }

    /// Unregister a worker (on disconnect)
    pub async fn unregister(&self, worker_id: &str) -> Vec<String> {
        let mut inner = self.inner.write().await;

        // Get the worker's active jobs before removing
        let active_jobs = if let Some(worker) = inner.workers.get(worker_id) {
            worker.active_jobs.iter().cloned().collect::<Vec<_>>()
        } else {
            vec![]
        };

        // Remove job assignments for this worker
        for job_id in &active_jobs {
            inner.job_assignments.remove(job_id);
        }

        // Remove the worker
        inner.workers.remove(worker_id);

        info!(
            "Unregistered worker {} (had {} active jobs)",
            worker_id,
            active_jobs.len()
        );

        active_jobs
    }

    /// Get a snapshot of all connected workers
    pub async fn get_snapshot(&self) -> Vec<WorkerInfo> {
        let inner = self.inner.read().await;
        inner.workers.values().cloned().collect()
    }

    /// Find the best available worker for a given job
    /// Returns None if no worker can handle this job or all workers are at capacity
    pub async fn find_best_worker(&self, job_name: &str) -> Option<String> {
        let inner = self.inner.read().await;

        inner
            .workers
            .values()
            .filter(|w| w.can_handle(job_name))
            .filter(|w| w.available_capacity() > 0)
            .max_by_key(|w| w.available_capacity())
            .map(|w| w.worker_id.clone())
    }

    /// Try to assign a job to a specific worker
    /// Returns the channel sender if successful, None if worker is at capacity or disconnected
    pub async fn try_assign_job(
        &self,
        worker_id: &str,
        job_id: &str,
    ) -> Option<mpsc::Sender<InternalJob>> {
        let mut inner = self.inner.write().await;

        // Check capacity and get tx - using a block to manage borrows
        let result = if let Some(worker) = inner.workers.get_mut(worker_id) {
            if worker.available_capacity() > 0 {
                let tx = worker.tx.clone();
                let active_count = worker.active_jobs.len() + 1;
                worker.active_jobs.insert(job_id.to_string());
                Some((tx, active_count))
            } else {
                None
            }
        } else {
            None
        };

        // Now update job_assignments after we're done with workers borrow
        if let Some((tx, active_count)) = result {
            inner
                .job_assignments
                .insert(job_id.to_string(), worker_id.to_string());

            debug!(
                "Assigned job {} to worker {} (now {} active)",
                job_id, worker_id, active_count
            );

            return Some(tx);
        }

        None
    }

    /// Mark a job as complete (success or failure)
    /// This frees up capacity on the worker
    pub async fn job_completed(&self, job_id: &str) {
        let mut inner = self.inner.write().await;

        if let Some(worker_id) = inner.job_assignments.remove(job_id) {
            if let Some(worker) = inner.workers.get_mut(&worker_id) {
                worker.active_jobs.remove(job_id);
                debug!(
                    "Job {} completed by worker {} (now {} active)",
                    job_id,
                    worker_id,
                    worker.active_jobs.len()
                );
            }
        }
    }

    /// Get the total available capacity across all workers for a given job name
    pub async fn total_available_capacity(&self, job_name: &str) -> i32 {
        let inner = self.inner.read().await;

        inner
            .workers
            .values()
            .filter(|w| w.can_handle(job_name))
            .map(|w| w.available_capacity())
            .sum()
    }

    /// Get the number of connected workers
    pub async fn worker_count(&self) -> usize {
        let inner = self.inner.read().await;
        inner.workers.len()
    }

    /// Get all worker IDs (for debugging / metrics)
    pub async fn get_worker_ids(&self) -> Vec<String> {
        let inner = self.inner.read().await;
        inner.workers.keys().cloned().collect()
    }

    /// Update heartbeat for a worker
    pub async fn update_heartbeat(&self, worker_id: &str) {
        let mut inner = self.inner.write().await;
        if let Some(worker) = inner.workers.get_mut(worker_id) {
            worker.last_heartbeat = Instant::now();
        }
    }

    /// Get workers that haven't sent a heartbeat in the given duration
    pub async fn get_stale_workers(&self, timeout_secs: u64) -> Vec<String> {
        let inner = self.inner.read().await;
        let now = Instant::now();

        inner
            .workers
            .values()
            .filter(|w| now.duration_since(w.last_heartbeat).as_secs() > timeout_secs)
            .map(|w| w.worker_id.clone())
            .collect()
    }
}

impl Default for WorkerRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_register_and_find_worker() {
        let registry = WorkerRegistry::new();
        let (tx, _rx) = mpsc::channel(10);

        registry
            .register(WorkerInfo {
                worker_id: "worker-1".to_string(),
                tx,
                registered_names: vec!["job-a".to_string()],
                concurrency: 3,
                active_jobs: HashSet::new(),
                last_heartbeat: Instant::now(),
            })
            .await;

        // Should find worker for job-a
        assert_eq!(
            registry.find_best_worker("job-a").await,
            Some("worker-1".to_string())
        );

        // Should not find worker for job-b
        assert_eq!(registry.find_best_worker("job-b").await, None);
    }

    #[tokio::test]
    async fn test_capacity_tracking() {
        let registry = WorkerRegistry::new();
        let (tx, _rx) = mpsc::channel(10);

        registry
            .register(WorkerInfo {
                worker_id: "worker-1".to_string(),
                tx,
                registered_names: vec![],
                concurrency: 2,
                active_jobs: HashSet::new(),
                last_heartbeat: Instant::now(),
            })
            .await;

        // Assign first job
        assert!(registry.try_assign_job("worker-1", "job-1").await.is_some());

        // Assign second job
        assert!(registry.try_assign_job("worker-1", "job-2").await.is_some());

        // Third job should fail (at capacity)
        assert!(registry.try_assign_job("worker-1", "job-3").await.is_none());

        // Complete a job
        registry.job_completed("job-1").await;

        // Now third job should succeed
        assert!(registry.try_assign_job("worker-1", "job-3").await.is_some());
    }
}
