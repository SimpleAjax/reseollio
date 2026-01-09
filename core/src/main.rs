//! Reseolio Core - The SQLite of Durable Execution
//!
//! This is the main entry point for the reseolio-core binary.
//! It starts the gRPC server and job scheduler.

mod error;
mod scheduler;
mod server;
mod storage;

use clap::Parser;
use std::net::SocketAddr;
use std::path::PathBuf;
use storage::Storage;
use tracing::{info, Level};
use tracing_subscriber::FmtSubscriber;

/// The SQLite of Durable Execution
///
/// Reseolio is a lightweight sidecar for durable function execution.
/// It persists function calls to SQLite and ensures they run to completion,
/// even across server restarts.
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
        default_value_t = 100,
        help = "How often to check for pending jobs (ms)"
    )]
    poll_interval_ms: u64,
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

    // Start the scheduler
    let scheduler = scheduler::Scheduler::new(storage.clone());
    let scheduler_handle = tokio::spawn(async move { scheduler.run().await });

    // Start gRPC server
    let addr: SocketAddr = config.listen_addr.parse()?;
    info!("gRPC server listening on {}", addr);

    let server = server::ReseolioServer::new(storage);
    server::serve(server, addr).await?;

    scheduler_handle.abort();
    info!("Reseolio Core shutdown complete");

    Ok(())
}
