//! Reseolio Core - The SQLite of Durable Execution
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
use tracing::{info, Level};
use tracing_subscriber::FmtSubscriber;

/// The SQLite of Durable Execution
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
}

async fn run_with_storage<S: Storage>(
    config: Config,
    storage: S,
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

    // Start the push-based scheduler
    let scheduler =
        scheduler::Scheduler::new(storage.clone(), registry.clone(), scheduler_notify.clone())
            .with_poll_interval(tokio::time::Duration::from_millis(config.poll_interval_ms))
            .with_batch_size(config.batch_size);

    let scheduler_handle = tokio::spawn(async move { scheduler.run().await });

    info!(
        "Push-based scheduler started (poll={}ms, batch={})",
        config.poll_interval_ms, config.batch_size
    );

    // Start gRPC server
    let addr: SocketAddr = config.listen_addr.parse()?;
    info!("gRPC server listening on {}", addr);

    server::serve(storage, registry, scheduler_notify, addr).await?;

    scheduler_handle.abort();
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

    let level = match log_level.to_lowercase().as_str() {
        "trace" => Level::TRACE,
        "debug" => Level::DEBUG,
        "info" => Level::INFO,
        "warn" | "warning" => Level::WARN,
        "error" => Level::ERROR,
        _ => Level::INFO,
    };

    let _subscriber = FmtSubscriber::builder().with_max_level(level).json().init();

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
            run_with_storage(config, storage).await?;
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
        run_with_storage(config, storage).await?;
    }

    Ok(())
}
