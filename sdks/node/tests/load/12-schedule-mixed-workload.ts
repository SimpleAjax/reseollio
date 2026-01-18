/**
 * LOAD TEST 12: Mixed Workload - Jobs + Schedules
 * 
 * Tests: System under mixed job and schedule operations
 * Scenario: Real-world pattern of ad-hoc jobs + scheduled tasks
 * Validates: No interference between job and schedule subsystems
 */

import './preload-tracing';
import { Reseolio } from '../../dist/index.js';

async function main() {
    const NUM_AD_HOC_JOBS = 500;
    const NUM_SCHEDULES = 50;
    const SCHEDULE_OPS = 10; // Operations per schedule

    console.log(`\n========================================`);
    console.log(`LOAD TEST: Mixed Workload (Jobs + Schedules)`);
    console.log(`========================================`);
    console.log(`Ad-hoc Jobs:          ${NUM_AD_HOC_JOBS}`);
    console.log(`Schedules:            ${NUM_SCHEDULES}`);
    console.log(`Schedule ops each:    ${SCHEDULE_OPS}`);
    console.log(`Total schedule ops:   ${NUM_SCHEDULES * SCHEDULE_OPS}\n`);

    const reseolio = new Reseolio({
        storage: process.env.RESEOLIO_DB || 'localhost:50051',
        autoStart: false,
        workerConcurrency: 15,
    });

    // Metrics
    let jobsCompleted = 0;
    let scheduleOpsCompleted = 0;

    reseolio.on('job:success', () => {
        jobsCompleted++;
        if (jobsCompleted % 100 === 0) {
            console.log(`  [JOB] Completed: ${jobsCompleted}/${NUM_AD_HOC_JOBS}`);
        }
    });

    try {
        await reseolio.start();
        const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

        // Define ad-hoc job handler
        const processTask = reseolio.durable(
            `loadtest:mixed-task-${runId}`,
            async (taskId: number) => {
                await new Promise(r => setTimeout(r, 20));
                return { taskId, processed: true };
            }
        );

        // Define schedule handlers
        // Define schedule handlers
        const scheduleHandlers: any[] = [];
        for (let i = 0; i < NUM_SCHEDULES; i++) {
            scheduleHandlers.push(
                reseolio.durable(`loadtest:mixed-schedule-${runId}-${i}`, async () => {
                    return { schedule: i, executed: true };
                })
            );
        }

        const testStart = Date.now();

        // ========== Run both workloads concurrently ==========
        console.log(`=> Starting mixed workload...`);
        console.log(`   Ad-hoc jobs and schedule operations running concurrently\n`);

        // Ad-hoc job submission
        const jobPromises: Promise<any>[] = [];
        for (let i = 0; i < NUM_AD_HOC_JOBS; i++) {
            jobPromises.push(processTask(i));
        }

        // Schedule creation and operations
        const schedulePromises: Promise<any>[] = [];
        const scheduleHandles: any[] = [];

        // Phase 1: Create schedules
        for (let i = 0; i < NUM_SCHEDULES; i++) {
            schedulePromises.push(
                scheduleHandlers[i].schedule({
                    cron: '0 * * * *',
                    timezone: 'UTC',
                }).then((handle: any) => {
                    scheduleHandles.push(handle);
                    scheduleOpsCompleted++;
                    return handle;
                })
            );
        }

        // Wait for all schedules to be created first
        await Promise.all(schedulePromises);
        console.log(`  [SCHEDULE] Created ${scheduleHandles.length} schedules`);

        // Phase 2: Perform operations on schedules while jobs run
        const scheduleOpPromises: Promise<any>[] = [];
        for (const handle of scheduleHandles) {
            for (let op = 0; op < SCHEDULE_OPS; op++) {
                const opType = op % 4;
                scheduleOpPromises.push((async () => {
                    try {
                        switch (opType) {
                            case 0:
                                await handle.details();
                                break;
                            case 1:
                                await handle.pause();
                                break;
                            case 2:
                                await handle.resume();
                                break;
                            case 3:
                                await handle.status();
                                break;
                        }
                        scheduleOpsCompleted++;
                    } catch (e) {
                        // Ignore errors
                    }
                })());
            }
        }

        // Wait for all job handles
        const jobHandles = await Promise.all(jobPromises);

        // Wait for schedule operations
        await Promise.all(scheduleOpPromises);
        console.log(`  [SCHEDULE] Completed ${scheduleOpsCompleted} operations`);

        // Wait for job results
        console.log(`\n=> Waiting for job completion...`);
        await Promise.all(jobHandles.map(h => h.result(60000)));

        const mixedTime = Date.now() - testStart;

        // ========== Cleanup ==========
        console.log(`\n=> Cleaning up schedules...`);
        const cleanupStart = Date.now();

        for (const handle of scheduleHandles) {
            await handle.delete().catch(() => { });
        }

        const cleanupTime = Date.now() - cleanupStart;
        console.log(`[OK] Cleanup completed in ${cleanupTime}ms\n`);

        // ========== RESULTS ==========
        const totalTime = Date.now() - testStart;
        const jobThroughput = NUM_AD_HOC_JOBS / (mixedTime / 1000);
        const scheduleOpThroughput = scheduleOpsCompleted / (mixedTime / 1000);

        console.log(`\n========================================`);
        console.log(`RESULTS`);
        console.log(`========================================`);
        console.log(`Ad-hoc Jobs:`);
        console.log(`  Submitted:          ${NUM_AD_HOC_JOBS}`);
        console.log(`  Completed:          ${jobsCompleted}`);
        console.log(`  Throughput:         ${jobThroughput.toFixed(2)} jobs/sec`);
        console.log(`\nSchedule Operations:`);
        console.log(`  Schedules Created:  ${scheduleHandles.length}`);
        console.log(`  Total Ops:          ${scheduleOpsCompleted}`);
        console.log(`  Throughput:         ${scheduleOpThroughput.toFixed(2)} ops/sec`);
        console.log(`\nTiming:`);
        console.log(`  Mixed Workload:     ${mixedTime}ms`);
        console.log(`  Total Time:         ${totalTime}ms`);
        console.log(`========================================\n`);

        // Success criteria
        const allJobsCompleted = jobsCompleted === NUM_AD_HOC_JOBS;
        const allSchedulesCreated = scheduleHandles.length === NUM_SCHEDULES;
        const decentThroughput = jobThroughput > 10 && scheduleOpThroughput > 5;

        const passed = allJobsCompleted && allSchedulesCreated && decentThroughput;

        if (passed) {
            console.log(`[PASS] TEST PASSED`);
            console.log(`  - All ${NUM_AD_HOC_JOBS} ad-hoc jobs completed`);
            console.log(`  - All ${NUM_SCHEDULES} schedules created`);
            console.log(`  - Good throughput under mixed load\n`);
        } else {
            console.log(`[FAIL] TEST FAILED`);
            if (!allJobsCompleted) {
                console.log(`  - Expected ${NUM_AD_HOC_JOBS} jobs, got ${jobsCompleted}`);
            }
            if (!allSchedulesCreated) {
                console.log(`  - Expected ${NUM_SCHEDULES} schedules, got ${scheduleHandles.length}`);
            }
            if (!decentThroughput) {
                console.log(`  - Throughput too low under mixed load`);
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
