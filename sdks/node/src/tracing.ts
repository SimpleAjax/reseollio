import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { GrpcInstrumentation } from '@opentelemetry/instrumentation-grpc';

// Singleton to avoid multiple initializations
let sdk: NodeSDK | null = null;

export function initTracing(serviceName: string = 'reseolio-node-client') {
    if (sdk) return;

    // Check if OTLP endpoint is set (e.g. http://localhost:4317)
    const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    if (!endpoint) return;

    try {
        // Set service name via env var so NodeSDK auto-detects it
        process.env.OTEL_SERVICE_NAME = serviceName;

        const exporter = new OTLPTraceExporter({
            url: endpoint,
        });

        sdk = new NodeSDK({
            traceExporter: exporter,
            instrumentations: [
                new GrpcInstrumentation()
            ],
        });

        sdk.start();
        console.log(`[Reseolio] OpenTelemetry initialized (endpoint: ${endpoint})`);

        // Graceful shutdown
        process.on('SIGTERM', () => {
            sdk?.shutdown()
                .then(() => console.log('Tracing terminated'))
                .catch((error) => console.log('Error terminating tracing', error))
                .finally(() => process.exit(0));
        });

    } catch (err) {
        console.error('[Reseolio] Failed to initialize OpenTelemetry:', err);
    }
}
