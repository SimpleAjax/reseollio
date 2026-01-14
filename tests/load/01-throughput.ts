/**
 * LOAD TEST 1: Basic Throughput
 * 
 * Tests: Single worker processing N jobs
 * Metrics: Jobs/sec, latency, completion rate
 */

import { Reseolio } from '../../sdks/node/dist/index.js';

async function main() {
    const NUM_JOBS = 500;
    const JOB_DURATION_MS = 10;

    console.log(`\n========================================`);
    console.log(`LOAD TEST: Basic Throughput`);
    console.log(`========================================`);
    console.log(`Jobs:         ${NUM_JOBS}`);
    console.log(`Job duration: ${JOB_DURATION_MS}ms`);
    console.log(`Workers:      1\n`);

    const reseolio = new Reseolio({
        storage: process.env.RESEOLIO_DB || 'sqlite://./load-test.db',
        autoStart: false,
    });

    // Metrics
    let jobsCompleted = 0;
    let jobsFailed = 0;
    const latencies: number[] = [];
    const startTimes = new Map<string, number>();

    // Event handlers
    reseolio.on('job:start', (job) => {
        startTimes.set(job.id, Date.now());
    });

    reseolio.on('job:success', (job) => {
        jobsCompleted++;
        const latency = Date.now() - (startTimes.get(job.id) || 0);
        latencies.push(latency);

        if (jobsCompleted % 100 === 0) {
            console.log(`  [OK] Completed: ${jobsCompleted}/${NUM_JOBS}`);
        }
    });

    reseolio.on('job:error', (job, err) => {
        jobsFailed++;
        console.error(`  [ERR] Job ${job.id} failed:`, err);
    });

    try {
        await reseolio.start();

        // Define job
        const processJob = reseolio.durable(
            'process-job',
            async (id: number) => {
                await new Promise(r => setTimeout(r, JOB_DURATION_MS));
                return { id, processed: true };
            }
        );

        // Enqueue phase
        console.log(`=> Enqueueing ${NUM_JOBS} jobs...`);
        const enqueueStart = Date.now();

        const jobs = [];
        for (let i = 0; i < NUM_JOBS; i++) {
            jobs.push(processJob(i));
        }
        const jobHandles = await Promise.all(jobs);

        const enqueueTime = Date.now() - enqueueStart;
        console.log(`[OK] Enqueued in ${enqueueTime}ms (${(NUM_JOBS / (enqueueTime / 1000)).toFixed(2)} jobs/sec)`);

        // Processing phase
        console.log(`\n=> Processing jobs...\n`);
        const processStart = Date.now();
        console.log(`\n=> start awaiting for processing job...\n`);

        await Promise.all(jobHandles.map(j => j.result()));
        console.log(`\n=> completed awaiting for processing job...\n`);

        const processTime = Date.now() - processStart;

        // Calculate metrics
        const totalTime = Date.now() - enqueueStart;
        const throughput = NUM_JOBS / (processTime / 1000);
        const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
        const p50 = latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.5)];
        const p95 = latencies[Math.floor(latencies.length * 0.95)];
        const p99 = latencies[Math.floor(latencies.length * 0.99)];

        // Report
        console.log(`\n========================================`);
        console.log(`RESULTS`);
        console.log(`========================================`);
        console.log(`Total Jobs:       ${NUM_JOBS}`);
        console.log(`Completed:        ${jobsCompleted}`);
        console.log(`Failed:           ${jobsFailed}`);
        console.log(`Success Rate:     ${((jobsCompleted / NUM_JOBS) * 100).toFixed(2)}%`);
        console.log(`\nTiming:`);
        console.log(`  Enqueue Time:   ${enqueueTime}ms`);
        console.log(`  Process Time:   ${processTime}ms`);
        console.log(`  Total Time:     ${totalTime}ms`);
        console.log(`\nThroughput:`);
        console.log(`  Jobs/sec:       ${throughput.toFixed(2)}`);
        console.log(`\nLatency (ms):`);
        console.log(`  Average:        ${avgLatency.toFixed(2)}`);
        console.log(`  p50:            ${p50}`);
        console.log(`  p95:            ${p95}`);
        console.log(`  p99:            ${p99}`);
        console.log(`========================================\n`);

        // Success criteria
        const passed = jobsCompleted === NUM_JOBS && throughput > 50;
        if (passed) {
            console.log(`[PASS] TEST PASSED`);
            console.log(`  - All jobs completed`);
            console.log(`  - Throughput > 50 jobs/sec\n`);
        } else {
            console.log(`[FAIL] TEST FAILED`);
            if (jobsCompleted < NUM_JOBS) {
                console.log(`  - Expected ${NUM_JOBS} jobs, got ${jobsCompleted}`);
            }
            if (throughput <= 50) {
                console.log(`  - Throughput too low: ${throughput.toFixed(2)} jobs/sec (target: >50)`);
            }
            console.log();
        }

        await reseolio.stop();
        process.exit(passed ? 0 : 1);

    } catch (error) {
        console.error('\n[FATAL] Error:', error);
        await reseolio.stop().catch(() => { });
        process.exit(1);
    }
}

main();
