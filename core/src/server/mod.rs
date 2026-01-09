//! gRPC server implementation for Reseolio

mod service;

pub use service::ReseolioServer;

use crate::storage::Storage;
use std::net::SocketAddr;
use tonic::transport::Server;
use tracing::info;

/// Start the gRPC server
pub async fn serve<S: Storage>(
    server: ReseolioServer<S>,
    addr: SocketAddr,
) -> Result<(), tonic::transport::Error> {
    info!("Starting gRPC server on {}", addr);

    Server::builder()
        .add_service(server.into_service())
        .serve(addr)
        .await
}
