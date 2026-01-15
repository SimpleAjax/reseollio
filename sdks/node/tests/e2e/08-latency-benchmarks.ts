/**
 * E2E Test 08: Latency Benchmarks
 * 
 * Measures the performance overhead of using Reseolio:
 * - Direct execution baseline
 * - Enqueue latency (Network trip to sidecar + DB insert)
 * - Scheduling latency (Time from Enqueue -> Handler execution)
 * - Full Round-trip latency (Time from Enqueue -> Result)
 */

import { Reseolio } from '../../src/client';
import { randomUUID } from 'crypto';
import { join } from 'path';

interface BenchmarkResult {
    metric: string;
    avgMs: number;
    p95Ms: number;
    minMs: number;
    maxMs: number;
    opsPerSec?: number;
}

const ITERATIONS = 50;

function calculateStats(times: bigint[]): BenchmarkResult {
    const timesMs = times.map(t => Number(t) / 1_000_000);
    timesMs.sort((a, b) => a - b);

    const sum = timesMs.reduce((a, b) => a + b, 0);
    const avg = sum / timesMs.length;
    const p95Index = Math.floor(timesMs.length * 0.95);

    return {
        metric: '',
        avgMs: parseFloat(avg.toFixed(3)),
        p95Ms: parseFloat(timesMs[p95Index].toFixed(3)),
        minMs: parseFloat(timesMs[0].toFixed(3)),
        maxMs: parseFloat(timesMs[timesMs.length - 1].toFixed(3)),
        opsPerSec: parseFloat((1000 / avg).toFixed(2))
    };
}

async function runBenchmarks() {
    console.log('⚡ E2E Test 08: Latency Benchmarks\n');
    console.log(`Running ${ITERATIONS} iterations for each metric...`);
    console.log('='.repeat(60));

    // Force strict database isolation for clean numbers
    const dbPath = `./bench-${randomUUID()}.db`;

    const reseolio = new Reseolio({
        storage: 'localhost:50051',
        autoStart: false,
    });

    try {
        await reseolio.start();
        console.log('✅ Connected to Reseolio Sidecar');

        // Allow some warm-up time
        await new Promise(r => setTimeout(r, 1000));

        // 1. Baseline: Direct JS Function Call
        // ------------------------------------
        const directFn = async (a: number) => a * 2;
        const baselineTimes: bigint[] = [];
        for (let i = 0; i < ITERATIONS * 10; i++) { // Run more for baseline as it's fast
            const start = process.hrtime.bigint();
            await directFn(i);
            const end = process.hrtime.bigint();
            baselineTimes.push(end - start);
        }

        const baselineStats = calculateStats(baselineTimes);
        baselineStats.metric = 'Direct JS Execution (Baseline)';

        // 2. Enqueue Latency
        // ------------------------------------
        // Measure only the time to dispatch (await job())
        const noOpJob = reseolio.durable(
            reseolio.namespace('bench', 'latency', 'noop'),
            async (a: number) => { return a; }
        );

        const enqueueTimes: bigint[] = [];
        for (let i = 0; i < ITERATIONS; i++) {
            const start = process.hrtime.bigint();
            await noOpJob(i); // Just enqueue, don't wait for result
            const end = process.hrtime.bigint();
            enqueueTimes.push(end - start);
        }

        const enqueueStats = calculateStats(enqueueTimes);
        enqueueStats.metric = 'Enqueue Job (Client -> Sidecar -> DB)';

        // 3. Scheduling Latency (End-to-End Latency)
        // ------------------------------------
        // Measure time from Enqueue -> Handler Start
        // We use a shared array to record start times
        const e2eTimes: bigint[] = [];
        const jobsToAwait: Promise<any>[] = [];

        const trackingJob = reseolio.durable(
            reseolio.namespace('bench', 'latency', 'tracking'),
            async (startTimeStr: string) => {
                const startTime = BigInt(startTimeStr);
                const now = process.hrtime.bigint();
                e2eTimes.push(now - startTime);
                return true;
            }
        );

        for (let i = 0; i < ITERATIONS; i++) {
            const start = process.hrtime.bigint();
            // We pass the start time as an argument
            const handle = await trackingJob(start.toString());
            jobsToAwait.push(handle.result());
            // Space them out slightly to avoid internal batching skewing ALL numbers (optional)
            await new Promise(r => setTimeout(r, 20));
        }

        await Promise.all(jobsToAwait);
        const schedulingStats = calculateStats(e2eTimes);
        schedulingStats.metric = 'Scheduling Lag (Enqueue -> Execution)';

        // 4. Full Round Trip (Request/Response)
        // ------------------------------------
        // Enqueue -> Execute -> Result
        const roundTripTimes: bigint[] = [];

        for (let i = 0; i < ITERATIONS; i++) {
            const start = process.hrtime.bigint();
            const handle = await noOpJob(i);
            await handle.result();
            const end = process.hrtime.bigint();
            roundTripTimes.push(end - start);
        }

        const roundTripStats = calculateStats(roundTripTimes);
        roundTripStats.metric = 'Full Round-Trip (Enqueue -> Result)';

        // REPORT
        // ------------------------------------
        console.log('\n📊 BENCHMARK RESULTS');
        console.log('='.repeat(85));
        console.log('| Metric                              | Avg (ms) | P95 (ms) | Min (ms) | Max (ms) | Est. OPS |');
        console.log('|-------------------------------------|----------|----------|----------|----------|----------|');

        const printRow = (s: BenchmarkResult) => {
            console.log(
                `| ${s.metric.padEnd(35)} | ` +
                `${s.avgMs.toFixed(3).padStart(8)} | ` +
                `${s.p95Ms.toFixed(3).padStart(8)} | ` +
                `${s.minMs.toFixed(3).padStart(8)} | ` +
                `${s.maxMs.toFixed(3).padStart(8)} | ` +
                `${s.opsPerSec?.toFixed(0).padStart(8)} |`
            );
        };

        printRow(baselineStats);
        printRow(enqueueStats);
        printRow(schedulingStats);
        printRow(roundTripStats);
        console.log('='.repeat(85));

        console.log('\n📝 Interpretation:');
        console.log(`- Enqueue Overhead: ~${enqueueStats.avgMs}ms added to your API handlers.`);
        console.log(`- Worker Lag: ~${schedulingStats.avgMs}ms from job creation to execution.`);

        await reseolio.stop();
        process.exit(0);

    } catch (e) {
        console.error(e);
        await reseolio.stop();
        process.exit(1);
    }
}

runBenchmarks();
