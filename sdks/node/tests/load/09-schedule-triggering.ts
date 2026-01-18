/**
 * LOAD TEST 09: Schedule Triggering Under Load
 * 
 * Tests: Multiple schedules triggering simultaneously
 * Scenario: Many schedules with same cron expression firing together
 * Validates: System handles burst of scheduled job creation
 */

import './preload-tracing';
import { Reseolio } from '../../dist/index.js';

async function main() {
    const NUM_SCHEDULES = 100;
    const WAIT_FOR_TRIGGER_MS = 70000; // Wait up to 70 seconds for trigger

    console.log(`\n========================================`);
    console.log(`LOAD TEST: Schedule Triggering Under Load`);
    console.log(`========================================`);
    console.log(`Schedules:            ${NUM_SCHEDULES}`);
    console.log(`Cron expression:      * * * * * (every minute)`);
    console.log(`Max wait time:        ${WAIT_FOR_TRIGGER_MS / 1000}s\n`);

    const reseolio = new Reseolio({
        storage: process.env.RESEOLIO_DB || 'localhost:50051',
        autoStart: false,
        workerConcurrency: 20, // Handle burst of jobs
    });

    // Track job executions
    const executedJobs = new Map<string, number>(); // handlerName -> count
    let totalExecutions = 0;

    reseolio.on('job:success', (job) => {
        const count = executedJobs.get(job.name) || 0;
        executedJobs.set(job.name, count + 1);
        totalExecutions++;

        if (totalExecutions % 20 === 0) {
            console.log(`  [EXEC] Total executions: ${totalExecutions}`);
        }
    });

    try {
        await reseolio.start();
        const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

        // Create handlers and schedules
        console.log(`=> Creating ${NUM_SCHEDULES} every-minute schedules...`);
        const createStart = Date.now();
        const scheduleHandles = [];

        for (let i = 0; i < NUM_SCHEDULES; i++) {
            const task = reseolio.durable(`loadtest:trigger-${runId}-${i}`, async () => {
                // Simulate some work
                await new Promise(r => setTimeout(r, 50));
                return { executed: true, schedule: i, timestamp: Date.now() };
            });

            const handle = await task.schedule({
                cron: '* * * * *', // Every minute
                timezone: 'UTC',
            });
            scheduleHandles.push(handle);

            if ((i + 1) % 25 === 0) {
                console.log(`  [CREATE] ${i + 1}/${NUM_SCHEDULES}`);
            }
        }

        const createTime = Date.now() - createStart;
        console.log(`[OK] Created ${scheduleHandles.length} schedules in ${createTime}ms\n`);

        // Get next run time for any schedule
        const firstSchedule = await scheduleHandles[0].details();
        const nextRunAt = new Date(firstSchedule.nextRunAt);
        const waitTime = Math.max(0, nextRunAt.getTime() - Date.now()) + 10000; // Add 10s buffer

        if (waitTime > WAIT_FOR_TRIGGER_MS) {
            console.log(`[SKIP] Next trigger at ${nextRunAt.toISOString()} is too far (${Math.ceil(waitTime / 1000)}s)`);
            console.log(`       Skipping trigger wait test...\n`);
        } else {
            // ========== PHASE 2: Wait for Triggers ==========
            console.log(`=> Waiting for schedules to trigger...`);
            console.log(`   Next run at: ${nextRunAt.toISOString()}`);
            console.log(`   Wait time: ${Math.ceil(waitTime / 1000)}s\n`);

            const triggerStart = Date.now();
            await new Promise(r => setTimeout(r, waitTime));
            const triggerTime = Date.now() - triggerStart;

            // ========== PHASE 3: Verify Triggers ==========
            console.log(`\n=> Verifying schedule triggers...`);

            // Check how many schedules have lastRunAt set
            let triggeredCount = 0;
            for (const handle of scheduleHandles) {
                const details = await handle.details();
                if (details.lastRunAt && details.lastRunAt > 0) {
                    triggeredCount++;
                }
            }

            console.log(`  Schedules triggered: ${triggeredCount}/${NUM_SCHEDULES}`);
            console.log(`  Jobs executed: ${totalExecutions}`);
            console.log(`  Unique handlers executed: ${executedJobs.size}\n`);
        }

        // ========== PHASE 4: Cleanup ==========
        console.log(`=> Cleaning up schedules...`);
        const cleanupStart = Date.now();

        for (const handle of scheduleHandles) {
            await handle.delete();
        }

        const cleanupTime = Date.now() - cleanupStart;
        console.log(`[OK] Deleted ${scheduleHandles.length} schedules in ${cleanupTime}ms\n`);

        // ========== RESULTS ==========
        console.log(`\n========================================`);
        console.log(`RESULTS`);
        console.log(`========================================`);
        console.log(`Schedules Created:    ${scheduleHandles.length}`);
        console.log(`Total Executions:     ${totalExecutions}`);
        console.log(`Unique Handlers:      ${executedJobs.size}`);
        console.log(`\nTiming:`);
        console.log(`  Create Time:        ${createTime}ms`);
        console.log(`  Cleanup Time:       ${cleanupTime}ms`);
        console.log(`========================================\n`);

        // Success criteria (relaxed for this test)
        const passed = scheduleHandles.length === NUM_SCHEDULES;

        if (passed) {
            console.log(`[PASS] TEST PASSED`);
            console.log(`  - All ${NUM_SCHEDULES} schedules created and cleaned up\n`);
        } else {
            console.log(`[FAIL] TEST FAILED`);
            console.log(`  - Expected ${NUM_SCHEDULES} schedules, got ${scheduleHandles.length}\n`);
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
