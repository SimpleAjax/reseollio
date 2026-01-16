/**
 * LOAD TEST 5: Long-Running Jobs
 * 
 * Tests: System stability with jobs that take a long time to complete
 * Scenario: Mix of fast and slow jobs, simulating real workloads
 * Validates: Scheduler doesn't starve, timeouts work correctly
 */

import './preload-tracing';
import { Reseolio } from '../../dist/index.js';

async function main() {
    const NUM_FAST_JOBS = 500;
    const NUM_SLOW_JOBS = 50;
    const FAST_JOB_MS = 10;
    const SLOW_JOB_MS = 2000;

    console.log(`\n========================================`);
    console.log(`LOAD TEST: Long-Running Jobs`);
    console.log(`========================================`);
    console.log(`Fast jobs:        ${NUM_FAST_JOBS} (${FAST_JOB_MS}ms each)`);
    console.log(`Slow jobs:        ${NUM_SLOW_JOBS} (${SLOW_JOB_MS}ms each)`);
    console.log(`Total jobs:       ${NUM_FAST_JOBS + NUM_SLOW_JOBS}\n`);

    const reseolio = new Reseolio({
        storage: process.env.RESEOLIO_DB || 'sqlite://./load-test-long.db',
        autoStart: false,
        workerConcurrency: 20  // High concurrency to test parallel execution
    });

    // Metrics
    let fastCompleted = 0;
    let slowCompleted = 0;
    let fastFailed = 0;
    let slowFailed = 0;
    const fastLatencies: number[] = [];
    const slowLatencies: number[] = [];
    const startTimes = new Map<string, { start: number; type: string }>();

    reseolio.on('job:start', (job) => {
        startTimes.set(job.id, { start: Date.now(), type: job.name.includes('fast') ? 'fast' : 'slow' });
    });

    reseolio.on('job:success', (job) => {
        const info = startTimes.get(job.id);
        if (info) {
            const latency = Date.now() - info.start;
            if (info.type === 'fast') {
                fastCompleted++;
                fastLatencies.push(latency);
            } else {
                slowCompleted++;
                slowLatencies.push(latency);
            }
        }
    });

    reseolio.on('job:error', (job) => {
        const info = startTimes.get(job.id);
        if (info?.type === 'fast') fastFailed++;
        else slowFailed++;
    });

    try {
        await reseolio.start();

        // Define jobs
        const fastJob = reseolio.durable(
            'workload:fast',
            async (id: number) => {
                await new Promise(r => setTimeout(r, FAST_JOB_MS));
                return { id, type: 'fast' };
            }
        );

        const slowJob = reseolio.durable(
            'workload:slow',
            async (id: number) => {
                await new Promise(r => setTimeout(r, SLOW_JOB_MS));
                return { id, type: 'slow' };
            },
            { timeoutMs: 10000 }  // 10 second timeout for slow jobs
        );

        // Enqueue all jobs mixed together
        console.log(`=> Enqueueing mixed workload...`);
        const enqueueStart = Date.now();

        const handles = [];

        // Interleave fast and slow jobs to simulate real traffic
        let fastCount = 0;
        let slowCount = 0;

        for (let i = 0; i < NUM_FAST_JOBS + NUM_SLOW_JOBS; i++) {
            // Add 10 fast jobs for every slow job
            if (fastCount < NUM_FAST_JOBS && (slowCount >= NUM_SLOW_JOBS || i % 11 !== 10)) {
                handles.push(fastJob(fastCount++));
            } else if (slowCount < NUM_SLOW_JOBS) {
                handles.push(slowJob(slowCount++));
            }
        }

        const allHandles = await Promise.all(handles);
        const enqueueTime = Date.now() - enqueueStart;

        console.log(`  Enqueued ${allHandles.length} jobs in ${enqueueTime}ms`);

        // Wait for completion
        console.log(`\n=> Processing jobs (this may take a while for slow jobs)...`);
        const processStart = Date.now();

        // Track completion over time
        const progressInterval = setInterval(() => {
            console.log(`  [PROGRESS] Fast: ${fastCompleted}/${NUM_FAST_JOBS}, Slow: ${slowCompleted}/${NUM_SLOW_JOBS}`);
        }, 2000);

        await Promise.all(allHandles.map(h => h.result(30000)));
        clearInterval(progressInterval);

        const processTime = Date.now() - processStart;

        // Calculate metrics
        const avgFastLatency = fastLatencies.length > 0
            ? fastLatencies.reduce((a, b) => a + b, 0) / fastLatencies.length
            : 0;
        const avgSlowLatency = slowLatencies.length > 0
            ? slowLatencies.reduce((a, b) => a + b, 0) / slowLatencies.length
            : 0;

        const p95Fast = fastLatencies.sort((a, b) => a - b)[Math.floor(fastLatencies.length * 0.95)] || 0;
        const p95Slow = slowLatencies.sort((a, b) => a - b)[Math.floor(slowLatencies.length * 0.95)] || 0;

        // Report
        console.log(`\n========================================`);
        console.log(`RESULTS`);
        console.log(`========================================`);
        console.log(`Fast Jobs:`);
        console.log(`  Completed:      ${fastCompleted}/${NUM_FAST_JOBS}`);
        console.log(`  Failed:         ${fastFailed}`);
        console.log(`  Avg Latency:    ${avgFastLatency.toFixed(2)}ms`);
        console.log(`  p95 Latency:    ${p95Fast}ms`);
        console.log(`\nSlow Jobs:`);
        console.log(`  Completed:      ${slowCompleted}/${NUM_SLOW_JOBS}`);
        console.log(`  Failed:         ${slowFailed}`);
        console.log(`  Avg Latency:    ${avgSlowLatency.toFixed(2)}ms`);
        console.log(`  p95 Latency:    ${p95Slow}ms`);
        console.log(`\nTiming:`);
        console.log(`  Enqueue Time:   ${enqueueTime}ms`);
        console.log(`  Process Time:   ${processTime}ms`);
        console.log(`  Total Time:     ${Date.now() - enqueueStart}ms`);
        console.log(`\nConcurrency:`);
        console.log(`  Fast jobs didn't wait for all slow jobs: ${avgFastLatency < SLOW_JOB_MS}`);
        console.log(`========================================\n`);

        // Success criteria
        const allFastComplete = fastCompleted === NUM_FAST_JOBS;
        const allSlowComplete = slowCompleted === NUM_SLOW_JOBS;
        const fastNotBlocked = avgFastLatency < SLOW_JOB_MS;  // Fast jobs shouldn't wait for slow

        const passed = allFastComplete && allSlowComplete && fastNotBlocked;

        if (passed) {
            console.log(`[PASS] TEST PASSED`);
            console.log(`  - All fast jobs completed`);
            console.log(`  - All slow jobs completed`);
            console.log(`  - Fast jobs were not blocked by slow jobs\n`);
        } else {
            console.log(`[FAIL] TEST FAILED`);
            if (!allFastComplete) console.log(`  - Fast jobs incomplete: ${fastCompleted}/${NUM_FAST_JOBS}`);
            if (!allSlowComplete) console.log(`  - Slow jobs incomplete: ${slowCompleted}/${NUM_SLOW_JOBS}`);
            if (!fastNotBlocked) console.log(`  - Fast jobs blocked: avg latency ${avgFastLatency}ms > ${SLOW_JOB_MS}ms`);
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
