/**
 * Worker process for multi-worker concurrency test
 */

import './preload-tracing';
import { Reseolio } from '../../sdks/node/dist/index.js';

const workerId = process.env.WORKER_ID || 'unknown';
const jobDuration = parseInt(process.env.JOB_DURATION || '100', 10);

async function main() {
    const reseolio = new Reseolio({
        storage: process.env.RESEOLIO_DB || 'sqlite://./load-test.db',
        autoStart: false,
        workerConcurrency: 6,  // Doubled for throughput test
    });

    let jobsProcessed = 0;

    reseolio.on('job:success', () => {
        jobsProcessed++;
        if (jobsProcessed % 10 === 0) {
            console.log(`Processed ${jobsProcessed} jobs`);
        }
    });

    await reseolio.start();

    // Register handler
    reseolio.durable(
        'multi-worker-job',
        async (id: number) => {
            await new Promise(r => setTimeout(r, jobDuration));
            return { id, worker: workerId };
        }
    );

    console.log(`Worker ${workerId} ready`);

    // Keep alive
    process.on('SIGTERM', async () => {
        console.log(`Worker ${workerId} shutting down (processed ${jobsProcessed} jobs)`);
        await reseolio.stop();
        process.exit(0);
    });
}

main().catch((err) => {
    console.error('Worker error:', err);
    process.exit(1);
});
