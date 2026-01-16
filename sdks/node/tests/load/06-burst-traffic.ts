/**
 * LOAD TEST 6: Burst Traffic
 * 
 * Tests: System response to sudden traffic spikes
 * Scenario: Periods of high load followed by calm periods
 * Validates: Queue doesn't grow unbounded, recovery after burst
 */

import './preload-tracing';
import { Reseolio } from '../../dist/index.js';

async function main() {
    const BURST_SIZE = 500;      // Jobs per burst
    const NUM_BURSTS = 5;        // Number of bursts
    const BURST_INTERVAL_MS = 3000;  // Time between bursts
    const JOB_DURATION_MS = 20;

    console.log(`\n========================================`);
    console.log(`LOAD TEST: Burst Traffic`);
    console.log(`========================================`);
    console.log(`Burst size:       ${BURST_SIZE} jobs`);
    console.log(`Number of bursts: ${NUM_BURSTS}`);
    console.log(`Interval:         ${BURST_INTERVAL_MS}ms`);
    console.log(`Job duration:     ${JOB_DURATION_MS}ms`);
    console.log(`Total jobs:       ${BURST_SIZE * NUM_BURSTS}\n`);

    const reseolio = new Reseolio({
        storage: process.env.RESEOLIO_DB || 'sqlite://./load-test-burst.db',
        autoStart: false,
        workerConcurrency: 15
    });

    // Metrics per burst
    const burstMetrics: {
        burstNum: number;
        enqueueTime: number;
        completedInBurst: number;
        avgLatency: number;
    }[] = [];

    let totalCompleted = 0;
    let totalFailed = 0;
    const allLatencies: number[] = [];
    const startTimes = new Map<string, number>();

    reseolio.on('job:start', (job) => {
        startTimes.set(job.id, Date.now());
    });

    reseolio.on('job:success', (job) => {
        totalCompleted++;
        const latency = Date.now() - (startTimes.get(job.id) || 0);
        allLatencies.push(latency);
    });

    reseolio.on('job:error', () => {
        totalFailed++;
    });

    try {
        await reseolio.start();

        // Define job
        const burstJob = reseolio.durable(
            'burst:process',
            async (burstNum: number, jobNum: number) => {
                await new Promise(r => setTimeout(r, JOB_DURATION_MS));
                return { burst: burstNum, job: jobNum };
            }
        );

        const allHandles: Awaited<ReturnType<typeof burstJob>>[] = [];

        // Execute bursts
        const testStart = Date.now();

        for (let burst = 0; burst < NUM_BURSTS; burst++) {
            console.log(`\n=> Burst #${burst + 1}: Sending ${BURST_SIZE} jobs...`);

            const burstStart = Date.now();
            const completedBefore = totalCompleted;

            // Send burst
            const burstHandles = await Promise.all(
                Array.from({ length: BURST_SIZE }, (_, i) => burstJob(burst, i))
            );
            allHandles.push(...burstHandles);

            const enqueueTime = Date.now() - burstStart;
            console.log(`  Enqueued in ${enqueueTime}ms (${(BURST_SIZE / (enqueueTime / 1000)).toFixed(0)} jobs/sec)`);

            // Wait for interval (simulating calm period)
            if (burst < NUM_BURSTS - 1) {
                console.log(`  Waiting ${BURST_INTERVAL_MS}ms before next burst...`);
                await new Promise(r => setTimeout(r, BURST_INTERVAL_MS));
            }

            // Record metrics
            burstMetrics.push({
                burstNum: burst + 1,
                enqueueTime,
                completedInBurst: totalCompleted - completedBefore,
                avgLatency: 0, // Will calculate later
            });
        }

        // Wait for all jobs to complete
        console.log(`\n=> Waiting for all ${allHandles.length} jobs to complete...`);
        const drainStart = Date.now();

        await Promise.all(allHandles.map(h => h.result(120000)));

        const drainTime = Date.now() - drainStart;
        const totalTime = Date.now() - testStart;

        // Calculate metrics
        const avgLatency = allLatencies.reduce((a, b) => a + b, 0) / allLatencies.length;
        const sortedLatencies = allLatencies.sort((a, b) => a - b);
        const p50 = sortedLatencies[Math.floor(sortedLatencies.length * 0.5)];
        const p95 = sortedLatencies[Math.floor(sortedLatencies.length * 0.95)];
        const p99 = sortedLatencies[Math.floor(sortedLatencies.length * 0.99)];

        // Report
        console.log(`\n========================================`);
        console.log(`RESULTS`);
        console.log(`========================================`);
        console.log(`Total Jobs:       ${BURST_SIZE * NUM_BURSTS}`);
        console.log(`Completed:        ${totalCompleted}`);
        console.log(`Failed:           ${totalFailed}`);
        console.log(`\nPer-Burst Summary:`);
        burstMetrics.forEach(m => {
            console.log(`  Burst #${m.burstNum}: enqueue ${m.enqueueTime}ms, completed during burst: ${m.completedInBurst}`);
        });
        console.log(`\nTiming:`);
        console.log(`  Total Test Time:  ${totalTime}ms`);
        console.log(`  Drain Time:       ${drainTime}ms (time to complete after last burst)`);
        console.log(`\nLatency (ms):`);
        console.log(`  Average:          ${avgLatency.toFixed(2)}`);
        console.log(`  p50:              ${p50}`);
        console.log(`  p95:              ${p95}`);
        console.log(`  p99:              ${p99}`);
        console.log(`\nThroughput:`);
        console.log(`  Overall:          ${(totalCompleted / (totalTime / 1000)).toFixed(2)} jobs/sec`);
        console.log(`========================================\n`);

        // Success criteria
        const allComplete = totalCompleted === BURST_SIZE * NUM_BURSTS;
        const reasonableDrain = drainTime < (BURST_SIZE * NUM_BURSTS * JOB_DURATION_MS / 10); // Should be way faster due to concurrency
        const p95Reasonable = p95 < 5000; // p95 should be under 5 seconds

        const passed = allComplete && reasonableDrain && p95Reasonable;

        if (passed) {
            console.log(`[PASS] TEST PASSED`);
            console.log(`  - All jobs completed`);
            console.log(`  - Drain time reasonable (${drainTime}ms)`);
            console.log(`  - p95 latency under 5s\n`);
        } else {
            console.log(`[FAIL] TEST FAILED`);
            if (!allComplete) console.log(`  - Jobs incomplete: ${totalCompleted}/${BURST_SIZE * NUM_BURSTS}`);
            if (!reasonableDrain) console.log(`  - Drain too slow: ${drainTime}ms`);
            if (!p95Reasonable) console.log(`  - p95 too high: ${p95}ms`);
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
