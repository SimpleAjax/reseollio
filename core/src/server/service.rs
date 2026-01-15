//! gRPC service implementation with Push-Based Job Distribution
//!
//! This module implements the Reseolio gRPC service with a push-based architecture.
//! Workers register with the service and receive jobs pushed directly to them,
//! eliminating the thundering herd problem.

use crate::error::ReseolioError;
use crate::scheduler::{WorkerInfo, WorkerRegistry};
use crate::storage::{JobFilter, JobOptions, JobResult, JobStatus, NewJob, Storage};
use std::collections::{HashMap, HashSet};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::{mpsc, Notify, RwLock};
use tokio_stream::{wrappers::ReceiverStream, Stream, StreamExt};
use tonic::{Request, Response, Status, Streaming};
use tracing::{debug, error, info, warn};

// Include generated protobuf code
pub mod proto {
    tonic::include_proto!("reseolio");
}

use proto::reseolio_server::{Reseolio, ReseolioServer as TonicReseolioServer};
use proto::*;

/// Cached job completion for late subscribers (with timestamp for TTL)
struct CachedCompletion {
    completion: proto::JobCompletion,
    cached_at: Instant,
}

/// The Reseolio gRPC service implementation
pub struct ReseolioServer<S: Storage> {
    storage: S,
    /// Worker registry for push-based job distribution
    registry: WorkerRegistry,
    /// Channel to notify scheduler of new jobs or completed jobs
    scheduler_notify: Arc<Notify>,
    /// Channel for batching job acknowledgments
    ack_tx: mpsc::Sender<(String, JobResult, tokio::sync::oneshot::Sender<()>)>, // Added oneshot for optional wait, though we optimize for fire-forget
    /// Subscribers waiting for job completions (job_id -> list of notification channels)
    job_subscribers: Arc<RwLock<HashMap<String, Vec<mpsc::Sender<proto::JobCompletion>>>>>,
    /// Cache for job completions that arrived before subscriptions (fixes race condition)
    completed_jobs_cache: Arc<RwLock<HashMap<String, CachedCompletion>>>,
}

impl<S: Storage> ReseolioServer<S> {
    pub fn new(storage: S, registry: WorkerRegistry, scheduler_notify: Arc<Notify>) -> Self {
        // Channel size 10000 to buffer high spikes
        // Now includes job_id for subscriber notification
        let (ack_tx, mut ack_rx) =
            mpsc::channel::<(String, JobResult, tokio::sync::oneshot::Sender<()>)>(10000);

        let storage_clone = storage.clone();

        // Create subscribers map and clone for the batch processor
        let job_subscribers: Arc<RwLock<HashMap<String, Vec<mpsc::Sender<proto::JobCompletion>>>>> =
            Arc::new(RwLock::new(HashMap::new()));
        let subscribers_clone = job_subscribers.clone();

        // Create completion cache for late subscribers (fixes race condition)
        let completed_jobs_cache: Arc<RwLock<HashMap<String, CachedCompletion>>> =
            Arc::new(RwLock::new(HashMap::new()));
        let cache_clone = completed_jobs_cache.clone();

        // Cache TTL: 60 seconds (plenty of time for subscription to arrive)
        let cache_ttl = std::time::Duration::from_secs(60);

        // spawn batch processor
        tokio::spawn(async move {
            let batch_size = 100;
            let batch_timeout = std::time::Duration::from_millis(10);
            let mut batch: Vec<(String, JobResult)> = Vec::with_capacity(batch_size);
            let mut listeners = Vec::with_capacity(batch_size);

            loop {
                // Collect batch
                let collect_start = Instant::now();

                // First item blocking (or until closed)
                match ack_rx.recv().await {
                    Some((job_id, result, tx)) => {
                        batch.push((job_id, result));
                        listeners.push(tx);
                    }
                    None => break, // Channel closed
                }

                // Try to fill batch with remaining time
                loop {
                    if batch.len() >= batch_size {
                        break;
                    }

                    let elapsed = collect_start.elapsed();
                    if elapsed >= batch_timeout {
                        break;
                    }

                    match tokio::time::timeout(batch_timeout - elapsed, ack_rx.recv()).await {
                        Ok(Some((job_id, result, tx))) => {
                            batch.push((job_id, result));
                            listeners.push(tx);
                        }
                        Ok(None) => break, // Channel closed, process what we have and exit loop
                        Err(_) => break,   // Timeout
                    }
                }

                if batch.is_empty() {
                    continue;
                }

                let collect_time = collect_start.elapsed();
                let batch_count = batch.len();

                // Save result details for building notifications later
                // Map: job_id -> (result_bytes, error_string)
                let job_results_map: std::collections::HashMap<String, (Vec<u8>, String)> = batch
                    .iter()
                    .map(|(job_id, result)| {
                        let (result_bytes, error) = match result {
                            JobResult::Success { return_value } => {
                                (return_value.clone().unwrap_or_default(), String::new())
                            }
                            JobResult::Failed { error, .. } => (vec![], error.clone()),
                        };
                        (job_id.clone(), (result_bytes, error))
                    })
                    .collect();

                // Process batch and get actual final statuses
                let update_start = Instant::now();
                match storage_clone
                    .update_job_results(batch.drain(..).collect())
                    .await
                {
                    Err(e) => {
                        error!("Failed to commit batch acknowledgments: {}", e);
                    }
                    Ok(final_statuses) => {
                        let update_time = update_start.elapsed();
                        info!(
                            "[TIMING] Ack batch: count={} | collect={}ms | update={}ms",
                            batch_count,
                            collect_time.as_millis(),
                            update_time.as_millis()
                        );

                        // Build completions using the ACTUAL final statuses from storage
                        let completions: Vec<(String, proto::JobCompletion)> = final_statuses
                            .into_iter()
                            .filter_map(|(job_id, status)| {
                                let proto_status = match status {
                                    crate::storage::JobStatus::Success => {
                                        proto::JobStatus::Success as i32
                                    }
                                    crate::storage::JobStatus::Dead => {
                                        proto::JobStatus::Dead as i32
                                    }
                                    crate::storage::JobStatus::Cancelled => {
                                        proto::JobStatus::Cancelled as i32
                                    }
                                    crate::storage::JobStatus::Pending => {
                                        proto::JobStatus::Pending as i32
                                    }
                                    crate::storage::JobStatus::Running => {
                                        proto::JobStatus::Running as i32
                                    }
                                    crate::storage::JobStatus::Failed => {
                                        proto::JobStatus::Failed as i32
                                    }
                                };

                                if let Some((result_bytes, error)) = job_results_map.get(&job_id) {
                                    Some((
                                        job_id.clone(),
                                        proto::JobCompletion {
                                            job_id: job_id.clone(),
                                            status: proto_status,
                                            result: result_bytes.clone(),
                                            error: error.clone(),
                                        },
                                    ))
                                } else {
                                    None
                                }
                            })
                            .collect();

                        // Notify subscribers of completed jobs (or cache for late arrivals)
                        let mut subs = subscribers_clone.write().await;
                        let mut cache = cache_clone.write().await;

                        // Periodic cache cleanup (remove expired entries)
                        cache.retain(|_, cached| cached.cached_at.elapsed() < cache_ttl);

                        for (job_id, completion) in completions {
                            // Only notify/cache for terminal states
                            if completion.status == proto::JobStatus::Success as i32
                                || completion.status == proto::JobStatus::Dead as i32
                                || completion.status == proto::JobStatus::Cancelled as i32
                            {
                                if let Some(senders) = subs.remove(&job_id) {
                                    // Subscriber exists - notify immediately
                                    info!(
                                        "Notifying {} subscribers for job {} (status={:?})",
                                        senders.len(),
                                        job_id,
                                        completion.status
                                    );
                                    if completion.status == proto::JobStatus::Dead as i32 {
                                        warn!(
                                            "Sending DEAD notification to {} subscribers for job {}",
                                            senders.len(),
                                            job_id
                                        );
                                    }
                                    for sender in senders {
                                        if let Err(e) = sender.try_send(completion.clone()) {
                                            warn!("Failed to send notification for job {}: channel full/closed ({})", job_id, e);
                                        }
                                    }
                                } else {
                                    // No subscriber yet - cache for late arrival
                                    info!("Caching completion for job {} (no subscriber yet, status={:?})", job_id, completion.status);
                                    if completion.status == proto::JobStatus::Dead as i32 {
                                        warn!(
                                            "Caching DEAD completion for job {} (no subscriber found)",
                                            job_id
                                        );
                                    }
                                    cache.insert(
                                        job_id.clone(),
                                        CachedCompletion {
                                            completion: completion.clone(),
                                            cached_at: Instant::now(),
                                        },
                                    );
                                }
                            }
                        }
                    }
                }

                // Notify listeners (fire and forget mostly, but signal done)
                // This happens for BOTH success and error cases
                for tx in listeners.drain(..) {
                    let _ = tx.send(());
                }
            }
        });

        Self {
            storage,
            registry,
            scheduler_notify,
            ack_tx,
            job_subscribers,
            completed_jobs_cache,
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
    // ... enqueue_job and poll_jobs unchanged ...
    async fn enqueue_job(
        &self,
        request: Request<EnqueueRequest>,
    ) -> Result<Response<EnqueueResponse>, Status> {
        debug!("[ENQUEUE_JOB] >>> Received enqueue request");
        let req = request.into_inner();
        debug!(
            "[ENQUEUE_JOB] name={}, idempotency_key={}, args_len={}",
            req.name,
            if req.idempotency_key.is_empty() {
                "<none>"
            } else {
                &req.idempotency_key
            },
            req.args.len()
        );

        // Check for idempotency key (scoped per function name)
        if !req.idempotency_key.is_empty() {
            if let Some(existing) = self
                .storage
                .get_job_by_idempotency_key(&req.name, &req.idempotency_key)
                .await
                .map_err(to_status)?
            {
                info!(
                    "Deduplicated job {} with key: {}",
                    req.name, req.idempotency_key
                );
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

        debug!("[ENQUEUE_JOB] Inserting job into storage...");
        let job = self.storage.insert_job(new_job).await.map_err(|e| {
            error!("[ENQUEUE_JOB] Failed to insert job: {:?}", e);
            to_status(e)
        })?;

        info!("[ENQUEUE_JOB] <<< Enqueued job: {} ({})", job.id, job.name);

        // Notify scheduler to process new job immediately
        self.scheduler_notify.notify_one();

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
        debug!("[POLL_JOBS] >>> New worker connection received");
        let mut stream = request.into_inner();
        let registry = self.registry.clone();
        let storage = self.storage.clone();
        let scheduler_notify = self.scheduler_notify.clone();

        // Channel for pushing jobs to this worker
        let (tx, rx) = mpsc::channel(100);

        tokio::spawn(async move {
            let worker_id: String;
            let registered_names: Vec<String>;
            let concurrency: i32;

            match stream.next().await {
                Some(Ok(poll_req)) => {
                    worker_id = poll_req.worker_id.clone();
                    registered_names = poll_req.names.clone();
                    concurrency = poll_req.concurrency;

                    debug!(
                        "[POLL_JOBS] Worker {} registering: concurrency={}, names={:?}",
                        worker_id, concurrency, registered_names
                    );

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
                        "[POLL_JOBS] <<< Worker {} connected (concurrency={}, names={:?})",
                        worker_id, concurrency, registered_names
                    );

                    debug!("[POLL_JOBS] Notifying scheduler about new worker");
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

            loop {
                match stream.next().await {
                    Some(Ok(poll_req)) => {
                        // Update worker capabilities (handles dynamic handler registration)
                        registry
                            .update_worker_capabilities(
                                &poll_req.worker_id,
                                poll_req.names.clone(),
                                poll_req.concurrency,
                            )
                            .await;
                        debug!("Heartbeat/update from worker {}", poll_req.worker_id);
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

            let active_jobs = registry.unregister(&worker_id).await;

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

            scheduler_notify.notify_one();
        });

        let job_stream = ReceiverStream::new(rx).map(|job| Ok(job_to_proto(&job)));

        Ok(Response::new(Box::pin(job_stream)))
    }

    async fn ack_job(&self, request: Request<AckRequest>) -> Result<Response<AckResponse>, Status> {
        debug!("[ACK_JOB] >>> Received ack request");
        let req = request.into_inner();
        debug!("[ACK_JOB] job_id={}", req.job_id);

        let result = req.result.ok_or_else(|| {
            error!(
                "[ACK_JOB] Missing result in ack request for job {}",
                req.job_id
            );
            Status::invalid_argument("Missing result")
        })?;

        debug!(
            "[ACK_JOB] success={}, error={}",
            result.success, result.error
        );

        // Mark job as completed in the registry (frees capacity)
        debug!(
            "[ACK_JOB] Marking job {} as completed in registry",
            req.job_id
        );
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

        // Determine expected status for response (optimization: don't wait for DB)
        let (new_status, next_attempt, next_run_at) = match &job_result {
            JobResult::Success { .. } => (proto::JobStatus::Success, 0, 0),
            JobResult::Failed { should_retry, .. } => {
                if *should_retry {
                    // We don't know exact backoff without job options, but client needs something.
                    // We can just imply PENDING. The client doesn't crucially depend on exact next run time for simple workers.
                    (proto::JobStatus::Pending, 0, 0)
                } else {
                    (proto::JobStatus::Dead, 0, 0)
                }
            }
        };

        // Send to batch processor
        let (tx, _rx) = tokio::sync::oneshot::channel();
        if let Err(e) = self.ack_tx.send((req.job_id.clone(), job_result, tx)).await {
            error!("Failed to queue ack for job {}: {}", req.job_id, e);
            return Err(Status::internal("Failed to queue acknowledgment"));
        }

        // NOT waiting for rx (fire and forget for throughput)
        // await rx is optional here. If we strictly needed consistency we'd wait.

        // Notify scheduler that a worker has capacity again
        self.scheduler_notify.notify_one();

        Ok(Response::new(AckResponse {
            new_status: new_status as i32,
            next_attempt,
            next_run_at,
        }))
    }

    async fn get_job(
        &self,
        request: Request<GetJobRequest>,
    ) -> Result<Response<proto::Job>, Status> {
        let job_id = request.into_inner().job_id;
        debug!("[GET_JOB] Trying to fetch get job for job_id={}", job_id);
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
        debug!("[CANCEL_JOB] Trying to cancel job for job_id={}", job_id);
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
        debug!("[LIST_JOBS] Trying to list jobs with filter");
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

    type SubscribeToJobsStream =
        Pin<Box<dyn Stream<Item = Result<proto::JobCompletion, Status>> + Send>>;

    async fn subscribe_to_jobs(
        &self,
        request: Request<Streaming<SubscribeRequest>>,
    ) -> Result<Response<Self::SubscribeToJobsStream>, Status> {
        let mut in_stream = request.into_inner();
        // Increase channel capacity to handle high-throughput bursts (fixes dropped notifications)
        let (tx, rx) = mpsc::channel::<proto::JobCompletion>(10000);
        let subscribers = self.job_subscribers.clone();
        let completion_cache = self.completed_jobs_cache.clone();
        debug!("[SUBSCRIBE_TO_JOB] Trying to subscribe");
        // Spawn task to handle subscription requests
        tokio::spawn(async move {
            while let Some(req_result) = in_stream.next().await {
                match req_result {
                    Ok(req) => {
                        let mut subs = subscribers.write().await;
                        let mut cache = completion_cache.write().await;
                        debug!(
                            "[SUBSCRIBE_TO_JOB] Subscribe to following count of jobs = {}",
                            req.job_ids.len()
                        );
                        for job_id in req.job_ids {
                            if req.unsubscribe {
                                // Remove this sender from the job's subscribers
                                if let Some(_senders) = subs.get_mut(&job_id) {
                                    // Note: We can't easily remove tx by value, so we rely on cleanup on drop
                                    debug!("Client unsubscribing from job {}", job_id);
                                }
                            } else {
                                // Check cache first - completion might have arrived before subscription
                                if let Some(cached) = cache.remove(&job_id) {
                                    debug!(
                                        "Delivering cached completion for job {} (was waiting)",
                                        job_id
                                    );
                                    if let Err(e) = tx.try_send(cached.completion) {
                                        warn!("Failed to deliver cached completion for job {}: channel full/closed ({})", job_id, e);
                                    }
                                } else {
                                    // Add this sender to the job's subscribers
                                    subs.entry(job_id.clone())
                                        .or_insert_with(Vec::new)
                                        .push(tx.clone());
                                    debug!("Client subscribed to job {}", job_id);
                                }
                            }
                        }
                    }
                    Err(e) => {
                        warn!("Error reading subscription request: {}", e);
                        break;
                    }
                }
            }
            debug!("Subscription stream closed");
        });

        let out_stream = ReceiverStream::new(rx);
        Ok(Response::new(Box::pin(out_stream.map(Ok))))
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
