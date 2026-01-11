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
    /// Path to SQLite database file
    #[arg(
        short = 'd',
        long,
        env = "RESEOLIO_DB",
        default_value = "reseolio.db",
        help = "Path to SQLite database file"
    )]
    database_path: PathBuf,

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

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize logging
    let _subscriber = FmtSubscriber::builder()
        .with_max_level(Level::INFO)
        .json()
        .init();

    info!("Starting Reseolio Core v{}", env!("CARGO_PKG_VERSION"));

    // Parse configuration from CLI args and environment variables
    let config = Config::parse();

    // Initialize storage
    let storage = storage::SqliteStorage::new(&config.database_path).await?;
    info!("Storage initialized: {}", config.database_path.display());

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
