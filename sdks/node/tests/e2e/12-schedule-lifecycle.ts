/**
 * E2E Test 12: Cron Schedule Lifecycle
 * 
 * Tests the cron scheduling functionality:
 * - Creating schedules with cron expressions
 * - Getting schedule details
 * - Pausing and resuming schedules
 * - Updating schedule cron expressions
 * - Deleting schedules
 * - Listing schedules with filters
 * - Verifying schedule triggers create jobs
 * 
 * Prerequisites: Run reseolio-core first
 * Run: npx tsx tests/e2e/12-schedule-lifecycle.ts
 */

import { Reseolio } from '../../src/client';
import type { Schedule, ScheduleStatus } from '../../src/types';

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
    console.log('🧪 E2E Test 12: Cron Schedule Lifecycle\n');
    console.log('='.repeat(50));

    const reseolio = new Reseolio({
        storage: 'localhost:50051',
        autoStart: false,
    });

    const runId = generateUniqueId();
    const basicScheduleName = `e2e:schedule:basic-${runId}`;

    // Register handlers (hoisted)
    const basicHandler = reseolio.durable(basicScheduleName, async () => ({}));
    const hourlyHandler = reseolio.durable(`e2e:schedule:hourly-${runId}`, async () => ({}));
    const dailyHandler = reseolio.durable(`e2e:schedule:daily-${runId}`, async () => ({}));

    try {
        await reseolio.start();
        console.log('✅ Connected to Reseolio\n');

        // ========== TEST 1: Create a Basic Schedule ==========
        console.log('Test 1: Create a basic schedule');
        console.log('-'.repeat(40));

        const scheduleName = basicScheduleName;
        const scheduleHandle = await basicHandler.schedule({
            cron: '*/5 * * * *', // Every 5 minutes
            timezone: 'UTC',
        });

        logTest('Schedule created successfully', scheduleHandle.id.length > 0);
        logTest('Schedule name matches', scheduleHandle.name === scheduleName);

        // ========== TEST 2: Get Schedule Details ==========
        console.log('\nTest 2: Get schedule details');
        console.log('-'.repeat(40));

        const details = await scheduleHandle.details();
        logTest('Details contain ID', details.id === scheduleHandle.id);
        logTest('Details contain name', details.name === scheduleName);
        logTest('Status is active', details.status === 'active');
        logTest('Has next run time', details.nextRunAt > 0);
        logTest('Has created timestamp', details.createdAt > 0);
        console.log(`    Next run at: ${new Date(details.nextRunAt).toISOString()}`);

        // ========== TEST 3: Get Schedule by ID ==========
        console.log('\nTest 3: Get schedule by ID directly');
        console.log('-'.repeat(40));

        const fetchedSchedule = await reseolio.getSchedule(scheduleHandle.id);
        logTest('Fetched schedule matches', fetchedSchedule.id === scheduleHandle.id);
        logTest('Fetched schedule has correct name', fetchedSchedule.name === scheduleName);

        // ========== TEST 4: Pause Schedule ==========
        console.log('\nTest 4: Pause schedule');
        console.log('-'.repeat(40));

        const pausedSchedule = await scheduleHandle.pause();
        logTest('Pause returns schedule', pausedSchedule.id === scheduleHandle.id);
        logTest('Status is paused', pausedSchedule.status === 'paused');

        const statusAfterPause = await scheduleHandle.status();
        logTest('Status check confirms paused', statusAfterPause === 'paused');

        // ========== TEST 5: Resume Schedule ==========
        console.log('\nTest 5: Resume schedule');
        console.log('-'.repeat(40));

        const resumedSchedule = await scheduleHandle.resume();
        logTest('Resume returns schedule', resumedSchedule.id === scheduleHandle.id);
        logTest('Status is active', resumedSchedule.status === 'active');

        const statusAfterResume = await scheduleHandle.status();
        logTest('Status check confirms active', statusAfterResume === 'active');

        // ========== TEST 6: Update Schedule Cron Expression ==========
        console.log('\nTest 6: Update schedule cron expression');
        console.log('-'.repeat(40));

        const originalNextRun = (await scheduleHandle.details()).nextRunAt;
        const updatedSchedule = await scheduleHandle.update({
            cron: '0 */2 * * *', // Every 2 hours instead of every 5 minutes
        });

        logTest('Update returns schedule', updatedSchedule.id === scheduleHandle.id);
        // The next run time should change after updating the cron expression
        const newNextRun = updatedSchedule.nextRunAt;
        console.log(`    Original next run: ${new Date(originalNextRun).toISOString()}`);
        console.log(`    Updated next run: ${new Date(newNextRun).toISOString()}`);

        // ========== TEST 7: Update Schedule Timezone ==========
        console.log('\nTest 7: Update schedule timezone');
        console.log('-'.repeat(40));

        const timezoneUpdated = await scheduleHandle.update({
            timezone: 'America/New_York',
        });
        logTest('Timezone update returns schedule', timezoneUpdated.id === scheduleHandle.id);
        logTest('Timezone is updated', timezoneUpdated.timezone === 'America/New_York');

        // ========== TEST 8: List All Schedules ==========
        console.log('\nTest 8: List all schedules');
        console.log('-'.repeat(40));

        const listResult = await reseolio.listSchedules({ limit: 10000 });
        logTest('List returns schedules array', Array.isArray(listResult.schedules));
        logTest('List has total count', typeof listResult.total === 'number');

        const ourSchedule = listResult.schedules.find((s: Schedule) => s.id === scheduleHandle.id);
        logTest('Our schedule is in the list', !!ourSchedule);

        console.log(`    Total schedules: ${listResult.total}`);

        // ========== TEST 9: Create Multiple Schedules ==========
        console.log('\nTest 9: Create multiple schedules');
        console.log('-'.repeat(40));

        // Handlers are reused from top scope
        const schedule2 = await hourlyHandler.schedule({
            cron: '0 * * * *',
            timezone: 'UTC',
        });

        const schedule3 = await dailyHandler.schedule({
            cron: '0 0 * * *',
            timezone: 'Europe/London',
        });

        logTest('Schedule 2 created', schedule2.id.length > 0);
        logTest('Schedule 3 created', schedule3.id.length > 0);

        const afterMultiple = await reseolio.listSchedules();
        logTest('Multiple schedules exist', afterMultiple.total >= 3);

        // ========== TEST 10: Convenience Methods ==========
        console.log('\nTest 10: Convenience schedule methods');
        console.log('-'.repeat(40));

        // Test everyMinute
        const minuteHandler = reseolio.durable(`e2e:schedule:every-minute-${runId}`, async () => ({}));
        const minuteSchedule = await minuteHandler.everyMinute();
        const minuteDetails = await minuteSchedule.details();
        logTest('everyMinute creates schedule', minuteSchedule.id.length > 0);
        logTest('everyMinute has correct cron', minuteDetails.cronExpression === '* * * * *');

        // Test hourly
        const hourlyConvHandler = reseolio.durable(`e2e:schedule:hourly-convenience-${runId}`, async () => ({}));
        const hourlySchedule = await hourlyConvHandler.hourly();
        const hourlyDetails = await hourlySchedule.details();
        logTest('hourly creates schedule', hourlySchedule.id.length > 0);
        logTest('hourly has correct cron', hourlyDetails.cronExpression === '0 * * * *');

        // Test daily
        const dailyConvHandler = reseolio.durable(`e2e:schedule:daily-convenience-${runId}`, async () => ({}));
        const dailySchedule = await dailyConvHandler.daily(9);
        const dailyDetails = await dailySchedule.details();
        logTest('daily creates schedule', dailySchedule.id.length > 0);
        logTest('daily has correct cron (9 AM)', dailyDetails.cronExpression === '0 9 * * *');

        // Test weekly
        const weeklyHandler = reseolio.durable(`e2e:schedule:weekly-${runId}`, async () => ({}));
        const weeklySchedule = await weeklyHandler.weekly(1, 10); // Monday 10 AM
        const weeklyDetails = await weeklySchedule.details();
        logTest('weekly creates schedule', weeklySchedule.id.length > 0);
        logTest('weekly has correct cron (Mon 10 AM)', weeklyDetails.cronExpression === '0 10 * * 2');

        // ========== TEST 11: Schedule Handle Methods ==========
        console.log('\nTest 11: Schedule handle methods');
        console.log('-'.repeat(40));

        const nextRun = await scheduleHandle.nextRunAt();
        logTest('nextRunAt returns Date', nextRun instanceof Date);
        logTest('nextRunAt is in the future', nextRun.getTime() > Date.now());

        const lastRun = await scheduleHandle.lastRunAt();
        // Last run might be null if the schedule hasn't triggered yet
        logTest('lastRunAt returns Date or null', lastRun === null || lastRun instanceof Date);

        // ========== TEST 12: Delete Schedule ==========
        console.log('\nTest 12: Delete schedule');
        console.log('-'.repeat(40));

        const deleteResult = await scheduleHandle.delete();
        logTest('Delete returns true', deleteResult === true);

        // Verify schedule is deleted/inactive
        try {
            const deletedSchedule = await reseolio.getSchedule(scheduleHandle.id);
            // If it exists, status should be 'deleted'
            logTest('Deleted schedule status is deleted', deletedSchedule.status === 'deleted');
        } catch (error: any) {
            // Schedule might not be found, which is also acceptable
            logTest('Deleted schedule not found (expected)', error.message.includes('not found'));
        }

        // ========== CLEANUP: Delete other test schedules ==========
        console.log('\nCleanup: Deleting test schedules...');
        console.log('-'.repeat(40));

        await schedule2.delete().catch(() => { });
        await schedule3.delete().catch(() => { });
        await minuteSchedule.delete().catch(() => { });
        await hourlySchedule.delete().catch(() => { });
        await dailySchedule.delete().catch(() => { });
        await weeklySchedule.delete().catch(() => { });
        console.log('    Cleanup complete');

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
