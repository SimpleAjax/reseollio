/**
 * LOAD TEST 11: High-Frequency Schedule Updates
 * 
 * Tests: Rapid schedule updates and state changes
 * Scenario: Schedules being frequently modified (cron, pause/resume)
 * Validates: System handles high update rates without corruption
 */

import './preload-tracing';
import { Reseolio } from '../../dist/index.js';

async function main() {
    const NUM_SCHEDULES = 50;
    const UPDATES_PER_SCHEDULE = 20;
    const TOTAL_UPDATES = NUM_SCHEDULES * UPDATES_PER_SCHEDULE;

    console.log(`\n========================================`);
    console.log(`LOAD TEST: High-Frequency Schedule Updates`);
    console.log(`========================================`);
    console.log(`Schedules:            ${NUM_SCHEDULES}`);
    console.log(`Updates per schedule: ${UPDATES_PER_SCHEDULE}`);
    console.log(`Total updates:        ${TOTAL_UPDATES}\n`);

    const reseolio = new Reseolio({
        storage: process.env.RESEOLIO_DB || 'localhost:50051',
        autoStart: false,
    });

    try {
        await reseolio.start();
        const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

        // Define handlers
        // Define handlers
        const handlers: any[] = [];
        for (let i = 0; i < NUM_SCHEDULES; i++) {
            handlers.push(
                reseolio.durable(`loadtest:update-test-${runId}-${i}`, async () => {
                    return { executed: true, schedule: i };
                })
            );
        }

        // ========== PHASE 1: Create Schedules ==========
        console.log(`=> Creating ${NUM_SCHEDULES} schedules...`);
        const createStart = Date.now();

        const scheduleHandles = [];
        for (let i = 0; i < NUM_SCHEDULES; i++) {
            const handle = await handlers[i].schedule({
                cron: '0 * * * *',
                timezone: 'UTC',
            });
            scheduleHandles.push(handle);
        }

        const createTime = Date.now() - createStart;
        console.log(`[OK] Created ${scheduleHandles.length} schedules in ${createTime}ms\n`);

        // ========== PHASE 2: Rapid Updates ==========
        console.log(`=> Performing ${TOTAL_UPDATES} rapid updates...`);
        const updateStart = Date.now();

        const cronExpressions = [
            '* * * * *',     // Every minute
            '*/5 * * * *',   // Every 5 minutes
            '*/15 * * * *',  // Every 15 minutes
            '0 * * * *',     // Hourly
            '0 */2 * * *',   // Every 2 hours
        ];

        const timezones = ['UTC', 'America/New_York', 'Europe/London', 'Asia/Tokyo'];

        let successfulUpdates = 0;
        let failedUpdates = 0;
        const updatePromises: Promise<void>[] = [];

        for (const handle of scheduleHandles) {
            for (let u = 0; u < UPDATES_PER_SCHEDULE; u++) {
                const updateType = u % 4;

                updatePromises.push((async () => {
                    try {
                        switch (updateType) {
                            case 0: // Update cron
                                await handle.update({
                                    cron: cronExpressions[u % cronExpressions.length],
                                });
                                break;
                            case 1: // Pause
                                await handle.pause();
                                break;
                            case 2: // Resume
                                await handle.resume();
                                break;
                            case 3: // Update timezone
                                await handle.update({
                                    timezone: timezones[u % timezones.length],
                                });
                                break;
                        }
                        successfulUpdates++;
                    } catch (error) {
                        failedUpdates++;
                    }
                })());
            }
        }

        await Promise.all(updatePromises);
        const updateTime = Date.now() - updateStart;
        const updateRate = TOTAL_UPDATES / (updateTime / 1000);

        console.log(`[OK] Completed ${successfulUpdates} updates in ${updateTime}ms`);
        console.log(`     Update rate: ${updateRate.toFixed(2)} updates/sec`);
        console.log(`     Failed updates: ${failedUpdates}\n`);

        // ========== PHASE 3: Verify State Consistency ==========
        console.log(`=> Verifying schedule states...`);
        const verifyStart = Date.now();

        let validSchedules = 0;
        let invalidSchedules = 0;

        for (const handle of scheduleHandles) {
            try {
                const details = await handle.details();

                // Verify schedule has valid state
                if (details.id && details.name && details.cronExpression) {
                    validSchedules++;
                } else {
                    invalidSchedules++;
                }
            } catch (error) {
                invalidSchedules++;
            }
        }

        const verifyTime = Date.now() - verifyStart;
        console.log(`[OK] Verified ${validSchedules} valid schedules in ${verifyTime}ms`);
        if (invalidSchedules > 0) {
            console.log(`     Invalid schedules: ${invalidSchedules}`);
        }
        console.log();

        // ========== PHASE 4: Cleanup ==========
        console.log(`=> Cleaning up...`);
        const cleanupStart = Date.now();

        for (const handle of scheduleHandles) {
            await handle.delete().catch(() => { });
        }

        const cleanupTime = Date.now() - cleanupStart;
        console.log(`[OK] Cleaned up in ${cleanupTime}ms\n`);

        // ========== RESULTS ==========
        const totalTime = Date.now() - createStart;

        console.log(`\n========================================`);
        console.log(`RESULTS`);
        console.log(`========================================`);
        console.log(`Schedules:            ${NUM_SCHEDULES}`);
        console.log(`Total Updates:        ${TOTAL_UPDATES}`);
        console.log(`Successful Updates:   ${successfulUpdates}`);
        console.log(`Failed Updates:       ${failedUpdates}`);
        console.log(`Valid After Updates:  ${validSchedules}`);
        console.log(`\nThroughput:`);
        console.log(`  Update Rate:        ${updateRate.toFixed(2)} updates/sec`);
        console.log(`\nTiming:`);
        console.log(`  Create Time:        ${createTime}ms`);
        console.log(`  Update Time:        ${updateTime}ms`);
        console.log(`  Verify Time:        ${verifyTime}ms`);
        console.log(`  Total Time:         ${totalTime}ms`);
        console.log(`========================================\n`);

        // Success criteria
        const highSuccessRate = successfulUpdates >= TOTAL_UPDATES * 0.95; // Allow 5% failures
        const allValid = validSchedules === NUM_SCHEDULES;

        const passed = highSuccessRate && allValid;

        if (passed) {
            console.log(`[PASS] TEST PASSED`);
            console.log(`  - ${successfulUpdates}/${TOTAL_UPDATES} updates successful`);
            console.log(`  - All ${validSchedules} schedules remain valid\n`);
        } else {
            console.log(`[FAIL] TEST FAILED`);
            if (!highSuccessRate) {
                console.log(`  - Too many failed updates: ${failedUpdates}`);
            }
            if (!allValid) {
                console.log(`  - Invalid schedules after updates: ${invalidSchedules}`);
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
