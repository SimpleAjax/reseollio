
import { initTracing } from '../../src/tracing';

const serviceName = process.env.WORKER_ID
    ? `reseolio-worker-${process.env.WORKER_ID}`
    : 'reseolio-load-test';

// Initialize tracing immediately upon module load
// ensuring it runs before other imports (like grpc) if this file is imported first.
initTracing(serviceName);
