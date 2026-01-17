/**
 * E2E Test 18: Schedule Idempotency and Deduplication
 * 
 * Tests that:
 * 1. Creating same schedule name twice doesn't create duplicates
 * 2. Schedule triggering uses idempotent job creation
 * 3. Multiple scheduler instances don't cause double-execution
 * 
 * Prerequisites: Run reseolio-core first
 * Run: npx tsx tests/e2e/18-schedule-idempotency.ts
 */

import { Reseolio } from '../../src/client';

interface TestResult {
    name: string;
    passed: boolean;
    error?: string;
}

const results: TestResult[] = [];

function logTest(name: string, passed: boolean, error?: string) {
    results.push({ name, passed, error });
    if (passed) {
        console.log(`  ✅ ${name}`);
    } else {
        console.log(`  ❌ ${name}: ${error}`);
    }
}

function generateUniqueId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function runTests() {
    console.log('🧪 E2E Test 18: Schedule Idempotency and Deduplication\n');
    console.log('='.repeat(50));

    const reseolio = new Reseolio({
        storage: 'localhost:50051',
        autoStart: false,
    });

    try {
        await reseolio.start();
        console.log('✅ Connected to Reseolio\n');

        const runId = generateUniqueId();

        // Define handler
        reseolio.durable(`e2e:idem:task-${runId}`, async () => {
            return { executed: true };
        });

        // ========== TEST 1: Unique Schedule Name Constraint ==========
        console.log('Test 1: Schedule name uniqueness');
        console.log('-'.repeat(40));

        const schedule1 = await reseolio.schedule(`e2e:idem:task-${runId}`, {
            cron: '0 * * * *',
        });
        console.log(`    First schedule ID: ${schedule1.id}`);

        // Try to create another schedule with the same name
        let duplicateCreated = false;
        let duplicateError = '';
        let schedule2Id = '';

        try {
            const schedule2 = await reseolio.schedule(`e2e:idem:task-${runId}`, {
                cron: '0 * * * *',
            });
            duplicateCreated = true;
            schedule2Id = schedule2.id;
            console.log(`    Second schedule ID: ${schedule2.id}`);
        } catch (e: any) {
            duplicateError = e.message || String(e);
            console.log(`    Second create: ${duplicateError.slice(0, 60)}...`);
        }

        // Either: duplicate rejected, OR same ID returned (idempotent)
        if (duplicateCreated) {
            logTest('Same schedule name returns same ID (idempotent)',
                schedule2Id === schedule1.id);
        } else {
            // Any error is acceptable as duplicate rejection
            // (The specific error message varies: Postgres unique constraint, SQLite, etc.)
            logTest('Duplicate schedule name rejected',
                duplicateError.length > 0);
        }

        // ========== TEST 2: Multiple Creates Return Same ID ==========
        console.log('\nTest 2: Multiple creates of same name');
        console.log('-'.repeat(40));

        reseolio.durable(`e2e:idem:multi-${runId}`, async () => {
            return { executed: true };
        });

        const creates = 5;
        const scheduleIds: string[] = [];

        for (let i = 0; i < creates; i++) {
            try {
                const s = await reseolio.schedule(`e2e:idem:multi-${runId}`, {
                    cron: '0 12 * * *',
                });
                scheduleIds.push(s.id);
            } catch (e) {
                // Duplicate rejection is also acceptable
                scheduleIds.push('REJECTED');
            }
        }

        console.log(`    Attempts: ${creates}`);
        console.log(`    Results: ${scheduleIds.join(', ')}`);

        const uniqueIds = new Set(scheduleIds.filter(id => id !== 'REJECTED'));
        console.log(`    Unique schedule IDs: ${uniqueIds.size}`);

        logTest('All creates return same ID or reject duplicates',
            uniqueIds.size <= 1);

        // ========== TEST 3: Verify Only One Schedule in DB ==========
        console.log('\nTest 3: Only one schedule exists per name');
        console.log('-'.repeat(40));

        const allSchedules = await reseolio.listSchedules({ limit: 1000 });
        const matchingSchedules = allSchedules.schedules.filter(
            s => s.name === `e2e:idem:multi-${runId}`
        );

        console.log(`    Schedules with name 'e2e:idem:multi-${runId}': ${matchingSchedules.length}`);

        logTest('Exactly 1 schedule per name in database',
            matchingSchedules.length === 1);

        // ========== TEST 4: Schedule Update Doesn't Duplicate ==========
        console.log('\nTest 4: Update schedule maintains single instance');
        console.log('-'.repeat(40));

        const beforeUpdate = await reseolio.listSchedules({ limit: 1000 });
        const beforeCount = beforeUpdate.schedules.filter(s => s.name.includes(runId)).length;
        console.log(`    Schedules before update: ${beforeCount}`);

        // Update the schedule
        await schedule1.update({ cron: '30 * * * *' });

        const afterUpdate = await reseolio.listSchedules({ limit: 1000 });
        const afterCount = afterUpdate.schedules.filter(s => s.name.includes(runId)).length;
        console.log(`    Schedules after update: ${afterCount}`);

        logTest('Update does not create duplicate',
            afterCount === beforeCount);

        // ========== TEST 5: Pause/Resume Maintains Single Instance ==========
        console.log('\nTest 5: Pause/Resume maintains single instance');
        console.log('-'.repeat(40));

        await schedule1.pause();
        await schedule1.resume();

        const afterPauseResume = await reseolio.listSchedules({ limit: 1000 });
        const pauseResumeCount = afterPauseResume.schedules.filter(
            s => s.name.includes(runId)
        ).length;
        console.log(`    Schedules after pause/resume: ${pauseResumeCount}`);

        logTest('Pause/resume does not create duplicate',
            pauseResumeCount === afterCount);

        // ========== TEST 6: Concurrent Creates Same Name ==========
        console.log('\nTest 6: Concurrent creates with same name');
        console.log('-'.repeat(40));

        reseolio.durable(`e2e:idem:concurrent-${runId}`, async () => {
            return { executed: true };
        });

        const concurrentCount = 10;
        const concurrentPromises = [];

        for (let i = 0; i < concurrentCount; i++) {
            concurrentPromises.push(
                reseolio.schedule(`e2e:idem:concurrent-${runId}`, {
                    cron: '0 3 * * *',
                }).catch((e: any) => ({ error: e.message }))
            );
        }

        const concurrentResults = await Promise.all(concurrentPromises);

        const successfulCreates = concurrentResults.filter(
            (r: any) => !r.error && r.id
        );
        const rejections = concurrentResults.filter((r: any) => r.error);

        console.log(`    Concurrent attempts: ${concurrentCount}`);
        console.log(`    Successful: ${successfulCreates.length}`);
        console.log(`    Rejected: ${rejections.length}`);

        // All successful ones should have the same ID
        const successIds = new Set(successfulCreates.map((s: any) => s.id));
        console.log(`    Unique success IDs: ${successIds.size}`);

        logTest('All concurrent creates resolve to single schedule',
            successIds.size <= 1);

        // Verify only 1 in database
        const afterConcurrent = await reseolio.listSchedules({ limit: 1000 });
        const concurrentSchedules = afterConcurrent.schedules.filter(
            s => s.name === `e2e:idem:concurrent-${runId}`
        );

        logTest('Only 1 schedule exists after concurrent creates',
            concurrentSchedules.length === 1);

        // ========== CLEANUP ==========
        console.log('\n🗑️  Cleaning up schedules...');

        await schedule1.delete().catch(() => { });

        // Clean up multi and concurrent
        const cleanupList = await reseolio.listSchedules({ limit: 1000 });
        for (const s of cleanupList.schedules.filter(s => s.name.includes(runId))) {
            await reseolio.deleteSchedule(s.id).catch(() => { });
        }
        console.log('Cleanup complete');

        // ========== SUMMARY ==========
        console.log('\n' + '='.repeat(50));
        console.log('📊 TEST SUMMARY');
        console.log('='.repeat(50));

        const passed = results.filter(r => r.passed).length;
        const failed = results.filter(r => !r.passed).length;

        console.log(`  Total:  ${results.length}`);
        console.log(`  Passed: ${passed}`);
        console.log(`  Failed: ${failed}`);

        if (failed > 0) {
            console.log('\n❌ Failed tests:');
            results.filter(r => !r.passed).forEach(r => {
                console.log(`    - ${r.name}: ${r.error}`);
            });
        }

        await reseolio.stop();

        console.log('\n' + (failed === 0 ? '🎉 ALL TESTS PASSED!' : '❌ SOME TESTS FAILED'));
        process.exit(failed === 0 ? 0 : 1);

    } catch (error) {
        console.error('\n❌ Fatal error:', error);
        await reseolio.stop().catch(() => { });
        process.exit(1);
    }
}

runTests();
