//! gRPC service implementation

use crate::error::ReseolioError;
use crate::storage::{JobFilter, JobOptions, JobResult, JobStatus, NewJob, Storage};
use std::pin::Pin;
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_stream::{wrappers::ReceiverStream, Stream, StreamExt};
use tonic::{Request, Response, Status, Streaming};
use tracing::{debug, error, info};

// Include generated protobuf code
pub mod proto {
    tonic::include_proto!("reseolio");
}

use proto::reseolio_server::{Reseolio, ReseolioServer as TonicReseolioServer};
use proto::*;

/// The Reseolio gRPC service implementation
pub struct ReseolioServer<S: Storage> {
    storage: S,
    /// Channel to notify workers of new jobs
    job_notify: Arc<tokio::sync::Notify>,
}

impl<S: Storage> ReseolioServer<S> {
    pub fn new(storage: S) -> Self {
        Self {
            storage,
            job_notify: Arc::new(tokio::sync::Notify::new()),
        }
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

        // Notify waiting workers
        self.job_notify.notify_waiters();

        Ok(Response::new(EnqueueResponse {
            job_id: job.id,
            deduplicated: false,
        }))
    }

    type PollJobsStream = Pin<Box<dyn Stream<Item = Result<proto::Job, Status>> + Send>>;

    async fn poll_jobs(
        &self,
        request: Request<Streaming<PollRequest>>,
    ) -> Result<Response<Self::PollJobsStream>, Status> {
        let mut stream = request.into_inner();
        let storage = self.storage.clone();
        let notify = self.job_notify.clone();

        let (tx, rx) = mpsc::channel(100);

        tokio::spawn(async move {
            let mut worker_id: Option<String> = None;
            let mut names: Vec<String> = vec![];
            // TODO : Improve this : for 100 workers connected, eveery second if 100ms is polling freq, we will perform 1k req/sec just to claim job, leading to un-necessary high usage.
            // TODO : somehow reduce the thundering herd issue (jitter + expo backoff is one way, but ideally some workers at a time should be pinged to take up job work)
            loop {
                tokio::select! {
                    // Handle incoming poll requests
                    poll_result = stream.next() => {
                        match poll_result {
                            Some(Ok(poll_req)) => {
                                worker_id = Some(poll_req.worker_id.clone());
                                names = poll_req.names;
                                debug!("Worker {} polling for jobs", poll_req.worker_id);
                            }
                            Some(Err(e)) => {
                                error!("Poll stream error: {}", e);
                                break;
                            }
                            None => {
                                // Stream closed by client
                                if let Some(ref wid) = worker_id {
                                    info!("Worker {} disconnected (stream closed)", wid);
                                } else {
                                    info!("Worker stream closed before registration");
                                }
                                break;  // Exit task - client disconnected
                            }
                        }
                    }

                    // Check for available jobs
                    _ = notify.notified() => {
                        if let Some(ref wid) = worker_id {
                            match storage.get_pending_jobs(10).await {  // ← Fetch up to 10 jobs
                                Ok(jobs) => {
                                    for job in jobs {
                                        // Filter by name if specified
                                        if !names.is_empty() && !names.contains(&job.name) {
                                            continue;
                                        }

                                        // Try to claim the job
                                        if let Ok(true) = storage.claim_job(&job.id, wid).await {
                                            let proto_job = job_to_proto(&job);
                                            debug!("Sending job {} ({}) to worker {}", job.id, job.name, wid);
                                            match tx.send(Ok(proto_job)).await {
                                                Ok(()) => {
                                                    debug!("Successfully sent job {} to worker", job.id);
                                                }
                                                Err(_) => {
                                                    error!(
                                                        "Failed to send job {} ({}) to worker {}: Channel closed (receiver dropped)",
                                                        job.id, job.name, wid
                                                    );
                                                    error!(
                                                        "Worker {} disconnected while processing jobs. Remaining jobs will be retried.",
                                                        wid
                                                    );
                                                    break;
                                                }
                                            }
                                        } else {
                                            debug!("Job {} was not claimed (already claimed or not pending)", job.id);
                                        }
                                    }
                                }
                                Err(e) => {
                                    error!("Failed to get pending jobs: {}", e);
                                }
                            }
                        }
                    }

                    // Periodic poll every 100ms
                    _ = tokio::time::sleep(tokio::time::Duration::from_millis(100)) => {
                        if let Some(ref wid) = worker_id {
                            match storage.get_pending_jobs(10).await {  // ← Fetch up to 10 jobs
                                Ok(jobs) => {
                                    for job in jobs {
                                        if !names.is_empty() && !names.contains(&job.name) {
                                            continue;
                                        }

                                        if let Ok(true) = storage.claim_job(&job.id, wid).await {
                                            let proto_job = job_to_proto(&job);
                                            debug!("Sending job {} ({}) to worker {} (periodic)", job.id, job.name, wid);
                                            match tx.send(Ok(proto_job)).await {
                                                Ok(()) => {
                                                    debug!("Successfully sent job {} to worker (periodic)", job.id);
                                                }
                                                Err(_) => {
                                                    error!(
                                                        "Failed to send job {} ({}) to worker {} (periodic): Channel closed (receiver dropped)",
                                                        job.id, job.name, wid
                                                    );
                                                    error!(
                                                        "Worker {} disconnected during periodic poll. Remaining jobs will be retried.",
                                                        wid
                                                    );
                                                    break;
                                                }
                                            }
                                        } else {
                                            debug!("Job {} was not claimed (already claimed or not pending)", job.id);
                                        }
                                    }
                                }
                                Err(e) => {
                                    error!("Failed to get pending jobs: {}", e);
                                }
                            }
                        }
                    }
                }
            }
        });

        Ok(Response::new(Box::pin(ReceiverStream::new(rx))))
    }

    async fn ack_job(&self, request: Request<AckRequest>) -> Result<Response<AckResponse>, Status> {
        let req = request.into_inner();
        let result = req
            .result
            .ok_or_else(|| Status::invalid_argument("Missing result"))?;

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
