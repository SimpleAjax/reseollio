//! gRPC service implementation with Push-Based Job Distribution
//!
//! This module implements the Reseolio gRPC service with a push-based architecture.
//! Workers register with the service and receive jobs pushed directly to them,
//! eliminating the thundering herd problem.

use crate::error::ReseolioError;
use crate::scheduler::{WorkerInfo, WorkerRegistry};
use crate::storage::{JobFilter, JobOptions, JobResult, JobStatus, NewJob, Storage};
use std::collections::HashSet;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::{mpsc, Notify};
use tokio_stream::{wrappers::ReceiverStream, Stream, StreamExt};
use tonic::{Request, Response, Status, Streaming};
use tracing::{debug, error, info, warn};

// Include generated protobuf code
pub mod proto {
    tonic::include_proto!("reseolio");
}

use proto::reseolio_server::{Reseolio, ReseolioServer as TonicReseolioServer};
use proto::*;

/// The Reseolio gRPC service implementation
pub struct ReseolioServer<S: Storage> {
    storage: S,
    /// Worker registry for push-based job distribution
    registry: WorkerRegistry,
    /// Channel to notify scheduler of new jobs or completed jobs
    scheduler_notify: Arc<Notify>,
}

impl<S: Storage> ReseolioServer<S> {
    pub fn new(storage: S, registry: WorkerRegistry, scheduler_notify: Arc<Notify>) -> Self {
        Self {
            storage,
            registry,
            scheduler_notify,
        }
    }

    /// Get a reference to the worker registry
    pub fn registry(&self) -> &WorkerRegistry {
        &self.registry
    }

    /// Convert to tonic service
    pub fn into_service(self) -> TonicReseolioServer<Self> {
        TonicReseolioServer::new(self)
    }
}

#[tonic::async_trait]
impl<S: Storage> Reseolio for ReseolioServer<S> {
    async fn enqueue_job(
        &self,
        request: Request<EnqueueRequest>,
    ) -> Result<Response<EnqueueResponse>, Status> {
        let req = request.into_inner();

        // Check for idempotency key
        if !req.idempotency_key.is_empty() {
            if let Some(existing) = self
                .storage
                .get_job_by_idempotency_key(&req.idempotency_key)
                .await
                .map_err(to_status)?
            {
                info!("Deduplicated job with key: {}", req.idempotency_key);
                return Ok(Response::new(EnqueueResponse {
                    job_id: existing.id,
                    deduplicated: true,
                }));
            }
        }

        // Convert proto options to internal options
        let options = req
            .options
            .map(|o| JobOptions {
                max_attempts: if o.max_attempts > 0 {
                    o.max_attempts
                } else {
                    3
                },
                backoff: match o.backoff.as_str() {
                    "fixed" => crate::storage::BackoffStrategy::Fixed,
                    "linear" => crate::storage::BackoffStrategy::Linear,
                    _ => crate::storage::BackoffStrategy::Exponential,
                },
                initial_delay_ms: if o.initial_delay_ms > 0 {
                    o.initial_delay_ms
                } else {
                    1000
                },
                max_delay_ms: if o.max_delay_ms > 0 {
                    o.max_delay_ms
                } else {
                    60000
                },
                timeout_ms: if o.timeout_ms > 0 {
                    o.timeout_ms
                } else {
                    30000
                },
                jitter: if o.jitter > 0.0 { o.jitter } else { 0.1 },
            })
            .unwrap_or_default();

        let new_job = NewJob {
            name: req.name,
            args: req.args,
            options,
            idempotency_key: if req.idempotency_key.is_empty() {
                None
            } else {
                Some(req.idempotency_key)
            },
        };

        let job = self.storage.insert_job(new_job).await.map_err(to_status)?;

        info!("Enqueued job: {} ({})", job.id, job.name);

        // Notify scheduler to process new job immediately
        self.scheduler_notify.notify_one();

        Ok(Response::new(EnqueueResponse {
            job_id: job.id,
            deduplicated: false,
        }))
    }

    type PollJobsStream = Pin<Box<dyn Stream<Item = Result<proto::Job, Status>> + Send>>;

    /// Handle worker connection and push jobs to them
    ///
    /// In the push-based architecture, workers connect via this streaming RPC
    /// and register their capabilities. The scheduler then pushes jobs directly
    /// to workers based on their capacity and registered job names.
    async fn poll_jobs(
        &self,
        request: Request<Streaming<PollRequest>>,
    ) -> Result<Response<Self::PollJobsStream>, Status> {
        let mut stream = request.into_inner();
        let registry = self.registry.clone();
        let storage = self.storage.clone();
        let scheduler_notify = self.scheduler_notify.clone();

        // Channel for pushing jobs to this worker
        // The scheduler will send jobs here, worker receives them
        let (tx, rx) = mpsc::channel(100);

        // Spawn task to handle worker registration and lifecycle
        tokio::spawn(async move {
            // Wait for initial poll request with worker info
            let worker_id: String;
            let registered_names: Vec<String>;
            let concurrency: i32;

            match stream.next().await {
                Some(Ok(poll_req)) => {
                    worker_id = poll_req.worker_id.clone();
                    registered_names = poll_req.names.clone();
                    concurrency = poll_req.concurrency;

                    // Register worker with the registry
                    registry
                        .register(WorkerInfo {
                            worker_id: worker_id.clone(),
                            tx: tx.clone(),
                            registered_names: registered_names.clone(),
                            concurrency,
                            active_jobs: HashSet::new(),
                            last_heartbeat: Instant::now(),
                        })
                        .await;

                    info!(
                        "Worker {} connected (concurrency={}, names={:?})",
                        worker_id, concurrency, registered_names
                    );

                    // Notify scheduler that a new worker is available
                    scheduler_notify.notify_one();
                }
                Some(Err(e)) => {
                    error!("Error reading initial poll request: {}", e);
                    return;
                }
                None => {
                    debug!("Worker stream closed before registration");
                    return;
                }
            }

            // Keep the stream alive and handle heartbeats / additional messages
            loop {
                match stream.next().await {
                    Some(Ok(poll_req)) => {
                        // Heartbeat or capability update
                        registry.update_heartbeat(&poll_req.worker_id).await;
                        debug!("Heartbeat from worker {}", poll_req.worker_id);
                    }
                    Some(Err(e)) => {
                        warn!("Worker {} stream error: {}", worker_id, e);
                        break;
                    }
                    None => {
                        info!("Worker {} disconnected", worker_id);
                        break;
                    }
                }
            }

            // Worker disconnected - unregister and recover jobs
            let active_jobs = registry.unregister(&worker_id).await;

            // Reset active jobs to PENDING so they can be re-scheduled
            for job_id in active_jobs {
                match storage.reset_stale_job(&job_id).await {
                    Ok(()) => {
                        info!(
                            "Reset orphaned job {} to PENDING after worker {} disconnect",
                            job_id, worker_id
                        );
                    }
                    Err(e) => {
                        error!("Failed to reset orphaned job {}: {}", job_id, e);
                    }
                }
            }

            // Notify scheduler to re-process any reset jobs
            scheduler_notify.notify_one();
        });

        // Convert the receiver channel to a stream that sends proto::Job
        let job_stream = ReceiverStream::new(rx).map(|job| Ok(job_to_proto(&job)));

        Ok(Response::new(Box::pin(job_stream)))
    }

    async fn ack_job(&self, request: Request<AckRequest>) -> Result<Response<AckResponse>, Status> {
        let req = request.into_inner();
        let result = req
            .result
            .ok_or_else(|| Status::invalid_argument("Missing result"))?;

        // Mark job as completed in the registry (frees capacity)
        self.registry.job_completed(&req.job_id).await;

        let job_result = if result.success {
            JobResult::Success {
                return_value: if result.return_value.is_empty() {
                    None
                } else {
                    Some(result.return_value)
                },
            }
        } else {
            JobResult::Failed {
                error: result.error,
                should_retry: result.should_retry,
            }
        };

        let job = self
            .storage
            .update_job_result(&req.job_id, job_result)
            .await
            .map_err(to_status)?;

        info!("Acked job {} -> {:?}", job.id, job.status);

        // Notify scheduler that a worker has capacity again
        self.scheduler_notify.notify_one();

        Ok(Response::new(AckResponse {
            new_status: status_to_proto(job.status) as i32,
            next_attempt: job.attempt + 1,
            next_run_at: job.scheduled_at.timestamp_millis(),
        }))
    }

    async fn get_job(
        &self,
        request: Request<GetJobRequest>,
    ) -> Result<Response<proto::Job>, Status> {
        let job_id = request.into_inner().job_id;

        let job = self
            .storage
            .get_job(&job_id)
            .await
            .map_err(to_status)?
            .ok_or_else(|| Status::not_found(format!("Job not found: {}", job_id)))?;

        Ok(Response::new(job_to_proto(&job)))
    }

    async fn cancel_job(
        &self,
        request: Request<CancelRequest>,
    ) -> Result<Response<CancelResponse>, Status> {
        let job_id = request.into_inner().job_id;

        let cancelled = self.storage.cancel_job(&job_id).await.map_err(to_status)?;

        Ok(Response::new(CancelResponse {
            success: cancelled,
            message: if cancelled {
                "Job cancelled".to_string()
            } else {
                "Job could not be cancelled (not in PENDING state)".to_string()
            },
        }))
    }

    async fn list_jobs(
        &self,
        request: Request<ListJobsRequest>,
    ) -> Result<Response<ListJobsResponse>, Status> {
        let req = request.into_inner();

        let filter = JobFilter {
            statuses: req
                .statuses
                .iter()
                .filter_map(|s| proto_to_status(*s))
                .collect(),
            names: req.names,
            limit: Some(req.limit.max(1).min(1000)),
            offset: Some(req.offset.max(0)),
            order_by: if req.order_by.is_empty() {
                None
            } else {
                Some(req.order_by)
            },
            ascending: req.ascending,
        };

        let (jobs, total) = self.storage.list_jobs(filter).await.map_err(to_status)?;

        Ok(Response::new(ListJobsResponse {
            jobs: jobs.iter().map(job_to_proto).collect(),
            total,
        }))
    }
}

fn to_status(e: ReseolioError) -> Status {
    match e {
        ReseolioError::JobNotFound(id) => Status::not_found(format!("Job not found: {}", id)),
        ReseolioError::DuplicateJob(key) => {
            Status::already_exists(format!("Duplicate job: {}", key))
        }
        ReseolioError::InvalidStateTransition { from, to } => {
            Status::failed_precondition(format!("Invalid state transition: {} -> {}", from, to))
        }
        _ => Status::internal(e.to_string()),
    }
}

fn job_to_proto(job: &crate::storage::InternalJob) -> proto::Job {
    proto::Job {
        id: job.id.clone(),
        name: job.name.clone(),
        args: job.args.clone(),
        attempt: job.attempt,
        deadline_ms: job.scheduled_at.timestamp_millis() + job.options.timeout_ms as i64,
        status: status_to_proto(job.status) as i32,
        error: job.error.clone().unwrap_or_default(),
        result: job.result.clone().unwrap_or_default(),
        created_at: job.created_at.timestamp_millis(),
        scheduled_at: job.scheduled_at.timestamp_millis(),
    }
}

fn status_to_proto(status: JobStatus) -> proto::JobStatus {
    match status {
        JobStatus::Pending => proto::JobStatus::Pending,
        JobStatus::Running => proto::JobStatus::Running,
        JobStatus::Success => proto::JobStatus::Success,
        JobStatus::Failed => proto::JobStatus::Failed,
        JobStatus::Dead => proto::JobStatus::Dead,
        JobStatus::Cancelled => proto::JobStatus::Cancelled,
    }
}

fn proto_to_status(status: i32) -> Option<JobStatus> {
    match status {
        1 => Some(JobStatus::Pending),
        2 => Some(JobStatus::Running),
        3 => Some(JobStatus::Success),
        4 => Some(JobStatus::Failed),
        5 => Some(JobStatus::Dead),
        6 => Some(JobStatus::Cancelled),
        _ => None,
    }
}
