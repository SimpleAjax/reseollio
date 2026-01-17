//! gRPC server implementation for Reseolio
//!
//! This module provides the gRPC server that handles client connections
//! and uses a push-based architecture for job distribution.

mod service;

pub use service::ReseolioServer;

use crate::scheduler::WorkerRegistry;
use crate::storage::Storage;
use http; // For http types
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::Notify;
use tonic::transport::Server;
use tracing::info;
use tracing_opentelemetry::OpenTelemetrySpanExt; // For set_parent
use uuid; // For UUID generation

#[derive(Clone, Copy)]
struct CustomMakeRequestId;

impl tower_http::request_id::MakeRequestId for CustomMakeRequestId {
    fn make_request_id<B>(
        &mut self,
        request: &http::Request<B>,
    ) -> Option<tower_http::request_id::RequestId> {
        request
            .headers()
            .get("x-request-id")
            .map(|v| tower_http::request_id::RequestId::new(v.clone()))
            .or_else(|| {
                let id = uuid::Uuid::new_v4().to_string();
                let val = http::header::HeaderValue::from_str(&id).ok()?;
                Some(tower_http::request_id::RequestId::new(val))
            })
    }
}

/// Start the gRPC server with push-based job distribution
pub async fn serve<S: Storage>(
    storage: S,
    registry: WorkerRegistry,
    scheduler_notify: Arc<Notify>,
    addr: SocketAddr,
    schedule_poll_interval: std::time::Duration,
) -> Result<(), tonic::transport::Error> {
    info!("Starting gRPC server on {}", addr);

    let server = ReseolioServer::new(storage, registry, scheduler_notify, schedule_poll_interval);

    // Middleware stack
    let layer = tower::ServiceBuilder::new()
        // 1. Handle Request ID (use x-request-id or generate new)
        .layer(tower_http::request_id::SetRequestIdLayer::new(
            http::header::HeaderName::from_static("x-request-id"),
            CustomMakeRequestId,
        ))
        // 2. Add Tracing with OTel Context Propagation
        .layer(
            tower_http::trace::TraceLayer::new_for_grpc()
                .make_span_with(|req: &http::Request<_>| {
                    // Extract OTel context from headers (traceparent)
                    let parent_context =
                        opentelemetry::global::get_text_map_propagator(|propagator| {
                            propagator.extract(&opentelemetry_http::HeaderExtractor(req.headers()))
                        });

                    // Create span attached to parent context
                    let span = tracing::info_span!(
                        "grpc_request",
                        method = ?req.method(),
                        uri = ?req.uri(),
                        request_id = tracing::field::Empty,
                        trace_id = tracing::field::Empty,
                    );

                    span.set_parent(parent_context.clone());

                    // Extract trace_id from the context we just attached and record it
                    use opentelemetry::trace::TraceContextExt;
                    let trace_id = parent_context.span().span_context().trace_id();
                    span.record("trace_id", trace_id.to_string().as_str());

                    span
                })
                .on_request(|req: &http::Request<_>, _span: &tracing::Span| {
                    // Log request ID
                    if let Some(request_id) =
                        req.extensions().get::<tower_http::request_id::RequestId>()
                    {
                        tracing::info!(
                            "started request_id={}",
                            request_id.header_value().to_str().unwrap_or("")
                        );
                        _span.record(
                            "request_id",
                            request_id.header_value().to_str().unwrap_or(""),
                        );
                    }
                }),
        )
        .into_inner();

    Server::builder()
        .layer(layer)
        .add_service(server.into_service())
        .serve(addr)
        .await
}
