#[cfg(feature = "tracing")]
use crate::tracing_support::{init_tracing, shutdown_tracing};
use crate::{
    durable::DurableFunction,
    error::{ReseolioError, Result},
    proto,
    schedule::ScheduleHandle,
    types::*,
};
use futures::Future;
use std::collections::{HashMap, HashSet};
use std::pin::Pin;
use std::sync::Arc;
use tokio::sync::{broadcast, oneshot, Mutex, RwLock};
use tonic::transport::Channel;

type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Configuration for the Reseolio client
#[derive(Debug, Clone)]
pub struct ReseolioConfig {
    /// Storage connection string (default: "sqlite://./reseolio.db")
    pub storage: Option<String>,
    /// Address for gRPC server (default: "127.0.0.1:50051")
    pub address: Option<String>,
    /// Number of concurrent jobs to process (default: 10)
    pub worker_concurrency: Option<u32>,
    /// Path to reseolio-core binary (auto-detected if not specified)
    pub core_binary_path: Option<String>,
    /// Whether to auto-start the core process (default: true)
    pub auto_start: Option<bool>,
}

impl Default for ReseolioConfig {
    fn default() -> Self {
        Self {
            storage: None,
            address: None,
            worker_concurrency: None,
            core_binary_path: None,
            auto_start: None,
        }
    }
}

#[derive(Debug, Clone)]
struct ResolvedConfig {
    storage: String,
    address: String,
    worker_concurrency: u32,
    core_binary_path: String,
    auto_start: bool,
}

impl From<ReseolioConfig> for ResolvedConfig {
    fn from(config: ReseolioConfig) -> Self {
        Self {
            storage: config
                .storage
                .unwrap_or_else(|| "sqlite://./reseolio.db".to_string()),
            address: config
                .address
                .unwrap_or_else(|| "127.0.0.1:50051".to_string()),
            worker_concurrency: config.worker_concurrency.unwrap_or(10),
            core_binary_path: config
                .core_binary_path
                .unwrap_or_else(|| find_core_binary()),
            auto_start: config.auto_start.unwrap_or(true),
        }
    }
}

#[derive(Clone)]
struct RegisteredFunction {
    handler: Arc<
        dyn Fn(Vec<u8>) -> BoxFuture<'static, std::result::Result<Vec<u8>, String>> + Send + Sync,
    >,
    options: DurableOptions,
}

#[derive(Debug, Clone)]
pub enum ReseolioEvent {
    Ready,
    Stopped,
    JobStart { job_id: String, name: String },
    JobSuccess { job_id: String, result: Vec<u8> },
    JobError { job_id: String, error: String },
    JobDead { job_id: String },
    Deduplicated { job_id: String },
}

/// The main Reseolio client
pub struct Reseolio {
    inner: Arc<ReseolioInner>,
}

pub(crate) struct ReseolioInner {
    config: ResolvedConfig,
    worker_id: String,
    grpc_client: RwLock<Option<proto::ReseolioClient<Channel>>>,
    connected: RwLock<bool>,
    registry: RwLock<HashMap<String, RegisteredFunction>>,
    active_jobs: RwLock<HashSet<String>>,
    subscribed_jobs: RwLock<HashSet<String>>,
    pending_results: RwLock<HashMap<String, oneshot::Sender<std::result::Result<Vec<u8>, String>>>>,
    completed_results: RwLock<HashMap<String, std::result::Result<Vec<u8>, String>>>,
    event_tx: broadcast::Sender<ReseolioEvent>,
    core_process: Mutex<Option<tokio::process::Child>>,
    shutdown_tx: RwLock<Option<broadcast::Sender<()>>>,
}

impl ReseolioInner {
    #[cfg(test)]
    pub(crate) fn default_for_test() -> Self {
        let (tx, _) = broadcast::channel(100);
        Self {
            config: ResolvedConfig {
                storage: "sqlite://./test.db".to_string(),
                address: "127.0.0.1:50051".to_string(),
                worker_concurrency: 10,
                core_binary_path: "reseolio".to_string(),
                auto_start: false,
            },
            worker_id: "test-worker".to_string(),
            grpc_client: RwLock::new(None),
            connected: RwLock::new(false),
            registry: RwLock::new(HashMap::new()),
            active_jobs: RwLock::new(HashSet::new()),
            subscribed_jobs: RwLock::new(HashSet::new()),
            pending_results: RwLock::new(HashMap::new()),
            completed_results: RwLock::new(HashMap::new()),
            event_tx: tx,
            core_process: Mutex::new(None),
            shutdown_tx: RwLock::new(None),
        }
    }
}

impl Reseolio {
    /// Create a new Reseolio client
    pub fn new(config: ReseolioConfig) -> Self {
        let (event_tx, _) = broadcast::channel(100);
        let worker_id = format!(
            "worker-{}",
            uuid::Uuid::new_v4().simple().to_string()[..8].to_string()
        );

        Self {
            inner: Arc::new(ReseolioInner {
                config: config.into(),
                worker_id,
                grpc_client: RwLock::new(None),
                connected: RwLock::new(false),
                registry: RwLock::new(HashMap::new()),
                active_jobs: RwLock::new(HashSet::new()),
                subscribed_jobs: RwLock::new(HashSet::new()),
                pending_results: RwLock::new(HashMap::new()),
                completed_results: RwLock::new(HashMap::new()),
                event_tx,
                core_process: Mutex::new(None),
                shutdown_tx: RwLock::new(None),
            }),
        }
    }

    /// Start the client and connect to the core
    pub async fn start(&self) -> Result<()> {
        tracing::debug!("starting client: {}", self.inner.worker_id);

        // Start core process if auto-start is enabled
        if self.inner.config.auto_start {
            self.start_core().await?;
        }

        // Connect to gRPC server
        self.connect().await?;

        self.start_internal().await
    }

    /// Start the client with a custom channel (useful for testing)
    #[doc(hidden)]
    pub async fn start_with_channel(&self, channel: Channel) -> Result<()> {
        let client = proto::ReseolioClient::new(channel);
        *self.inner.grpc_client.write().await = Some(client);
        *self.inner.connected.write().await = true;

        self.start_internal().await
    }

    async fn start_internal(&self) -> Result<()> {
        // Create shutdown channel
        let (shutdown_tx, _) = broadcast::channel(1);
        *self.inner.shutdown_tx.write().await = Some(shutdown_tx.clone());

        // Start worker loop and subscription stream
        self.start_worker_loop();
        self.start_subscription_stream();

        self.emit(ReseolioEvent::Ready);
        tracing::debug!("client started successfully: {}", self.inner.worker_id);

        Ok(())
    }

    /// Stop the client gracefully
    pub async fn stop(&self) -> Result<()> {
        tracing::debug!("stopping client: {}", self.inner.worker_id);

        // Wait for active jobs to finish (with timeout)
        let max_wait = tokio::time::Duration::from_secs(5);
        let start = tokio::time::Instant::now();

        while !self.inner.active_jobs.read().await.is_empty() && start.elapsed() < max_wait {
            tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        }

        let active_count = self.inner.active_jobs.read().await.len();
        if active_count > 0 {
            tracing::warn!("{} jobs still active during shutdown", active_count);
        }

        // Grace period for in-flight messages
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

        // Send shutdown signal
        if let Some(shutdown_tx) = self.inner.shutdown_tx.read().await.as_ref() {
            let _ = shutdown_tx.send(());
        }

        // Stop core process
        if let Some(mut process) = self.inner.core_process.lock().await.take() {
            let _ = process.kill().await;
        }

        *self.inner.connected.write().await = false;
        self.emit(ReseolioEvent::Stopped);
        tracing::debug!("stopped client successfully: {}", self.inner.worker_id);

        Ok(())
    }

    /// Create a namespaced function name
    pub fn namespace(&self, parts: &[&str]) -> Result<String> {
        if parts.is_empty() {
            return Err(ReseolioError::InvalidNamespace(
                "namespace() requires at least one part".to_string(),
            ));
        }

        for part in parts {
            if part.is_empty() {
                return Err(ReseolioError::InvalidNamespace(
                    "All namespace parts must be non-empty strings".to_string(),
                ));
            }
            if part.contains(':') || part.contains('/') {
                return Err(ReseolioError::InvalidNamespace(format!(
                    "Namespace part '{}' cannot contain ':' or '/'",
                    part
                )));
            }
        }

        Ok(parts.join(":"))
    }

    /// Register a durable function
    pub fn durable<F, Fut, Args, Ret>(
        &self,
        name: &str,
        handler: F,
        options: DurableOptions,
    ) -> DurableFunction<Args, Ret>
    where
        F: Fn(Args) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Ret> + Send + 'static,
        Args: serde::de::DeserializeOwned + serde::Serialize + Send + 'static,
        Ret: serde::Serialize + serde::de::DeserializeOwned + Send + 'static,
    {
        // Validate name
        if name.is_empty() {
            panic!("Function name must be a non-empty string");
        }

        // Warn if not namespaced
        if !name.contains(':') && !name.contains('/') {
            tracing::warn!(
                "Function '{}' is not namespaced. This may cause name collisions. \
                 Recommended: use namespace() helper or pattern 'module:service:{}'",
                name,
                name
            );
        }

        // Check for collisions
        let mut registry = futures::executor::block_on(self.inner.registry.write());
        if registry.contains_key(name) {
            panic!("Function '{}' is already registered", name);
        }

        // Wrap handler to work with Vec<u8>
        let wrapped_handler = Arc::new(move |args_bytes: Vec<u8>| {
            let args: Args =
                serde_json::from_slice(&args_bytes).expect("Failed to deserialize args");
            let fut = handler(args);
            Box::pin(async move {
                let result = fut.await;
                serde_json::to_vec(&result).map_err(|e| e.to_string())
            }) as BoxFuture<'static, std::result::Result<Vec<u8>, String>>
        });

        registry.insert(
            name.to_string(),
            RegisteredFunction {
                handler: wrapped_handler,
                options: options.clone(),
            },
        );

        DurableFunction::new(name.to_string(), options, Arc::clone(&self.inner))
    }

    /// Subscribe to events
    pub fn subscribe(&self) -> broadcast::Receiver<ReseolioEvent> {
        self.inner.event_tx.subscribe()
    }

    fn emit(&self, event: ReseolioEvent) {
        let _ = self.inner.event_tx.send(event);
    }

    // Private methods will be implemented below
    async fn start_core(&self) -> Result<()> {
        use std::process::Stdio;
        use tokio::process::Command;

        let mut cmd = Command::new(&self.inner.config.core_binary_path);
        cmd.env(
            "RESEOLIO_DB",
            self.inner.config.storage.replace("sqlite://", ""),
        )
        .env("RESEOLIO_ADDR", &self.inner.config.address)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

        let child = cmd.spawn().map_err(|e| {
            ReseolioError::CoreProcessError(format!("Failed to start core process: {}", e))
        })?;

        *self.inner.core_process.lock().await = Some(child);

        // Wait for server to be ready
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

        Ok(())
    }

    async fn connect(&self) -> Result<()> {
        let endpoint = format!("http://{}", self.inner.config.address);
        let channel = Channel::from_shared(endpoint)
            .map_err(|e| ReseolioError::ConnectionFailed(format!("Invalid endpoint: {}", e)))?
            .connect()
            .await?;

        let client = proto::ReseolioClient::new(channel);
        *self.inner.grpc_client.write().await = Some(client);
        *self.inner.connected.write().await = true;

        Ok(())
    }

    fn start_worker_loop(&self) {
        let inner = Arc::clone(&self.inner);

        tokio::spawn(async move {
            loop {
                if !*inner.connected.read().await {
                    break;
                }

                match inner.clone().run_worker_loop().await {
                    Ok(()) => break,
                    Err(e) => {
                        if *inner.connected.read().await {
                            tracing::error!("Worker loop error: {}. Reconnecting in 1s...", e);
                            tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
                        } else {
                            break;
                        }
                    }
                }
            }
        });
    }

    fn start_subscription_stream(&self) {
        let inner = Arc::clone(&self.inner);

        tokio::spawn(async move {
            loop {
                if !*inner.connected.read().await {
                    break;
                }

                match inner.run_subscription_stream().await {
                    Ok(()) => break,
                    Err(e) => {
                        if *inner.connected.read().await {
                            tracing::error!(
                                "Subscription stream error: {}. Reconnecting in 1s...",
                                e
                            );
                            tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
                        } else {
                            break;
                        }
                    }
                }
            }
        });
    }
}

fn find_core_binary() -> String {
    let platform = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    let extension = if platform == "windows" { ".exe" } else { "" };

    let binary_name = format!("reseolio-{}-{}{}", platform, arch, extension);

    // Check for bundled binary
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let bundled_path = exe_dir.join("../vendor").join(&binary_name);
            if bundled_path.exists() {
                return bundled_path.to_string_lossy().to_string();
            }
        }
    }

    // Check for local dev path
    let dev_path = format!("../../core/target/release/reseolio{}", extension);
    if std::path::Path::new(&dev_path).exists() {
        return dev_path;
    }

    // Fallback to PATH
    format!("reseolio{}", extension)
}

// Implementation of ReseolioInner methods
impl ReseolioInner {
    pub(crate) async fn enqueue<T: serde::Serialize>(
        &self,
        name: &str,
        args: &T,
        options: JobOptions,
    ) -> Result<String> {
        let client_guard = self.grpc_client.read().await;
        let mut client = client_guard
            .as_ref()
            .ok_or(ReseolioError::NotConnected)?
            .clone();

        let args_bytes = serde_json::to_vec(args)?;

        let request = proto::EnqueueRequest {
            name: name.to_string(),
            args: args_bytes.into(),
            options: Some(proto::JobOptions {
                max_attempts: options.max_attempts.unwrap_or(0) as i32,
                backoff: options
                    .backoff
                    .map(|b| b.as_str().to_string())
                    .unwrap_or_default(),
                initial_delay_ms: options.initial_delay_ms.unwrap_or(0) as i32,
                max_delay_ms: options.max_delay_ms.unwrap_or(0) as i32,
                timeout_ms: options.timeout_ms.unwrap_or(0) as i32,
                jitter: options.jitter.unwrap_or(0.0),
            }),
            idempotency_key: options.idempotency_key.unwrap_or_default(),
        };

        let response = client.enqueue_job(request).await?.into_inner();

        Ok(response.job_id)
    }

    pub(crate) async fn get_job(&self, job_id: &str) -> Result<Job> {
        let client_guard = self.grpc_client.read().await;
        let mut client = client_guard
            .as_ref()
            .ok_or(ReseolioError::NotConnected)?
            .clone();

        let request = proto::GetJobRequest {
            job_id: job_id.to_string(),
        };

        let response = client.get_job(request).await?.into_inner();

        Ok(Job {
            id: response.id,
            name: response.name,
            args: response.args,
            attempt: response.attempt as u32,
            deadline_ms: response.deadline_ms,
            status: JobStatus::from(response.status),
            error: if response.error.is_empty() {
                None
            } else {
                Some(response.error)
            },
            result: if response.result.is_empty() {
                None
            } else {
                Some(response.result)
            },
            created_at: response.created_at,
            scheduled_at: response.scheduled_at,
            started_at: if response.started_at == 0 {
                None
            } else {
                Some(response.started_at)
            },
            completed_at: if response.completed_at == 0 {
                None
            } else {
                Some(response.completed_at)
            },
            max_attempts: response.max_attempts as u32,
        })
    }

    pub(crate) async fn cancel_job(&self, job_id: &str) -> Result<bool> {
        let client_guard = self.grpc_client.read().await;
        let mut client = client_guard
            .as_ref()
            .ok_or(ReseolioError::NotConnected)?
            .clone();

        let request = proto::CancelRequest {
            job_id: job_id.to_string(),
        };

        let response = client.cancel_job(request).await?.into_inner();

        Ok(response.success)
    }

    pub(crate) async fn subscribe_to_job(
        &self,
        job_id: &str,
    ) -> Result<std::result::Result<Vec<u8>, String>> {
        let (tx, rx) = oneshot::channel();
        self.pending_results
            .write()
            .await
            .insert(job_id.to_string(), tx);

        rx.await
            .map_err(|_| ReseolioError::JobFailed("Subscription cancelled".to_string()))
    }

    pub(crate) async fn try_get_result(
        &self,
        job_id: &str,
    ) -> Option<std::result::Result<Vec<u8>, String>> {
        self.completed_results.write().await.remove(job_id)
    }

    pub(crate) async fn create_schedule<T: serde::Serialize>(
        self: &Arc<Self>,
        name: &str,
        options: ScheduleOptions,
        args: &T,
    ) -> Result<ScheduleHandle> {
        let client_guard = self.grpc_client.read().await;
        let mut client = client_guard
            .as_ref()
            .ok_or(ReseolioError::NotConnected)?
            .clone();

        let args_bytes = serde_json::to_vec(args)?;

        let request = proto::CreateScheduleRequest {
            name: name.to_string(),
            cron_expression: options.cron,
            timezone: options.timezone.unwrap_or_else(|| "UTC".to_string()),
            handler_options: options.handler_options.map(|opts| proto::JobOptions {
                max_attempts: opts.max_attempts.unwrap_or(0) as i32,
                backoff: opts
                    .backoff
                    .map(|b| b.as_str().to_string())
                    .unwrap_or_default(),
                initial_delay_ms: opts.initial_delay_ms.unwrap_or(0) as i32,
                max_delay_ms: opts.max_delay_ms.unwrap_or(0) as i32,
                timeout_ms: opts.timeout_ms.unwrap_or(0) as i32,
                jitter: opts.jitter.unwrap_or(0.0),
            }),
            args: args_bytes.into(),
        };

        let response = client.create_schedule(request).await?.into_inner();

        Ok(ScheduleHandle::new(
            response.id.clone(),
            response.name.clone(),
            Arc::clone(self),
        ))
    }

    pub(crate) async fn get_schedule(&self, schedule_id: &str) -> Result<Schedule> {
        let client_guard = self.grpc_client.read().await;
        let mut client = client_guard
            .as_ref()
            .ok_or(ReseolioError::NotConnected)?
            .clone();

        let request = proto::GetScheduleRequest {
            schedule_id: schedule_id.to_string(),
        };

        let response = client.get_schedule(request).await?.into_inner();

        Ok(proto_to_schedule(response))
    }

    pub(crate) async fn pause_schedule(&self, schedule_id: &str) -> Result<Schedule> {
        let client_guard = self.grpc_client.read().await;
        let mut client = client_guard
            .as_ref()
            .ok_or(ReseolioError::NotConnected)?
            .clone();

        let request = proto::PauseScheduleRequest {
            schedule_id: schedule_id.to_string(),
        };

        let response = client.pause_schedule(request).await?.into_inner();

        Ok(proto_to_schedule(response))
    }

    pub(crate) async fn resume_schedule(&self, schedule_id: &str) -> Result<Schedule> {
        let client_guard = self.grpc_client.read().await;
        let mut client = client_guard
            .as_ref()
            .ok_or(ReseolioError::NotConnected)?
            .clone();

        let request = proto::ResumeScheduleRequest {
            schedule_id: schedule_id.to_string(),
        };

        let response = client.resume_schedule(request).await?.into_inner();

        Ok(proto_to_schedule(response))
    }

    pub(crate) async fn update_schedule(
        &self,
        schedule_id: &str,
        options: UpdateScheduleOptions,
    ) -> Result<Schedule> {
        let client_guard = self.grpc_client.read().await;
        let mut client = client_guard
            .as_ref()
            .ok_or(ReseolioError::NotConnected)?
            .clone();

        let request = proto::UpdateScheduleRequest {
            schedule_id: schedule_id.to_string(),
            cron_expression: options.cron.unwrap_or_default(),
            timezone: options.timezone.unwrap_or_default(),
            handler_options: options.handler_options.map(|opts| proto::JobOptions {
                max_attempts: opts.max_attempts.unwrap_or(0) as i32,
                backoff: opts
                    .backoff
                    .map(|b| b.as_str().to_string())
                    .unwrap_or_default(),
                initial_delay_ms: opts.initial_delay_ms.unwrap_or(0) as i32,
                max_delay_ms: opts.max_delay_ms.unwrap_or(0) as i32,
                timeout_ms: opts.timeout_ms.unwrap_or(0) as i32,
                jitter: opts.jitter.unwrap_or(0.0),
            }),
        };

        let response = client.update_schedule(request).await?.into_inner();

        Ok(proto_to_schedule(response))
    }

    pub(crate) async fn delete_schedule(&self, schedule_id: &str) -> Result<bool> {
        let client_guard = self.grpc_client.read().await;
        let mut client = client_guard
            .as_ref()
            .ok_or(ReseolioError::NotConnected)?
            .clone();

        let request = proto::DeleteScheduleRequest {
            schedule_id: schedule_id.to_string(),
        };

        let response = client.delete_schedule(request).await?.into_inner();

        Ok(response.success)
    }

    // Worker loop implementation
    #[cfg_attr(feature = "tracing", tracing::instrument(skip(self), fields(worker_id = %self.worker_id)))]
    async fn run_worker_loop(self: Arc<Self>) -> Result<()> {
        use futures::stream::StreamExt;
        use tokio::sync::mpsc;

        let client_guard = self.grpc_client.read().await;
        let mut client = client_guard
            .as_ref()
            .ok_or(ReseolioError::NotConnected)?
            .clone();
        drop(client_guard);

        // Create a channel for outbound messages
        let (tx, rx) = mpsc::channel(32);
        let rx_stream = tokio_stream::wrappers::ReceiverStream::new(rx);

        // Start bidirectional stream
        let mut stream = client.poll_jobs(rx_stream).await?.into_inner();

        // Send initial poll request
        let registry_guard = self.registry.read().await;
        let names: Vec<String> = registry_guard.keys().cloned().collect();
        drop(registry_guard);

        tx.send(proto::PollRequest {
            worker_id: self.worker_id.clone(),
            names,
            concurrency: self.config.worker_concurrency as i32,
        })
        .await
        .map_err(|e| ReseolioError::Internal(e.to_string()))?;

        // Process incoming jobs
        while let Some(job_message) = stream.next().await {
            let job = job_message?;

            // Execute job in a separate task (fire-and-forget for concurrency)
            let inner_clone = self.clone();
            tokio::spawn(async move {
                if let Err(e) = inner_clone.execute_job(job).await {
                    tracing::error!("Job execution error: {}", e);
                    let _ = inner_clone.event_tx.send(ReseolioEvent::JobError {
                        job_id: "unknown".to_string(),
                        error: e.to_string(),
                    });
                }
            });
        }

        Ok(())
    }

    // Subscription stream implementation
    #[cfg_attr(feature = "tracing", tracing::instrument(skip(self)))]
    async fn run_subscription_stream(&self) -> Result<()> {
        use futures::stream::StreamExt;
        use tokio::sync::mpsc;

        let client_guard = self.grpc_client.read().await;
        let mut client = client_guard
            .as_ref()
            .ok_or(ReseolioError::NotConnected)?
            .clone();
        drop(client_guard);

        // Create channel for subscription requests
        let (tx, rx) = mpsc::channel(32);
        let rx_stream = tokio_stream::wrappers::ReceiverStream::new(rx);

        // Start bidirectional stream
        let mut stream = client.subscribe_to_jobs(rx_stream).await?.into_inner();

        // Resubscribe to all tracked jobs (important for reconnects)
        let subscribed_guard = self.subscribed_jobs.read().await;
        let job_ids: Vec<String> = subscribed_guard.iter().cloned().collect();
        drop(subscribed_guard);

        if !job_ids.is_empty() {
            tx.send(proto::SubscribeRequest {
                job_ids: job_ids.clone(),
                unsubscribe: false,
            })
            .await
            .map_err(|e| ReseolioError::Internal(e.to_string()))?;

            tracing::debug!(
                "Resubscribed to {} jobs after stream restart",
                job_ids.len()
            );
        }

        // Process incoming job completions
        while let Some(completion_message) = stream.next().await {
            let completion = completion_message?;
            let job_id = completion.job_id.clone();

            // Remove from subscribed set
            self.subscribed_jobs.write().await.remove(&job_id);

            // Determine result or error
            let mut result: Option<Vec<u8>> = None;
            let mut error: Option<String> = None;

            // Status: 3=SUCCESS, 5=DEAD, 6=CANCELLED
            let is_dead = completion.status == 5;
            let is_cancelled = completion.status == 6;

            if !completion.result.is_empty() {
                result = Some(completion.result.clone());
            } else if is_dead {
                error = Some(completion.error.clone());
            } else if is_cancelled {
                error = Some("Job was cancelled".to_string());
            }

            // Check if there's a pending result callback
            let mut pending_guard = self.pending_results.write().await;
            if let Some(resolve_tx) = pending_guard.remove(&job_id) {
                // Callback registered - resolve immediately
                drop(pending_guard);

                if let Some(err) = error.clone() {
                    let _ = resolve_tx.send(Err(err));
                } else {
                    let _ = resolve_tx.send(Ok(result.clone().unwrap_or_default()));
                }
            } else {
                // No callback yet - cache the result
                drop(pending_guard);

                let mut completed_guard = self.completed_results.write().await;
                if let Some(err) = error.clone() {
                    completed_guard.insert(job_id.clone(), Err(err));
                } else {
                    completed_guard.insert(job_id.clone(), Ok(result.clone().unwrap_or_default()));
                }
            }

            // Emit events
            if let Some(ref err) = error {
                let _ = self.event_tx.send(ReseolioEvent::JobError {
                    job_id: job_id.clone(),
                    error: err.clone(),
                });
                // Also emit job-specific event (for JobHandle)
                // Note: We'd need a more sophisticated event system to support this
                // For now, the JobHandle uses pending_results/completed_results
            } else {
                let _ = self.event_tx.send(ReseolioEvent::JobSuccess {
                    job_id: job_id.clone(),
                    result: result.clone().unwrap_or_default(),
                });
            }
        }

        Ok(())
    }

    // Execute a job
    #[cfg_attr(feature = "tracing", tracing::instrument(skip(self, job), fields(job_id = %job.id, job_name = %job.name, attempt = job.attempt)))]
    async fn execute_job(&self, job: proto::Job) -> Result<()> {
        let job_id = job.id.clone();
        let job_name = job.name.clone();

        #[cfg(feature = "tracing")]
        tracing::info!("Starting job execution");

        // Add to active jobs
        self.active_jobs.write().await.insert(job_id.clone());

        // Get the registered function
        let registry_guard = self.registry.read().await;
        let registration = registry_guard.get(&job_name).cloned();
        drop(registry_guard);

        let registration = match registration {
            Some(r) => r,
            None => {
                // Unknown function - ack with error
                self.ack_job(
                    &job_id,
                    false,
                    None,
                    Some(format!("Unknown function: {}", job_name)),
                    false,
                )
                .await?;
                self.active_jobs.write().await.remove(&job_id);
                return Ok(());
            }
        };

        // Emit job start event
        let _ = self.event_tx.send(ReseolioEvent::JobStart {
            job_id: job_id.clone(),
            name: job_name.clone(),
        });

        // Execute the handler
        let args_bytes = job.args.clone();
        let timeout_ms = registration.options.timeout_ms.unwrap_or(30000);
        let timeout_duration = tokio::time::Duration::from_millis(timeout_ms as u64);

        let execute_result =
            tokio::time::timeout(timeout_duration, (registration.handler)(args_bytes)).await;

        match execute_result {
            Ok(Ok(result_bytes)) => {
                // Success
                self.ack_job(&job_id, true, Some(result_bytes.clone()), None, false)
                    .await?;

                let _ = self.event_tx.send(ReseolioEvent::JobSuccess {
                    job_id: job_id.clone(),
                    result: result_bytes,
                });
            }
            Ok(Err(handler_error)) => {
                // Handler returnesd error
                let error_str = handler_error.clone();
                self.ack_job(&job_id, false, None, Some(error_str.clone()), true)
                    .await?;

                let _ = self.event_tx.send(ReseolioEvent::JobError {
                    job_id: job_id.clone(),
                    error: error_str,
                });
            }
            Err(_) => {
                // Timeout
                self.ack_job(&job_id, false, None, Some("Job timeout".to_string()), true)
                    .await?;

                let _ = self.event_tx.send(ReseolioEvent::JobError {
                    job_id: job_id.clone(),
                    error: "Job timeout".to_string(),
                });
            }
        }

        // Remove from active jobs
        self.active_jobs.write().await.remove(&job_id);

        Ok(())
    }

    // Acknowledge job completion
    async fn ack_job(
        &self,
        job_id: &str,
        success: bool,
        return_value: Option<Vec<u8>>,
        error: Option<String>,
        should_retry: bool,
    ) -> Result<()> {
        let client_guard = self.grpc_client.read().await;
        let mut client = client_guard
            .as_ref()
            .ok_or(ReseolioError::NotConnected)?
            .clone();
        drop(client_guard);

        let request = proto::AckRequest {
            job_id: job_id.to_string(),
            result: Some(proto::AckResult {
                success,
                return_value: return_value.unwrap_or_default(),
                error: error.unwrap_or_default(),
                should_retry,
            }),
        };

        client.ack_job(request).await?;

        Ok(())
    }
}

fn proto_to_schedule(proto: proto::Schedule) -> Schedule {
    Schedule {
        id: proto.id,
        name: proto.name,
        cron_expression: proto.cron_expression,
        timezone: proto.timezone,
        status: ScheduleStatus::from(proto.status),
        next_run_at: proto.next_run_at,
        last_run_at: if proto.last_run_at == 0 {
            None
        } else {
            Some(proto.last_run_at)
        },
        created_at: proto.created_at,
        updated_at: proto.updated_at,
        handler_options: proto.handler_options.map(|opts| JobOptions {
            max_attempts: if opts.max_attempts == 0 {
                None
            } else {
                Some(opts.max_attempts as u32)
            },
            backoff: if opts.backoff.is_empty() {
                None
            } else {
                match opts.backoff.as_str() {
                    "exponential" => Some(BackoffStrategy::Exponential),
                    "linear" => Some(BackoffStrategy::Linear),
                    "fixed" => Some(BackoffStrategy::Fixed),
                    _ => None,
                }
            },
            initial_delay_ms: if opts.initial_delay_ms == 0 {
                None
            } else {
                Some(opts.initial_delay_ms as u32)
            },
            max_delay_ms: if opts.max_delay_ms == 0 {
                None
            } else {
                Some(opts.max_delay_ms as u32)
            },
            timeout_ms: if opts.timeout_ms == 0 {
                None
            } else {
                Some(opts.timeout_ms as u32)
            },
            jitter: if opts.jitter == 0.0 {
                None
            } else {
                Some(opts.jitter)
            },
            idempotency_key: None,
        }),
        args: if proto.args.is_empty() {
            None
        } else {
            Some(proto.args)
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_namespace() {
        let client = Reseolio::new(ReseolioConfig::default());
        let name = client
            .namespace(&["billing", "subscription", "charge"])
            .unwrap();
        assert_eq!(name, "billing:subscription:charge");
    }

    #[test]
    fn test_namespace_invalid() {
        let client = Reseolio::new(ReseolioConfig::default());
        assert!(client.namespace(&[]).is_err());
        assert!(client.namespace(&["test:colon"]).is_err());
    }
}
