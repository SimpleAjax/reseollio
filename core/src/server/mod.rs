//! gRPC server implementation for Reseolio
//!
//! This module provides the gRPC server that handles client connections
//! and uses a push-based architecture for job distribution.

mod service;

pub use service::ReseolioServer;

use crate::scheduler::WorkerRegistry;
use crate::storage::Storage;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::Notify;
use tonic::transport::Server;
use tracing::info;

/// Start the gRPC server with push-based job distribution
pub async fn serve<S: Storage>(
    storage: S,
    registry: WorkerRegistry,
    scheduler_notify: Arc<Notify>,
    addr: SocketAddr,
) -> Result<(), tonic::transport::Error> {
    info!("Starting gRPC server on {}", addr);

    let server = ReseolioServer::new(storage, registry, scheduler_notify);

    Server::builder()
        .add_service(server.into_service())
        .serve(addr)
        .await
}
