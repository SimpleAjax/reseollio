/**
 * LOAD TEST 08: Schedule Creation Throughput
 * 
 * Tests: High-volume schedule creation and management
 * Metrics: Schedules/sec, list latency, management ops throughput
 */

import './preload-tracing';
import { Reseolio } from '../../dist/index.js';

async function main() {
    const NUM_SCHEDULES = 500;

    console.log(`\n========================================`);
    console.log(`LOAD TEST: Schedule Creation Throughput`);
    console.log(`========================================`);
    console.log(`Schedules to create: ${NUM_SCHEDULES}`);
    console.log(`Operations: create, list, pause, resume, delete\n`);

    const reseolio = new Reseolio({
        storage: process.env.RESEOLIO_DB || 'localhost:50051',
        autoStart: false,
    });

    try {
        await reseolio.start();
        const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

        // Define a handler for schedules to trigger
        reseolio.durable('loadtest:scheduled-task', async () => {
            return { executed: true, timestamp: Date.now() };
        });

        // ========== PHASE 1: Schedule Creation ==========
        console.log(`=> Creating ${NUM_SCHEDULES} schedules...`);
        const createStart = Date.now();

        const scheduleHandles: any[] = [];
        const createPromises: Promise<any>[] = [];

        for (let i = 0; i < NUM_SCHEDULES; i++) {
            createPromises.push(
                reseolio.schedule(`loadtest:schedule-${runId}-${i}`, {
                    cron: '0 * * * *', // Hourly
                    timezone: 'UTC',
                }).then(handle => {
                    scheduleHandles.push(handle);
                    if (scheduleHandles.length % 100 === 0) {
                        console.log(`  [CREATE] ${scheduleHandles.length}/${NUM_SCHEDULES}`);
                    }
                    return handle;
                })
            );
        }

        await Promise.all(createPromises);
        const createTime = Date.now() - createStart;
        const createRate = NUM_SCHEDULES / (createTime / 1000);

        console.log(`[OK] Created ${scheduleHandles.length} schedules in ${createTime}ms (${createRate.toFixed(2)}/sec)\n`);

        // ========== PHASE 2: List Schedules ==========
        console.log(`=> Listing schedules...`);
        const listStart = Date.now();

        const listResult = await reseolio.listSchedules({ limit: NUM_SCHEDULES + 100 });

        const listTime = Date.now() - listStart;
        console.log(`[OK] Listed ${listResult.total} schedules in ${listTime}ms\n`);

        // ========== PHASE 3: Bulk Pause Operations ==========
        console.log(`=> Pausing all schedules...`);
        const pauseStart = Date.now();

        let pausedCount = 0;
        const pausePromises = scheduleHandles.map(async (handle) => {
            await handle.pause();
            pausedCount++;
            if (pausedCount % 100 === 0) {
                console.log(`  [PAUSE] ${pausedCount}/${NUM_SCHEDULES}`);
            }
        });

        await Promise.all(pausePromises);
        const pauseTime = Date.now() - pauseStart;
        const pauseRate = NUM_SCHEDULES / (pauseTime / 1000);

        console.log(`[OK] Paused ${pausedCount} schedules in ${pauseTime}ms (${pauseRate.toFixed(2)}/sec)\n`);

        // Verify pause status
        const pausedList = await reseolio.listSchedules({ status: 'paused', limit: NUM_SCHEDULES + 100 });
        const actualPaused = pausedList.schedules.filter(s => s.name.includes(runId)).length;
        console.log(`  Verified: ${actualPaused} schedules are paused\n`);

        // ========== PHASE 4: Bulk Resume Operations ==========
        console.log(`=> Resuming all schedules...`);
        const resumeStart = Date.now();

        let resumedCount = 0;
        const resumePromises = scheduleHandles.map(async (handle) => {
            await handle.resume();
            resumedCount++;
            if (resumedCount % 100 === 0) {
                console.log(`  [RESUME] ${resumedCount}/${NUM_SCHEDULES}`);
            }
        });

        await Promise.all(resumePromises);
        const resumeTime = Date.now() - resumeStart;
        const resumeRate = NUM_SCHEDULES / (resumeTime / 1000);

        console.log(`[OK] Resumed ${resumedCount} schedules in ${resumeTime}ms (${resumeRate.toFixed(2)}/sec)\n`);

        // ========== PHASE 5: Bulk Delete Operations ==========
        console.log(`=> Deleting all schedules...`);
        const deleteStart = Date.now();

        let deletedCount = 0;
        const deletePromises = scheduleHandles.map(async (handle) => {
            await handle.delete();
            deletedCount++;
            if (deletedCount % 100 === 0) {
                console.log(`  [DELETE] ${deletedCount}/${NUM_SCHEDULES}`);
            }
        });

        await Promise.all(deletePromises);
        const deleteTime = Date.now() - deleteStart;
        const deleteRate = NUM_SCHEDULES / (deleteTime / 1000);

        console.log(`[OK] Deleted ${deletedCount} schedules in ${deleteTime}ms (${deleteRate.toFixed(2)}/sec)\n`);

        // ========== RESULTS ==========
        const totalTime = Date.now() - createStart;

        console.log(`\n========================================`);
        console.log(`RESULTS`);
        console.log(`========================================`);
        console.log(`Schedules:            ${NUM_SCHEDULES}`);
        console.log(`\nThroughput (ops/sec):`);
        console.log(`  Create:             ${createRate.toFixed(2)}`);
        console.log(`  Pause:              ${pauseRate.toFixed(2)}`);
        console.log(`  Resume:             ${resumeRate.toFixed(2)}`);
        console.log(`  Delete:             ${deleteRate.toFixed(2)}`);
        console.log(`\nLatency (ms):`);
        console.log(`  Create (total):     ${createTime}`);
        console.log(`  List:               ${listTime}`);
        console.log(`  Pause (total):      ${pauseTime}`);
        console.log(`  Resume (total):     ${resumeTime}`);
        console.log(`  Delete (total):     ${deleteTime}`);
        console.log(`\nTotal Time:           ${totalTime}ms`);
        console.log(`========================================\n`);

        // Success criteria
        const passed = scheduleHandles.length === NUM_SCHEDULES &&
            createRate > 10 &&
            pauseRate > 10 &&
            resumeRate > 10 &&
            deleteRate > 10;

        if (passed) {
            console.log(`[PASS] TEST PASSED`);
            console.log(`  - All ${NUM_SCHEDULES} schedules created`);
            console.log(`  - All operations > 10 ops/sec\n`);
        } else {
            console.log(`[FAIL] TEST FAILED`);
            if (scheduleHandles.length !== NUM_SCHEDULES) {
                console.log(`  - Expected ${NUM_SCHEDULES} schedules, got ${scheduleHandles.length}`);
            }
            if (createRate <= 10) console.log(`  - Create rate too slow: ${createRate.toFixed(2)}/sec`);
            if (pauseRate <= 10) console.log(`  - Pause rate too slow: ${pauseRate.toFixed(2)}/sec`);
            if (resumeRate <= 10) console.log(`  - Resume rate too slow: ${resumeRate.toFixed(2)}/sec`);
            if (deleteRate <= 10) console.log(`  - Delete rate too slow: ${deleteRate.toFixed(2)}/sec`);
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
