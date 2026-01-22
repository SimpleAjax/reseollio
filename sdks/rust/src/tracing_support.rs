#[cfg(feature = "tracing")]
use opentelemetry::global;
#[cfg(feature = "tracing")]
use opentelemetry_otlp::WithExportConfig;
#[cfg(feature = "tracing")]
use tracing_subscriber::layer::SubscriberExt;

/// Initialize OpenTelemetry tracing
#[cfg(feature = "tracing")]
pub fn init_tracing(service_name: &str) -> std::result::Result<(), Box<dyn std::error::Error>> {
    let endpoint = std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT")
        .unwrap_or_else(|_| "http://localhost:4317".to_string());

    let tracer = opentelemetry_otlp::new_pipeline()
        .tracing()
        .with_exporter(
            opentelemetry_otlp::new_exporter()
                .tonic()
                .with_endpoint(&endpoint),
        )
        .with_trace_config(opentelemetry::sdk::trace::config().with_resource(
            opentelemetry::sdk::Resource::new(vec![opentelemetry::KeyValue::new(
                "service.name",
                service_name.to_string(),
            )]),
        ))
        .install_batch(opentelemetry::runtime::Tokio)?;

    let telemetry = tracing_opentelemetry::layer().with_tracer(tracer);

    let subscriber = tracing_subscriber::registry()
        .with(tracing_subscriber::fmt::layer())
        .with(telemetry);

    tracing::subscriber::set_global_default(subscriber)?;

    Ok(())
}

#[cfg(feature = "tracing")]
pub fn shutdown_tracing() {
    global::shutdown_tracer_provider();
}

#[cfg(not(feature = "tracing"))]
pub fn init_tracing(_service_name: &str) -> std::result::Result<(), Box<dyn std::error::Error>> {
    Ok(())
}

#[cfg(not(feature = "tracing"))]
pub fn shutdown_tracing() {}
