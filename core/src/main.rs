//! Reseolio Core - The Durable Execution for Modern Backends
//!
//! This is the main entry point for the reseolio-core binary.
//! It starts the gRPC server and push-based job scheduler.
//!
//! ## Architecture
//!
//! The push-based architecture consists of:
//! - **Worker Registry**: Tracks connected workers and their capacity
//! - **Scheduler**: Fetches pending jobs and pushes them to workers
//! - **gRPC Server**: Handles job enqueue, ack, and worker connections
//!
//! ```text
//! ┌─────────────────────────────────────────────────────────────┐
//! │                       main.rs                                │
//! │                                                              │
//! │  ┌──────────────────────────────────────────────────────┐   │
//! │  │                  Shared Components                    │   │
//! │  │  - WorkerRegistry (Arc)                               │   │
//! │  │  - Storage (Clone)                                    │   │
//! │  │  - Scheduler Notify (Arc<Notify>)                     │   │
//! │  └──────────────────────────────────────────────────────┘   │
//! │                          │                                   │
//! │         ┌────────────────┴────────────────┐                 │
//! │         ▼                                 ▼                 │
//! │  ┌──────────────────┐          ┌──────────────────┐        │
//! │  │    Scheduler     │          │   gRPC Server    │        │
//! │  │  (push jobs to   │          │  (register       │        │
//! │  │   workers)       │          │   workers,       │        │
//! │  └──────────────────┘          │   enqueue jobs)  │        │
//! │                                └──────────────────┘        │
//! └─────────────────────────────────────────────────────────────┘
//! ```

mod error;
mod metrics;
mod scheduler;
mod server;
mod storage;

use clap::Parser;
use scheduler::WorkerRegistry;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use storage::Storage;
use tokio::sync::Notify;
use tracing::info;

/// The Durable Execution for Modern Backends
///
/// Reseolio is a lightweight sidecar for durable function execution.
/// It persists function calls to SQLite and ensures they run to completion,
/// even across server restarts.
///
/// TODO: Leader Election for HA
/// In production multi-node deployments, implement leader election to ensure
/// only one scheduler is active at a time. See scheduler/mod.rs for details.
#[derive(Parser, Debug)]
#[command(name = "reseolio")]
#[command(author, version, about, long_about = None)]
struct Config {
    /// Connection string for storage.
    /// Supports 'sqlite://path/to/db' or 'postgres://user:pass@host/db'.
    /// Default matches file path behavior for backward compat if no prefix.
    #[arg(
        short = 'd',
        long,
        env = "RESEOLIO_DB",
        default_value = "sqlite://reseolio.db",
        help = "Database connection string (sqlite:// or postgres://)"
    )]
    database_url: String,

    /// Address to bind the gRPC server to
    #[arg(
        short = 'a',
        long,
        env = "RESEOLIO_ADDR",
        default_value = "127.0.0.1:50051",
        help = "Address to listen on (format: host:port)"
    )]
    listen_addr: String,

    /// Maximum number of concurrent jobs to process
    #[arg(
        short = 'c',
        long,
        env = "RESEOLIO_MAX_CONCURRENT",
        default_value_t = 100,
        help = "Maximum concurrent jobs"
    )]
    max_concurrent_jobs: usize,

    /// Scheduler poll interval in milliseconds
    #[arg(
        short = 'p',
        long,
        env = "RESEOLIO_POLL_INTERVAL",
        default_value_t = 50,
        help = "How often to check for pending jobs (ms)"
    )]
    poll_interval_ms: u64,

    /// Scheduler batch size (jobs to fetch per cycle)
    #[arg(
        short = 'b',
        long,
        env = "RESEOLIO_BATCH_SIZE",
        default_value_t = 100,
        help = "Number of pending jobs to fetch per scheduler cycle"
    )]
    batch_size: usize,

    /// Address for Prometheus metrics endpoint
    #[arg(
        long,
        env = "RESEOLIO_METRICS_ADDR",
        default_value = "0.0.0.0:9090",
        help = "Address for Prometheus metrics endpoint (format: host:port)"
    )]
    metrics_addr: String,

    /// Enable or disable Prometheus metrics
    #[arg(
        long,
        env = "RESEOLIO_METRICS_ENABLED",
        default_value_t = true,
        help = "Enable Prometheus metrics endpoint"
    )]
    metrics_enabled: bool,
}

async fn run_with_storage<S: Storage>(
    config: Config,
    storage: S,
    storage_type: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    // Run migrations
    storage.migrate().await?;
    info!("Database migrations complete");

    // Start recovery manager (reclaim stale jobs)
    let recovered = scheduler::recover_stale_jobs(&storage).await?;
    info!("Recovered {} stale jobs from previous run", recovered);

    // Create shared components for push-based architecture
    let registry = WorkerRegistry::new();
    let scheduler_notify = Arc::new(Notify::new());
    let cron_shutdown_notify = Arc::new(Notify::new());
    let job_shutdown_notify = Arc::new(Notify::new());

    // Initialize Prometheus metrics registry (always create, but only start server if enabled)
    let metrics_registry = Arc::new(metrics::MetricsRegistry::new(
        env!("CARGO_PKG_VERSION"),
        storage_type,
    ));

    // Start metrics HTTP server if enabled
    let metrics_handle = if config.metrics_enabled {
        let metrics_addr: SocketAddr = config.metrics_addr.parse()?;
        Some(metrics::start_metrics_server(metrics_registry.clone(), metrics_addr).await)
    } else {
        info!("Prometheus metrics disabled");
        None
    };

    // Start the push-based job scheduler
    let job_scheduler = scheduler::Scheduler::new(
        storage.clone(),
        registry.clone(),
        scheduler_notify.clone(),
        job_shutdown_notify.clone(),
    )
    .with_poll_interval(tokio::time::Duration::from_millis(config.poll_interval_ms))
    .with_batch_size(config.batch_size);

    let job_scheduler_handle = tokio::spawn(async move { job_scheduler.run().await });

    info!(
        "Push-based scheduler started (poll={}ms, batch={})",
        config.poll_interval_ms, config.batch_size
    );

    // Start the cron scheduler for recurring schedules
    // Using a 10-second poll interval - the gRPC service will pre-schedule
    // any jobs that would run before the next poll to prevent missed executions
    let schedule_poll_interval = tokio::time::Duration::from_secs(10);

    let cron_scheduler =
        scheduler::CronScheduler::new(storage.clone(), cron_shutdown_notify.clone())
            .with_poll_interval(schedule_poll_interval);

    let cron_scheduler_handle = tokio::spawn(async move { cron_scheduler.run().await });

    info!(
        "Cron scheduler started (poll={}s)",
        schedule_poll_interval.as_secs()
    );

    // Start gRPC server
    let addr: SocketAddr = config.listen_addr.parse()?;
    info!("gRPC server listening on {}", addr);

    // Pass the schedule poll interval and metrics to the server
    let poll_interval_std = std::time::Duration::from_secs(schedule_poll_interval.as_secs());
    server::serve(
        storage,
        registry,
        scheduler_notify,
        addr,
        poll_interval_std,
        metrics_registry,
    )
    .await?;

    // Graceful shutdown
    // Wait for Ctrl+C signal
    match tokio::signal::ctrl_c().await {
        Ok(()) => info!("Received shutdown signal..."),
        Err(err) => tracing::error!("Unable to listen for shutdown signal: {}", err),
    }

    info!("Initiating graceful shutdown...");

    // 1. Signal the components to stop
    job_shutdown_notify.notify_one();
    cron_shutdown_notify.notify_one();

    // 2. Wait for them to finish their current iteration
    // We use join! to wait for both, with a timeout just in case they get stuck
    let shutdown_timeout = tokio::time::Duration::from_secs(5);

    let shutdown_results = tokio::time::timeout(shutdown_timeout, async {
        tokio::join!(job_scheduler_handle, cron_scheduler_handle)
    })
    .await;

    match shutdown_results {
        Ok(_) => info!("Schedulers executed graceful shutdown"),
        Err(_) => {
            tracing::warn!("Shutdown timed out, forcing exit");
        }
    }

    if let Some(handle) = metrics_handle {
        handle.abort();
    }
    info!("Reseolio Core shutdown complete");

    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize logging with environment-based level
    // Respects RUST_LOG env var (e.g., RUST_LOG=debug)
    let log_level = std::env::var("RUST_LOG")
        .or_else(|_| std::env::var("RESEOLIO_LOG_LEVEL"))
        .unwrap_or_else(|_| "info".to_string());

    // Initialize OpenTelemetry
    use opentelemetry_otlp::WithExportConfig;
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt; // Needed for with_endpoint

    // Set propagator to support W3C Trace Context (traceparent header)
    opentelemetry::global::set_text_map_propagator(
        opentelemetry_sdk::propagation::TraceContextPropagator::new(),
    );

    // Check for OTLP endpoint (filter out empty strings)
    let otlp_endpoint = std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT")
        .ok()
        .filter(|s| !s.trim().is_empty());

    // Create the formatting layer (logs)
    let fmt_layer = tracing_subscriber::fmt::layer()
        .with_target(true)
        .with_level(true)
        .json();

    let subscriber =
        tracing_subscriber::registry().with(tracing_subscriber::EnvFilter::from_env("RUST_LOG"));

    if let Some(endpoint) = otlp_endpoint {
        info!(
            "Initializing OpenTelemetry tracer with OTLP endpoint: {}",
            endpoint
        );

        let tracer = opentelemetry_otlp::new_pipeline()
            .tracing()
            .with_exporter(
                opentelemetry_otlp::new_exporter()
                    .tonic()
                    .with_endpoint(endpoint),
            )
            .with_trace_config(opentelemetry_sdk::trace::config().with_resource(
                opentelemetry_sdk::Resource::new(vec![opentelemetry::KeyValue::new(
                    "service.name",
                    "reseolio-core",
                )]),
            ))
            .install_batch(opentelemetry_sdk::runtime::Tokio)
            .expect("Failed to initialize OpenTelemetry");

        let telemetry = tracing_opentelemetry::layer().with_tracer(tracer);

        subscriber.with(fmt_layer).with(telemetry).init();
    } else {
        subscriber.with(fmt_layer).init();
    }

    info!(
        "Starting Reseolio Core v{} (log_level={})",
        env!("CARGO_PKG_VERSION"),
        log_level
    );

    // Parse configuration from CLI args and environment variables
    let config = Config::parse();

    if config.database_url.starts_with("postgres://") {
        #[cfg(feature = "postgres")]
        {
            let storage = storage::PostgresStorage::new(&config.database_url).await?;
            info!("Initialized PostgreSQL storage");
            run_with_storage(config, storage, "postgres").await?;
        }
        #[cfg(not(feature = "postgres"))]
        {
            return Err("PostgreSQL support not enabled. Compile with --features postgres".into());
        }
    } else {
        // Assume SQLite
        let path_str = config.database_url.trim_start_matches("sqlite://");
        let path = PathBuf::from(path_str);

        // Handle explicit sqlite:// or implicit file path
        let storage = storage::SqliteStorage::new(&path).await?;
        info!("Initialized SQLite storage: {}", path.display());
        run_with_storage(config, storage, "sqlite").await?;
    }

    Ok(())
}
