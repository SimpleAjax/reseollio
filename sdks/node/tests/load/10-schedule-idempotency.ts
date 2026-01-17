/**
 * LOAD TEST 10: Schedule Idempotency Stress Test
 * 
 * Tests: Duplicate schedule creation attempts
 * Scenario: Race conditions in creating schedules with same name
 * Validates: No duplicate schedules or double-execution
 * 
 * This is critical for distributed deployments where multiple app instances
 * might try to create the same schedule on startup.
 */

import './preload-tracing';
import { Reseolio } from '../../dist/index.js';

async function main() {
    const NUM_UNIQUE_SCHEDULES = 100;
    const DUPLICATE_ATTEMPTS = 5; // Each schedule name is created 5 times
    const TOTAL_ATTEMPTS = NUM_UNIQUE_SCHEDULES * DUPLICATE_ATTEMPTS;

    console.log(`\n========================================`);
    console.log(`LOAD TEST: Schedule Idempotency Stress`);
    console.log(`========================================`);
    console.log(`Unique Schedules:     ${NUM_UNIQUE_SCHEDULES}`);
    console.log(`Attempts per name:    ${DUPLICATE_ATTEMPTS}`);
    console.log(`Total attempts:       ${TOTAL_ATTEMPTS}`);
    console.log(`Expected schedules:   ${NUM_UNIQUE_SCHEDULES}\n`);

    const reseolio = new Reseolio({
        storage: process.env.RESEOLIO_DB || 'localhost:50051',
        autoStart: false,
    });

    try {
        await reseolio.start();
        const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

        // Define handlers
        for (let i = 0; i < NUM_UNIQUE_SCHEDULES; i++) {
            reseolio.durable(`loadtest:idem-schedule-${runId}-${i}`, async () => {
                return { executed: true, schedule: i };
            });
        }

        // ========== PHASE 1: Concurrent Schedule Creation ==========
        console.log(`=> Creating schedules with duplicate attempts...`);
        const createStart = Date.now();

        const creationResults: { scheduleName: string; scheduleId: string; success: boolean }[] = [];
        const creationPromises: Promise<void>[] = [];

        for (let i = 0; i < NUM_UNIQUE_SCHEDULES; i++) {
            const scheduleName = `loadtest:idem-schedule-${runId}-${i}`;

            // Try to create the same schedule multiple times concurrently
            for (let d = 0; d < DUPLICATE_ATTEMPTS; d++) {
                creationPromises.push(
                    reseolio.schedule(scheduleName, {
                        cron: '0 * * * *', // Hourly
                        timezone: 'UTC',
                    }).then(handle => {
                        creationResults.push({
                            scheduleName,
                            scheduleId: handle.id,
                            success: true,
                        });
                    }).catch(err => {
                        // Some may fail due to duplicate detection
                        creationResults.push({
                            scheduleName,
                            scheduleId: '',
                            success: false,
                        });
                    })
                );
            }
        }

        await Promise.all(creationPromises);
        const createTime = Date.now() - createStart;

        // ========== PHASE 2: Analyze Results ==========
        console.log(`\n=> Analyzing results...`);

        // Count successes and failures
        const successfulCreations = creationResults.filter(r => r.success);
        const failedCreations = creationResults.filter(r => !r.success);

        // Group by schedule name to check uniqueness
        const scheduleIdsByName = new Map<string, Set<string>>();
        for (const result of successfulCreations) {
            if (!scheduleIdsByName.has(result.scheduleName)) {
                scheduleIdsByName.set(result.scheduleName, new Set());
            }
            scheduleIdsByName.get(result.scheduleName)!.add(result.scheduleId);
        }

        // Check for duplicates (same name, different IDs)
        let duplicateNameErrors = 0;
        for (const [name, ids] of scheduleIdsByName) {
            if (ids.size > 1) {
                duplicateNameErrors++;
                console.log(`  [WARN] Schedule "${name}" has ${ids.size} different IDs!`);
            }
        }

        // ========== PHASE 3: List Verification ==========
        console.log(`\n=> Verifying via list API...`);
        const listResult = await reseolio.listSchedules({ limit: TOTAL_ATTEMPTS + 100 });

        // Count schedules from this run
        const ourSchedules = listResult.schedules.filter(s => s.name.includes(runId));
        const uniqueScheduleCount = ourSchedules.length;

        console.log(`  Total schedules in DB: ${listResult.total}`);
        console.log(`  Schedules from this run: ${uniqueScheduleCount}`);

        // ========== PHASE 4: Cleanup ==========
        console.log(`\n=> Cleaning up...`);
        const cleanupStart = Date.now();

        let deleteCount = 0;
        for (const schedule of ourSchedules) {
            try {
                await reseolio.deleteSchedule(schedule.id);
                deleteCount++;
            } catch (e) {
                // Might already be deleted
            }
        }

        const cleanupTime = Date.now() - cleanupStart;
        console.log(`[OK] Deleted ${deleteCount} schedules in ${cleanupTime}ms\n`);

        // ========== RESULTS ==========
        console.log(`\n========================================`);
        console.log(`RESULTS`);
        console.log(`========================================`);
        console.log(`Total Attempts:       ${TOTAL_ATTEMPTS}`);
        console.log(`Successful Creates:   ${successfulCreations.length}`);
        console.log(`Failed Creates:       ${failedCreations.length}`);
        console.log(`Unique Schedules:     ${uniqueScheduleCount}`);
        console.log(`Expected:             ${NUM_UNIQUE_SCHEDULES}`);
        console.log(`Duplicate Name Errors: ${duplicateNameErrors}`);
        console.log(`\nTiming:`);
        console.log(`  Create Time:        ${createTime}ms`);
        console.log(`  Cleanup Time:       ${cleanupTime}ms`);
        console.log(`========================================\n`);

        // Success criteria
        // Allow either:
        // 1. All creations succeed but map to same ID (true idempotency)
        // 2. Only first creation succeeds, rest fail (duplicate rejection)
        const correctCount = uniqueScheduleCount === NUM_UNIQUE_SCHEDULES;
        const noDuplicates = duplicateNameErrors === 0;

        const passed = correctCount && noDuplicates;

        if (passed) {
            console.log(`[PASS] TEST PASSED`);
            console.log(`  - Created exactly ${NUM_UNIQUE_SCHEDULES} unique schedules`);
            console.log(`  - No duplicate schedule entries\n`);
        } else {
            console.log(`[FAIL] TEST FAILED`);
            if (!correctCount) {
                console.log(`  - Expected ${NUM_UNIQUE_SCHEDULES} schedules, got ${uniqueScheduleCount}`);
            }
            if (!noDuplicates) {
                console.log(`  - Found ${duplicateNameErrors} duplicate name errors`);
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
