/**
 * LOAD TEST 4: Idempotency Stress Test
 * 
 * Tests: High-volume idempotent job submission
 * Scenario: Simulate duplicate submissions (e.g., retry storms, user double-clicks)
 * Validates: Deduplication works correctly under load
 */

import './preload-tracing';
import { Reseolio } from '../../dist/index.js';

async function main() {
    const NUM_UNIQUE_JOBS = 1000;
    const DUPLICATES_PER_JOB = 5;  // Each job is submitted 5 times
    const TOTAL_SUBMISSIONS = NUM_UNIQUE_JOBS * DUPLICATES_PER_JOB;

    console.log(`\n========================================`);
    console.log(`LOAD TEST: Idempotency Stress`);
    console.log(`========================================`);
    console.log(`Unique Jobs:            ${NUM_UNIQUE_JOBS}`);
    console.log(`Duplicates per job:     ${DUPLICATES_PER_JOB}`);
    console.log(`Total submissions:      ${TOTAL_SUBMISSIONS}`);
    console.log(`Expected actual jobs:   ${NUM_UNIQUE_JOBS}\n`);

    const reseolio = new Reseolio({
        storage: process.env.RESEOLIO_DB || 'sqlite://./load-test-idem.db',
        autoStart: false,
        workerConcurrency: 10
    });

    // Metrics
    let jobsExecuted = 0;
    const executedJobIds = new Set<string>();
    const jobIdMap = new Map<string, string>();  // idempotencyKey -> jobId

    reseolio.on('job:success', (job) => {
        jobsExecuted++;
        executedJobIds.add(job.id);
        if (jobsExecuted % 100 === 0) {
            console.log(`  [EXEC] Jobs executed: ${jobsExecuted}`);
        }
    });

    try {
        await reseolio.start();

        // Define job
        const processPayment = reseolio.durable(
            'payment:process',
            async (orderId: string, amount: number) => {
                await new Promise(r => setTimeout(r, 10));
                return { orderId, amount, processed: true };
            }
        );

        // Generate unique run ID to avoid interference from previous test runs
        const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

        // Submit phase - submit each job multiple times with same idempotency key
        console.log(`=> Submitting ${TOTAL_SUBMISSIONS} job requests (${NUM_UNIQUE_JOBS} unique)...`);
        const submitStart = Date.now();

        const allHandles: Awaited<ReturnType<typeof processPayment>>[] = [];
        const submissionPromises: Promise<any>[] = [];

        for (let i = 0; i < NUM_UNIQUE_JOBS; i++) {
            const orderId = `order-${runId}-${i}`;
            const idempotencyKey = `payment-${orderId}`;

            // Submit the same job multiple times
            for (let d = 0; d < DUPLICATES_PER_JOB; d++) {
                submissionPromises.push(
                    processPayment(orderId, 99.99, { idempotencyKey }).then(handle => {
                        allHandles.push(handle);
                        // Track first seen jobId for this key
                        if (!jobIdMap.has(idempotencyKey)) {
                            jobIdMap.set(idempotencyKey, handle.jobId);
                        }
                        return handle;
                    })
                );
            }
        }

        await Promise.all(submissionPromises);
        const submitTime = Date.now() - submitStart;

        // Verify deduplication
        console.log(`\n=> Verifying deduplication...`);

        // Check that all handles for same key have same jobId
        let deduplicationErrors = 0;
        const uniqueJobIds = new Set<string>();

        for (const [key, expectedJobId] of jobIdMap.entries()) {
            uniqueJobIds.add(expectedJobId);
        }

        // All handles should point to exactly NUM_UNIQUE_JOBS unique job IDs
        for (const handle of allHandles) {
            const key = `payment-order-${handle.jobId.split('-')[0]}`; // Extract order from handle
            uniqueJobIds.add(handle.jobId);
        }

        console.log(`  Unique job IDs created: ${uniqueJobIds.size}`);

        // Wait for all unique jobs to complete
        console.log(`\n=> Waiting for job completion...`);
        const processStart = Date.now();

        // Only need to wait for unique jobs
        const uniqueHandles = [...new Map(allHandles.map(h => [h.jobId, h])).values()];
        await Promise.all(uniqueHandles.map(h => h.result(60000)));

        const processTime = Date.now() - processStart;

        // Results
        const totalTime = Date.now() - submitStart;
        const dedupeRatio = TOTAL_SUBMISSIONS / uniqueJobIds.size;

        console.log(`\n========================================`);
        console.log(`RESULTS`);
        console.log(`========================================`);
        console.log(`Total Submissions:      ${TOTAL_SUBMISSIONS}`);
        console.log(`Unique Jobs Created:    ${uniqueJobIds.size}`);
        console.log(`Expected Unique:        ${NUM_UNIQUE_JOBS}`);
        console.log(`Jobs Actually Executed: ${jobsExecuted}`);
        console.log(`\nDeduplication:`);
        console.log(`  Ratio:                ${dedupeRatio.toFixed(2)}:1`);
        console.log(`  Efficiency:           ${((1 - uniqueJobIds.size / TOTAL_SUBMISSIONS) * 100).toFixed(1)}%`);
        console.log(`\nTiming:`);
        console.log(`  Submit Time:          ${submitTime}ms`);
        console.log(`  Process Time:         ${processTime}ms`);
        console.log(`  Total Time:           ${totalTime}ms`);
        console.log(`  Submit Rate:          ${(TOTAL_SUBMISSIONS / (submitTime / 1000)).toFixed(2)} submissions/sec`);
        console.log(`========================================\n`);

        // Success criteria
        const correctDedup = uniqueJobIds.size === NUM_UNIQUE_JOBS;
        const noOverExecution = jobsExecuted <= NUM_UNIQUE_JOBS;

        const passed = correctDedup && noOverExecution;

        if (passed) {
            console.log(`[PASS] TEST PASSED`);
            console.log(`  - Correct deduplication: ${TOTAL_SUBMISSIONS} submissions -> ${uniqueJobIds.size} jobs`);
            console.log(`  - No duplicate execution\n`);
        } else {
            console.log(`[FAIL] TEST FAILED`);
            if (!correctDedup) {
                console.log(`  - Expected ${NUM_UNIQUE_JOBS} unique jobs, got ${uniqueJobIds.size}`);
            }
            if (!noOverExecution) {
                console.log(`  - Expected max ${NUM_UNIQUE_JOBS} executions, got ${jobsExecuted}`);
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
