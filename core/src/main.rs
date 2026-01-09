//! Reseolio Core - The SQLite of Durable Execution
//!
//! This is the main entry point for the reseolio-core binary.
//! It starts the gRPC server and job scheduler.

mod error;
mod scheduler;
mod server;
mod storage;

use std::net::SocketAddr;
use std::path::PathBuf;
use storage::Storage;
use tracing::{info, Level};
use tracing_subscriber::FmtSubscriber;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize logging
    let _subscriber = FmtSubscriber::builder()
        .with_max_level(Level::INFO)
        .json()
        .init();

    info!("Starting Reseolio Core v{}", env!("CARGO_PKG_VERSION"));

    // Parse configuration from environment
    let config = Config::from_env();

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

/// Configuration for Reseolio Core
struct Config {
    /// Path to SQLite database file
    database_path: PathBuf,
    /// Address to listen on for gRPC
    listen_addr: String,
    /// Maximum concurrent jobs to process
    max_concurrent_jobs: usize,
    /// Scheduler poll interval in milliseconds
    poll_interval_ms: u64,
}

impl Config {
    fn from_env() -> Self {
        Self {
            database_path: std::env::var("RESEOLIO_DB")
                .map(PathBuf::from)
                .unwrap_or_else(|_| PathBuf::from("reseolio.db")),
            listen_addr: std::env::var("RESEOLIO_ADDR")
                .unwrap_or_else(|_| "127.0.0.1:50051".to_string()),
            max_concurrent_jobs: std::env::var("RESEOLIO_MAX_CONCURRENT")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(100),
            poll_interval_ms: std::env::var("RESEOLIO_POLL_INTERVAL")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(100),
        }
    }
}
