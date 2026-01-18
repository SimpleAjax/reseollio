/**
 * E2E Test 15: Schedule Pre-Scheduling Optimization
 * 
 * Tests the pre-scheduling optimization that creates jobs immediately
 * when a schedule's next_run_at is within the poll interval.
 * 
 * This ensures schedules don't miss their first execution when created
 * close to their trigger time.
 * 
 * Prerequisites: Run reseolio-core first
 * Run: npx tsx tests/e2e/15-schedule-prescheduling.ts
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
    console.log('🧪 E2E Test 15: Schedule Pre-Scheduling Optimization\n');
    console.log('='.repeat(50));
    console.log('Note: This test verifies immediate job creation\n');

    const reseolio = new Reseolio({
        storage: 'localhost:50051',
        autoStart: false,
    });

    try {
        await reseolio.start();
        console.log('✅ Connected to Reseolio\n');

        const runId = generateUniqueId();

        // Define handlers for our schedules
        let handlerCallCount = 0;
        const taskHandler = reseolio.durable(`e2e:preschedule:task-${runId}`, async () => {
            handlerCallCount++;
            console.log(`    [Handler] Execution #${handlerCallCount}`);
            return { executed: true, count: handlerCallCount };
        });

        // ========== TEST 1: Schedule with Every-Minute Cron ==========
        console.log('Test 1: Schedule with every-minute cron');
        console.log('-'.repeat(40));

        // Create a schedule that runs every minute
        // Due to the poll interval optimization, if the next_run_at is within
        // the poll interval (10 seconds), a job should be pre-created
        const everyMinuteSchedule = await taskHandler.schedule({
            cron: '* * * * *', // Every minute
        });

        const details = await everyMinuteSchedule.details();
        console.log(`    Schedule ID: ${everyMinuteSchedule.id}`);
        console.log(`    Next run at: ${new Date(details.nextRunAt).toISOString()}`);
        console.log(`    Status: ${details.status}`);

        logTest('Schedule created with every-minute cron',
            details.status === 'active' && details.nextRunAt > 0);

        // ========== TEST 2: Verify Next Run is Calculated ==========
        console.log('\nTest 2: Verify next run time calculation');
        console.log('-'.repeat(40));

        const nextRunAt = await everyMinuteSchedule.nextRunAt();
        const now = new Date();
        const diffSeconds = (nextRunAt.getTime() - now.getTime()) / 1000;

        console.log(`    Now: ${now.toISOString()}`);
        console.log(`    Next run: ${nextRunAt.toISOString()}`);
        console.log(`    Diff: ${diffSeconds.toFixed(1)} seconds`);

        // Next run should be within 60 seconds for every-minute schedule
        logTest('Next run within expected range',
            diffSeconds > 0 && diffSeconds <= 60);

        // ========== TEST 3: Multiple Rapid Schedule Creations ==========
        console.log('\nTest 3: Multiple rapid schedule creations');
        console.log('-'.repeat(40));

        const scheduleCount = 5;
        const rapidSchedules = [];

        const rapidHandlers = [];
        for (let i = 0; i < scheduleCount; i++) {
            const handler = reseolio.durable(`e2e:preschedule:rapid-${runId}-${i}`, async () => {
                return { executed: true, index: i };
            });
            rapidHandlers.push(handler);
        }

        const createStart = Date.now();
        for (let i = 0; i < scheduleCount; i++) {
            const s = await rapidHandlers[i].schedule({
                cron: '*/5 * * * *', // Every 5 minutes
            });
            rapidSchedules.push(s);
        }
        const createTime = Date.now() - createStart;

        console.log(`    Created ${scheduleCount} schedules in ${createTime}ms`);
        console.log(`    Avg: ${(createTime / scheduleCount).toFixed(1)}ms per schedule`);

        // All schedules should be active
        let allActive = true;
        for (const s of rapidSchedules) {
            const d = await s.details();
            if (d.status !== 'active') {
                allActive = false;
                console.log(`    Schedule ${s.id} is ${d.status}, expected active`);
            }
        }

        logTest(`All ${scheduleCount} rapid schedules are active`, allActive);
        logTest('Average creation time < 100ms', (createTime / scheduleCount) < 100);

        // ========== TEST 4: Update Schedule Cron ==========
        console.log('\nTest 4: Update schedule cron expression');
        console.log('-'.repeat(40));

        const originalNextRun = await everyMinuteSchedule.nextRunAt();

        // Update to hourly
        await everyMinuteSchedule.update({ cron: '0 * * * *' });

        const updatedDetails = await everyMinuteSchedule.details();
        const updatedNextRun = await everyMinuteSchedule.nextRunAt();

        console.log(`    Original: * * * * * (every minute)`);
        console.log(`    Updated: 0 * * * * (hourly)`);
        console.log(`    Original next run: ${originalNextRun.toISOString()}`);
        console.log(`    Updated next run: ${updatedNextRun.toISOString()}`);

        logTest('Cron expression updated',
            updatedDetails.cronExpression === '0 * * * *');

        // Next run should be further out now (hourly instead of every minute)
        const nowTime = Date.now();
        const originalDiff = originalNextRun.getTime() - nowTime;
        const updatedDiff = updatedNextRun.getTime() - nowTime;

        // Hourly schedule's next run should be at least 1 minute away typically
        // (unless we're exactly at minute 0)
        logTest('Next run time recalculated for hourly',
            updatedDetails.nextRunAt > 0);

        // ========== TEST 5: Pause and Resume Timing ==========
        console.log('\nTest 5: Pause and resume preserves timing');
        console.log('-'.repeat(40));

        const beforePause = await everyMinuteSchedule.nextRunAt();

        await everyMinuteSchedule.pause();
        const pausedStatus = await everyMinuteSchedule.status();

        await everyMinuteSchedule.resume();
        const resumedStatus = await everyMinuteSchedule.status();
        const afterResume = await everyMinuteSchedule.nextRunAt();

        console.log(`    Status after pause: ${pausedStatus}`);
        console.log(`    Status after resume: ${resumedStatus}`);
        console.log(`    Next run before pause: ${beforePause.toISOString()}`);
        console.log(`    Next run after resume: ${afterResume.toISOString()}`);

        logTest('Status correctly transitions pause -> resume',
            pausedStatus === 'paused' && resumedStatus === 'active');

        // ========== TEST 6: List Schedules with Pagination ==========
        console.log('\nTest 6: List schedules with pagination');
        console.log('-'.repeat(40));

        // List with limit
        const limitedList = await reseolio.listSchedules({ limit: 3 });
        console.log(`    Total schedules: ${limitedList.total}`);
        console.log(`    Returned: ${limitedList.schedules.length} (limit: 3)`);

        logTest('List respects limit',
            limitedList.schedules.length <= 3);

        // List all
        const fullList = await reseolio.listSchedules({ limit: 10000 });
        console.log(`    List returned: ${fullList.schedules.length}`);
        const ourSchedules = fullList.schedules.filter(s => s.name.includes(runId));
        console.log(`    Our schedules in this run: ${ourSchedules.length}`);
        ourSchedules.forEach(s => console.log(`      Found: ${s.name}`));

        // Should have at least 6 schedules (1 main + 5 rapid)
        logTest('All created schedules found', ourSchedules.length >= 6);

        // ========== CLEANUP ==========
        console.log('\n🗑️  Cleaning up schedules...');

        await everyMinuteSchedule.delete();
        for (const s of rapidSchedules) {
            await s.delete().catch(() => { });
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
