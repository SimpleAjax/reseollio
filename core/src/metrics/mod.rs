#![allow(dead_code)]
//! Prometheus Metrics for Reseolio
//!
//! This module provides production-grade observability through Prometheus metrics.
//! Metrics are exposed via a standalone HTTP server on a configurable port (default 9090).
//!
//! ## Metric Categories
//!
//! - **Job Lifecycle**: Track job throughput, status transitions, durations, and retry rates
//! - **Queue Health**: Monitor queue depth and staleness
//! - **Worker**: Track active workers and poll latencies
//! - **Storage**: Measure database operation performance
//! - **System**: Version info and uptime
//!
//! ## Usage
//!
//! ```bash
//! # Enable metrics (default)
//! RESEOLIO_METRICS_ENABLED=true
//!
//! # Configure metrics endpoint
//! RESEOLIO_METRICS_ADDR=0.0.0.0:9090
//! ```

use axum::{routing::get, Router};
use prometheus::{
    Counter, CounterVec, Encoder, Gauge, GaugeVec, Histogram, HistogramOpts, HistogramVec, Opts,
    Registry, TextEncoder,
};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Instant;
use tracing::{error, info};

/// Job duration histogram buckets (in seconds)
/// Covers 5ms to 120s range for typical job execution times
const JOB_DURATION_BUCKETS: &[f64] = &[
    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 120.0,
];

/// Storage operation duration buckets (in seconds)
/// Tighter buckets for database operations (1ms to 1s)
const STORAGE_DURATION_BUCKETS: &[f64] = &[0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0];

/// Worker poll duration buckets (in seconds)
const POLL_DURATION_BUCKETS: &[f64] = &[0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0];

/// Centralized metrics registry for Reseolio
///
/// This struct holds all Prometheus metrics and is designed to be shared
/// across the application via `Arc<MetricsRegistry>`.
#[derive(Clone)]
pub struct MetricsRegistry {
    /// The underlying Prometheus registry
    registry: Registry,

    /// Start time for uptime calculation
    start_time: Instant,

    // ============== Job Lifecycle Metrics ==============
    /// Total jobs by status (pending, running, success, failed, dead)
    pub jobs_total: CounterVec,

    /// Job execution duration histogram
    pub job_duration_seconds: HistogramVec,

    /// Total job attempts (including retries)
    pub job_attempts_total: CounterVec,

    // ============== Queue Health Metrics ==============
    /// Current queue depth by status
    pub queue_depth: GaugeVec,

    /// Age of oldest pending job in seconds
    pub queue_oldest_job_seconds: Gauge,

    // ============== Worker Metrics ==============
    /// Number of currently active workers
    pub workers_active: Gauge,

    /// Worker poll duration histogram
    pub worker_poll_duration_seconds: Histogram,

    // ============== Storage Metrics ==============
    /// Storage operation count by operation type and status
    pub storage_operations_total: CounterVec,

    /// Storage operation duration histogram
    pub storage_operation_duration_seconds: HistogramVec,

    // ============== System Metrics ==============
    /// Info gauge with version and storage type labels
    pub info: GaugeVec,

    /// Uptime counter in seconds
    pub uptime_seconds: Counter,
}

impl MetricsRegistry {
    /// Create a new MetricsRegistry with all metrics initialized
    pub fn new(version: &str, storage_type: &str) -> Self {
        let registry = Registry::new();
        let start_time = Instant::now();

        // ============== Job Lifecycle Metrics ==============

        let jobs_total = CounterVec::new(
            Opts::new("reseolio_jobs_total", "Total number of jobs by status"),
            &["status", "job_name"],
        )
        .expect("Failed to create jobs_total metric");

        let job_duration_seconds = HistogramVec::new(
            HistogramOpts::new(
                "reseolio_job_duration_seconds",
                "Job execution duration in seconds",
            )
            .buckets(JOB_DURATION_BUCKETS.to_vec()),
            &["job_name", "status"],
        )
        .expect("Failed to create job_duration_seconds metric");

        let job_attempts_total = CounterVec::new(
            Opts::new(
                "reseolio_job_attempts_total",
                "Total job execution attempts",
            ),
            &["job_name", "attempt"],
        )
        .expect("Failed to create job_attempts_total metric");

        // ============== Queue Health Metrics ==============

        let queue_depth = GaugeVec::new(
            Opts::new("reseolio_queue_depth", "Current number of jobs by status"),
            &["status"],
        )
        .expect("Failed to create queue_depth metric");

        let queue_oldest_job_seconds = Gauge::new(
            "reseolio_queue_oldest_job_seconds",
            "Age of the oldest pending job in seconds",
        )
        .expect("Failed to create queue_oldest_job_seconds metric");

        // ============== Worker Metrics ==============

        let workers_active = Gauge::new(
            "reseolio_workers_active",
            "Number of currently connected workers",
        )
        .expect("Failed to create workers_active metric");

        let worker_poll_duration_seconds = Histogram::with_opts(
            HistogramOpts::new(
                "reseolio_worker_poll_duration_seconds",
                "Time from worker poll request to job received",
            )
            .buckets(POLL_DURATION_BUCKETS.to_vec()),
        )
        .expect("Failed to create worker_poll_duration_seconds metric");

        // ============== Storage Metrics ==============

        let storage_operations_total = CounterVec::new(
            Opts::new(
                "reseolio_storage_operations_total",
                "Total storage operations by type and status",
            ),
            &["operation", "status"],
        )
        .expect("Failed to create storage_operations_total metric");

        let storage_operation_duration_seconds = HistogramVec::new(
            HistogramOpts::new(
                "reseolio_storage_operation_duration_seconds",
                "Storage operation duration in seconds",
            )
            .buckets(STORAGE_DURATION_BUCKETS.to_vec()),
            &["operation"],
        )
        .expect("Failed to create storage_operation_duration_seconds metric");

        // ============== System Metrics ==============

        let info = GaugeVec::new(
            Opts::new("reseolio_info", "Reseolio build information"),
            &["version", "storage_type"],
        )
        .expect("Failed to create info metric");

        let uptime_seconds = Counter::new(
            "reseolio_uptime_seconds",
            "Seconds since Reseolio core process started",
        )
        .expect("Failed to create uptime_seconds metric");

        // Register all metrics
        registry
            .register(Box::new(jobs_total.clone()))
            .expect("Failed to register jobs_total");
        registry
            .register(Box::new(job_duration_seconds.clone()))
            .expect("Failed to register job_duration_seconds");
        registry
            .register(Box::new(job_attempts_total.clone()))
            .expect("Failed to register job_attempts_total");
        registry
            .register(Box::new(queue_depth.clone()))
            .expect("Failed to register queue_depth");
        registry
            .register(Box::new(queue_oldest_job_seconds.clone()))
            .expect("Failed to register queue_oldest_job_seconds");
        registry
            .register(Box::new(workers_active.clone()))
            .expect("Failed to register workers_active");
        registry
            .register(Box::new(worker_poll_duration_seconds.clone()))
            .expect("Failed to register worker_poll_duration_seconds");
        registry
            .register(Box::new(storage_operations_total.clone()))
            .expect("Failed to register storage_operations_total");
        registry
            .register(Box::new(storage_operation_duration_seconds.clone()))
            .expect("Failed to register storage_operation_duration_seconds");
        registry
            .register(Box::new(info.clone()))
            .expect("Failed to register info");
        registry
            .register(Box::new(uptime_seconds.clone()))
            .expect("Failed to register uptime_seconds");

        // Set info gauge to 1 with version and storage_type labels
        info.with_label_values(&[version, storage_type]).set(1.0);

        Self {
            registry,
            start_time,
            jobs_total,
            job_duration_seconds,
            job_attempts_total,
            queue_depth,
            queue_oldest_job_seconds,
            workers_active,
            worker_poll_duration_seconds,
            storage_operations_total,
            storage_operation_duration_seconds,
            info,
            uptime_seconds,
        }
    }

    // ============== Job Lifecycle Recording ==============

    /// Record a job status transition
    pub fn record_job_status(&self, status: &str, job_name: &str) {
        self.jobs_total.with_label_values(&[status, job_name]).inc();
    }

    /// Record job execution duration
    pub fn record_job_duration(&self, job_name: &str, status: &str, duration_secs: f64) {
        self.job_duration_seconds
            .with_label_values(&[job_name, status])
            .observe(duration_secs);
    }

    /// Record a job attempt
    pub fn record_job_attempt(&self, job_name: &str, attempt: i32) {
        self.job_attempts_total
            .with_label_values(&[job_name, &attempt.to_string()])
            .inc();
    }

    // ============== Queue Health Recording ==============

    /// Update queue depth for a status
    pub fn set_queue_depth(&self, status: &str, count: i64) {
        self.queue_depth
            .with_label_values(&[status])
            .set(count as f64);
    }

    /// Update oldest job age
    pub fn set_oldest_job_age(&self, age_seconds: f64) {
        self.queue_oldest_job_seconds.set(age_seconds);
    }

    // ============== Worker Recording ==============

    /// Increment active worker count
    pub fn worker_connected(&self) {
        self.workers_active.inc();
    }

    /// Decrement active worker count
    pub fn worker_disconnected(&self) {
        self.workers_active.dec();
    }

    /// Record worker poll duration
    pub fn record_poll_duration(&self, duration_secs: f64) {
        self.worker_poll_duration_seconds.observe(duration_secs);
    }

    // ============== Storage Recording ==============

    /// Record a storage operation with timing
    pub fn record_storage_operation(&self, operation: &str, success: bool, duration_secs: f64) {
        let status = if success { "success" } else { "error" };
        self.storage_operations_total
            .with_label_values(&[operation, status])
            .inc();
        self.storage_operation_duration_seconds
            .with_label_values(&[operation])
            .observe(duration_secs);
    }

    /// Encode metrics to Prometheus text format
    pub fn encode(&self) -> String {
        // Update uptime before encoding
        let uptime = self.start_time.elapsed().as_secs_f64();
        // Note: Counter can only inc(), so we track uptime via info label or use a gauge
        // For now, we'll just report the current uptime as part of the text output

        let encoder = TextEncoder::new();
        let metric_families = self.registry.gather();
        let mut buffer = Vec::new();

        if let Err(e) = encoder.encode(&metric_families, &mut buffer) {
            error!("Failed to encode metrics: {}", e);
            return format!("# Error encoding metrics: {}", e);
        }

        // Append uptime as a comment (alternative: use a Gauge for uptime)
        let mut output = String::from_utf8(buffer).unwrap_or_default();
        output.push_str(&format!(
            "\n# HELP reseolio_uptime_seconds_gauge Current uptime in seconds\n"
        ));
        output.push_str(&format!("# TYPE reseolio_uptime_seconds_gauge gauge\n"));
        output.push_str(&format!("reseolio_uptime_seconds_gauge {:.3}\n", uptime));

        output
    }
}

/// Shared metrics state for the HTTP handler
struct MetricsState {
    registry: Arc<MetricsRegistry>,
}

/// Handler for GET /metrics
async fn metrics_handler(
    axum::extract::State(state): axum::extract::State<Arc<MetricsState>>,
) -> impl axum::response::IntoResponse {
    let body = state.registry.encode();
    (
        [(
            axum::http::header::CONTENT_TYPE,
            "text/plain; version=0.0.4; charset=utf-8",
        )],
        body,
    )
}

/// Handler for GET /health (liveness probe)
async fn health_handler() -> impl axum::response::IntoResponse {
    "OK"
}

/// Start the Prometheus metrics HTTP server
///
/// This spawns a lightweight HTTP server that exposes:
/// - `GET /metrics` - Prometheus scrape endpoint
/// - `GET /health` - Liveness probe
///
/// # Arguments
///
/// * `registry` - The shared metrics registry
/// * `addr` - Socket address to bind to (e.g., "0.0.0.0:9090")
///
/// # Returns
///
/// A `JoinHandle` for the server task
pub async fn start_metrics_server(
    registry: Arc<MetricsRegistry>,
    addr: SocketAddr,
) -> tokio::task::JoinHandle<()> {
    let state = Arc::new(MetricsState { registry });

    let app = Router::new()
        .route("/metrics", get(metrics_handler))
        .route("/health", get(health_handler))
        .with_state(state);

    info!(
        "Prometheus metrics server listening on http://{}/metrics",
        addr
    );

    tokio::spawn(async move {
        let listener = match tokio::net::TcpListener::bind(addr).await {
            Ok(l) => l,
            Err(e) => {
                error!("Failed to bind metrics server to {}: {}", addr, e);
                return;
            }
        };

        if let Err(e) = axum::serve(listener, app).await {
            error!("Metrics server error: {}", e);
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_metrics_registry_creation() {
        let registry = MetricsRegistry::new("0.1.0", "sqlite");
        assert!(registry.encode().contains("reseolio_info"));
    }

    #[test]
    fn test_job_status_recording() {
        let registry = MetricsRegistry::new("0.1.0", "sqlite");
        registry.record_job_status("success", "send-email");
        registry.record_job_status("success", "send-email");
        registry.record_job_status("failed", "send-email");

        let output = registry.encode();
        assert!(output.contains("reseolio_jobs_total"));
        assert!(output.contains("send-email"));
    }

    #[test]
    fn test_job_duration_recording() {
        let registry = MetricsRegistry::new("0.1.0", "sqlite");
        registry.record_job_duration("payment-process", "success", 0.5);
        registry.record_job_duration("payment-process", "success", 1.2);

        let output = registry.encode();
        assert!(output.contains("reseolio_job_duration_seconds"));
        assert!(output.contains("payment-process"));
    }

    #[test]
    fn test_storage_operation_recording() {
        let registry = MetricsRegistry::new("0.1.0", "postgres");
        registry.record_storage_operation("insert", true, 0.005);
        registry.record_storage_operation("select", true, 0.002);
        registry.record_storage_operation("update", false, 0.010);

        let output = registry.encode();
        assert!(output.contains("reseolio_storage_operations_total"));
        assert!(output.contains("insert"));
    }

    #[test]
    fn test_worker_metrics() {
        let registry = MetricsRegistry::new("0.1.0", "sqlite");
        registry.worker_connected();
        registry.worker_connected();
        registry.worker_disconnected();

        let output = registry.encode();
        assert!(output.contains("reseolio_workers_active"));
    }
}
