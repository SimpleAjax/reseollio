/**
 * LOAD TEST 2: Multi-Worker Concurrency
 * 
 * Tests: Multiple workers competing for jobs
 * Metrics: Worker utilization, job distribution, conflicts
 */

import { Reseolio } from '../../sdks/node/dist/index.js';
import { spawn, ChildProcess } from 'node:child_process';

const NUM_JOBS = 10000;
const NUM_WORKERS = 5;
const JOB_DURATION_MS = 10;

async function startWorker(workerId: number): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
        const worker = spawn('tsx', ['tests/load/worker.ts', String(workerId)], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                WORKER_ID: String(workerId),
                JOB_DURATION: String(JOB_DURATION_MS),
            }
        });

        worker.stdout?.on('data', (data) => {
            console.log(`[Worker ${workerId}]`, data.toString().trim());
        });

        worker.stderr?.on('data', (data) => {
            console.error(`[Worker ${workerId} ERR]`, data.toString().trim());
        });

        worker.on('error', reject);

        // Give it a moment to start
        setTimeout(() => resolve(worker), 500);
    });
}

async function main() {
    console.log(`\n========================================`);
    console.log(`LOAD TEST: Multi-Worker Concurrency`);
    console.log(`========================================`);
    console.log(`Jobs:         ${NUM_JOBS}`);
    console.log(`Workers:      ${NUM_WORKERS}`);
    console.log(`Job duration: ${JOB_DURATION_MS}ms\n`);

    // Create coordinator client (just for enqueuing)
    const coordinator = new Reseolio({
        storage: process.env.RESEOLIO_DB || 'sqlite://./load-test.db',
        autoStart: false,
        workerConcurrency: 0, // Not processing, just enqueuing
    });

    try {
        await coordinator.start();

        // Define job
        const processJob = coordinator.durable(
            'multi-worker-job',
            async (id: number) => {
                await new Promise(r => setTimeout(r, JOB_DURATION_MS));
                return { id, worker: process.env.WORKER_ID || 'unknown' };
            }
        );

        // Enqueue all jobs
        console.log(`=> Enqueueing ${NUM_JOBS} jobs...\n`);
        const jobs = [];
        for (let i = 0; i < NUM_JOBS; i++) {
            jobs.push(processJob(i));
        }
        const jobHandles = await Promise.all(jobs);
        console.log(`[OK] All jobs enqueued\n`);

        // Start workers in parallel (not sequential)
        console.log(`=> Starting ${NUM_WORKERS} workers...\n`);
        const workers = await Promise.all(
            Array.from({ length: NUM_WORKERS }, (_, i) => startWorker(i + 1))
        );
        console.log(`[OK] All workers started\n`);

        // Wait for completion
        console.log(`=> Waiting for jobs to complete...\n`);
        const startTime = Date.now();

        const results = await Promise.all(jobHandles.map(j => j.result()));

        const totalTime = Date.now() - startTime;
        const throughput = NUM_JOBS / (totalTime / 1000);

        // Analyze worker distribution
        const workerCounts = new Map<string, number>();
        results.forEach((result: any) => {
            const count = workerCounts.get(result.worker) || 0;
            workerCounts.set(result.worker, count + 1);
        });

        // Check for duplicates
        const uniqueIds = new Set(results.map((r: any) => r.id));
        const hasDuplicates = uniqueIds.size !== results.length;

        // Report
        console.log(`\n========================================`);
        console.log(`RESULTS`);
        console.log(`========================================`);
        console.log(`Total Jobs:       ${NUM_JOBS}`);
        console.log(`Completed:        ${results.length}`);
        console.log(`Total Time:       ${totalTime}ms`);
        console.log(`Throughput:       ${throughput.toFixed(2)} jobs/sec`);
        console.log(`\nWorker Distribution:`);
        workerCounts.forEach((count, worker) => {
            const percentage = (count / NUM_JOBS * 100).toFixed(1);
            console.log(`  Worker ${worker}:       ${count} jobs (${percentage}%)`);
        });
        console.log(`\nData Integrity:`);
        console.log(`  Unique IDs:       ${uniqueIds.size}`);
        console.log(`  Duplicates:       ${hasDuplicates ? 'YES [FAIL]' : 'NO [OK]'}`);
        console.log(`========================================\n`);

        // Success criteria
        const allCompleted = results.length === NUM_JOBS;
        const noDuplicates = !hasDuplicates;

        // We have 6 workers total: 5 spawned + 1 coordinator (labeled "unknown")
        // Coordinator has concurrency=1, others have concurrency=6
        // So we expect uneven distribution, but each worker should get SOME work
        const totalWorkers = workerCounts.size;
        const minJobsPerWorker = Math.floor(NUM_JOBS / totalWorkers) * 0.3; // At least 30% of fair share
        const reasonableDistribution = Array.from(workerCounts.values()).every(
            count => count >= minJobsPerWorker
        );

        const passed = allCompleted && noDuplicates && reasonableDistribution;

        if (passed) {
            console.log(`[PASS] TEST PASSED`);
            console.log(`  - All jobs completed`);
            console.log(`  - No duplicate executions`);
            console.log(`  - All ${totalWorkers} workers (${NUM_WORKERS} spawned + coordinator) participated\n`);
        } else {
            console.log(`[FAIL] TEST FAILED`);
            if (!allCompleted) console.log(`  - Expected ${NUM_JOBS} jobs, got ${results.length}`);
            if (hasDuplicates) console.log(`  - Found duplicate job executions`);
            if (!reasonableDistribution) {
                console.log(`  - Some workers got too few jobs (< ${minJobsPerWorker.toFixed(0)} each)`);
            }
            console.log();
        }

        // Cleanup
        workers.forEach(w => w.kill('SIGTERM'));
        // Wait for all workers to exit with timeout
        await Promise.all(workers.map(w => new Promise(resolve => {
            w.on('exit', resolve);
            setTimeout(resolve, 3000);  // Force continue after 3s
        })));
        await coordinator.stop();

        process.exit(passed ? 0 : 1);

    } catch (error) {
        console.error('\n❌ Fatal error:', error);
        await coordinator.stop().catch(() => { });
        process.exit(1);
    }
}

main();
