/**
 * LOAD TEST 3: Retry Storm
 * 
 * Tests: Retry logic under high failure rate
 * Metrics: Retry delays, backoff correctness, eventual success
 */

import { Reseolio } from '../../dist/index.js';

const NUM_JOBS = 1000;
const FAILURE_RATE = 0.8; // 80% fail rate

async function main() {
    console.log(`🔬 LOAD TEST: Retry Storm`);
    console.log(`   Jobs: ${NUM_JOBS}`);
    console.log(`   Failure rate: ${FAILURE_RATE * 100}%`);
    console.log(`   Max attempts: 3\n`);

    const reseolio = new Reseolio({
        storage: process.env.RESEOLIO_DB || 'sqlite://./load-test.db',
        autoStart: false,
    });

    // Metrics
    const attemptCounts = new Map<number, number>(); // jobId -> attempts
    const retryDelays: number[] = [];
    let totalAttempts = 0;
    let jobsSucceeded = 0;
    let jobsDead = 0;

    // Track attempts
    reseolio.on('job:start', (job) => {
        // console.log(`Job ${job.id} started`);
        const count = attemptCounts.get(job.attempt) || 0;
        attemptCounts.set(job.attempt, count + 1);
        totalAttempts++;
    });

    reseolio.on('job:success', (job) => {
        // console.log(`Job ${job.id} succeeded`);
    });

    reseolio.on('job:error', (job) => {
        // console.log(`Job ${job.id} failed`);
        // Will retry if attempts remain
    });

    try {
        await reseolio.start();

        const unreliableJob = reseolio.durable(
            'unreliable-job',
            async (id: number, shouldFail: boolean) => {
                if (shouldFail && Math.random() < FAILURE_RATE) {
                    throw new Error(`Job ${id} failed (random)`);
                }
                return { id, success: true };
            },
            {
                maxAttempts: 3,
                backoff: 'exponential',
                initialDelayMs: 100,
                maxDelayMs: 5000,
            }
        );


        console.log(`📤 Enqueueing ${NUM_JOBS} unreliable jobs...\n`);

        const jobs = [];
        for (let i = 0; i < NUM_JOBS; i++) {
            jobs.push(unreliableJob(i, true)); // Start with failures
        }
        const handles = await Promise.all(jobs);

        console.log(`⏳ Processing (expect retries)...\n`);
        const startTime = Date.now();

        const results = await Promise.allSettled(
            handles.map(h => h.result())
        );

        const totalTime = Date.now() - startTime;

        // Analyze results
        results.forEach((result, idx) => {
            if (result.status === 'fulfilled') {
                jobsSucceeded++;
            } else {
                jobsDead++;
            }
        });

        // Calculate retry statistics
        const totalRetries = totalAttempts - NUM_JOBS;
        const avgAttempts = totalAttempts / NUM_JOBS;

        console.log(`\n📊 RESULTS`);
        console.log(`═══════════════════════════════════════`);
        console.log(`Total Jobs:       ${NUM_JOBS}`);
        console.log(`Succeeded:        ${jobsSucceeded}`);
        console.log(`Dead (max retry): ${jobsDead}`);
        console.log(`\nRetry Statistics:`);
        console.log(`  Total Attempts:   ${totalAttempts}`);
        console.log(`  Total Retries:    ${totalRetries}`);
        console.log(`  Avg Attempts:     ${avgAttempts.toFixed(2)}`);
        console.log(`\nAttempt Distribution:`);
        [1, 2, 3].forEach(attempt => {
            const count = attemptCounts.get(attempt) || 0;
            console.log(`  Attempt ${attempt}:       ${count} jobs`);
        });
        console.log(`\nTiming:`);
        console.log(`  Total Time:       ${totalTime}ms`);
        console.log(`  Time per Job:     ${(totalTime / NUM_JOBS).toFixed(2)}ms`);
        console.log(`═══════════════════════════════════════\n`);

        // Success criteria
        const allAccountedFor = (jobsSucceeded + jobsDead) === NUM_JOBS;
        const someRetries = totalRetries > 0;
        const reasonableRetries = avgAttempts >= 1.3 && avgAttempts <= 3; // Between 1.3 and 3 attempts on avg

        const passed = allAccountedFor && someRetries && reasonableRetries;

        if (passed) {
            console.log(`✅ TEST PASSED`);
            console.log(`   All jobs resolved, retry logic working`);
            console.log(`   Average attempts (${avgAttempts.toFixed(2)}) is reasonable for ${FAILURE_RATE * 100}% failure rate\n`);
        } else {
            console.log(`❌ TEST FAILED`);
            if (!allAccountedFor) console.log(`   Not all jobs resolved`);
            if (!someRetries) console.log(`   No retries occurred (expected with ${FAILURE_RATE * 100}% failure)`);
            if (!reasonableRetries) console.log(`   Retry count abnormal: ${avgAttempts.toFixed(2)} attempts`);
            console.log();
        }

        await reseolio.stop();
        process.exit(passed ? 0 : 1);

    } catch (error) {
        console.error('\n❌ Fatal error:', error);
        await reseolio.stop().catch(() => { });
        process.exit(1);
    }
}

main();
