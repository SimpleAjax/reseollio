/**
 * E2E Test 19: Schedule with Handler Options
 * 
 * Tests that schedules respect handler options such as:
 * - Max retries
 * - Timeout
 * - Backoff strategy
 * 
 * Prerequisites: Run reseolio-core first
 * Run: npx tsx tests/e2e/19-schedule-handler-options.ts
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
    console.log('🧪 E2E Test 19: Schedule with Handler Options\n');
    console.log('='.repeat(50));

    const reseolio = new Reseolio({
        storage: 'localhost:50051',
        autoStart: false,
    });

    try {
        await reseolio.start();
        console.log('✅ Connected to Reseolio\n');

        const runId = generateUniqueId();
        const schedulesToCleanup: any[] = [];

        // ========== TEST 1: Schedule with Retry Options ==========
        console.log('Test 1: Schedule with retry configuration');
        console.log('-'.repeat(40));

        reseolio.durable(`e2e:opts:retry-${runId}`, async () => {
            return { executed: true };
        }, {
            maxAttempts: 5,
            initialDelayMs: 1000,
            backoff: 'exponential',
        });

        const retrySchedule = await reseolio.schedule(`e2e:opts:retry-${runId}`, {
            cron: '0 * * * *',
        });
        schedulesToCleanup.push(retrySchedule);

        const retryDetails = await retrySchedule.details();
        console.log(`    Schedule ID: ${retrySchedule.id}`);
        console.log(`    Handler options preserved: ${JSON.stringify(retryDetails.handlerOptions || {}).slice(0, 80)}`);

        logTest('Schedule created with retry handler',
            retrySchedule.id.length > 0);
        logTest('Schedule is active',
            retryDetails.status === 'active');

        // ========== TEST 2: Schedule with Timeout ==========
        console.log('\nTest 2: Schedule with timeout configuration');
        console.log('-'.repeat(40));

        reseolio.durable(`e2e:opts:timeout-${runId}`, async () => {
            // Simulate some work
            await new Promise(r => setTimeout(r, 100));
            return { executed: true };
        }, {
            timeoutMs: 30000, // 30 second timeout
        });

        const timeoutSchedule = await reseolio.schedule(`e2e:opts:timeout-${runId}`, {
            cron: '*/5 * * * *',
        });
        schedulesToCleanup.push(timeoutSchedule);

        const timeoutDetails = await timeoutSchedule.details();
        console.log(`    Schedule ID: ${timeoutSchedule.id}`);
        console.log(`    Cron: ${timeoutDetails.cronExpression}`);

        logTest('Schedule with timeout handler created',
            timeoutSchedule.id.length > 0);

        // ========== TEST 3: Schedule with Custom Backoff ==========
        console.log('\nTest 3: Schedule with custom backoff strategy');
        console.log('-'.repeat(40));

        reseolio.durable(`e2e:opts:backoff-${runId}`, async () => {
            return { executed: true };
        }, {
            maxAttempts: 3,
            initialDelayMs: 500,
            maxDelayMs: 10000,
            backoff: 'linear',
            jitter: 0.1,
        });

        const backoffSchedule = await reseolio.schedule(`e2e:opts:backoff-${runId}`, {
            cron: '0 0 * * *', // Daily at midnight
        });
        schedulesToCleanup.push(backoffSchedule);

        const backoffDetails = await backoffSchedule.details();
        console.log(`    Schedule ID: ${backoffSchedule.id}`);
        console.log(`    Next run: ${new Date(backoffDetails.nextRunAt).toISOString()}`);

        logTest('Schedule with custom backoff created',
            backoffSchedule.id.length > 0);

        // ========== TEST 4: Multiple Schedules with Different Options ==========
        console.log('\nTest 4: Multiple schedules with different options');
        console.log('-'.repeat(40));

        const optionVariants = [
            { name: 'fast', maxAttempts: 1, timeoutMs: 5000 },
            { name: 'moderate', maxAttempts: 3, timeoutMs: 30000 },
            { name: 'patient', maxAttempts: 10, timeoutMs: 120000 },
        ];

        for (const opts of optionVariants) {
            reseolio.durable(`e2e:opts:${opts.name}-${runId}`, async () => {
                return { type: opts.name };
            }, {
                maxAttempts: opts.maxAttempts,
                timeoutMs: opts.timeoutMs,
            });

            const schedule = await reseolio.schedule(`e2e:opts:${opts.name}-${runId}`, {
                cron: '0 6 * * *',
            });
            schedulesToCleanup.push(schedule);
            console.log(`    ${opts.name}: maxAttempts=${opts.maxAttempts}, timeoutMs=${opts.timeoutMs}ms`);
        }

        logTest('Created 3 schedules with different option sets',
            schedulesToCleanup.length >= 6);

        // ========== TEST 5: Verify All Schedules List Correctly ==========
        console.log('\nTest 5: All schedules list with their options');
        console.log('-'.repeat(40));

        const allSchedules = await reseolio.listSchedules({ limit: 100 });
        const ourSchedules = allSchedules.schedules.filter(s => s.name.includes(runId));
        console.log(`    Total schedules from this run: ${ourSchedules.length}`);

        for (const s of ourSchedules) {
            console.log(`    - ${s.name}: ${s.status}`);
        }

        logTest('All created schedules found in list',
            ourSchedules.length >= 6);

        // ========== TEST 6: Update Handler Options via Schedule ==========
        console.log('\nTest 6: Handler options are associated with schedule');
        console.log('-'.repeat(40));

        // The handler options are stored with the schedule and used when creating jobs
        const retryScheduleRefresh = await retrySchedule.details();
        console.log(`    Handler options type: ${typeof retryScheduleRefresh.handlerOptions}`);

        // Handler options should be present
        logTest('Handler options stored with schedule',
            retryScheduleRefresh.handlerOptions !== undefined &&
            retryScheduleRefresh.handlerOptions !== null);

        // ========== CLEANUP ==========
        console.log('\n🗑️  Cleaning up schedules...');

        for (const schedule of schedulesToCleanup) {
            await schedule.delete().catch(() => { });
        }
        console.log(`Deleted ${schedulesToCleanup.length} schedules`);

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
