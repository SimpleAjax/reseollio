/**
 * E2E Test 17: Schedule Convenience Methods
 * 
 * Tests the convenience methods for creating schedules:
 * - everyMinute()
 * - hourly()
 * - daily()
 * - weekly()
 * 
 * Prerequisites: Run reseolio-core first
 * Run: npx tsx tests/e2e/17-schedule-convenience.ts
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
    console.log('🧪 E2E Test 17: Schedule Convenience Methods\n');
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

        // Define handlers
        reseolio.durable(`e2e:conv:minute-${runId}`, async () => ({ type: 'minute' }));
        reseolio.durable(`e2e:conv:hourly-${runId}`, async () => ({ type: 'hourly' }));
        reseolio.durable(`e2e:conv:daily-${runId}`, async () => ({ type: 'daily' }));
        reseolio.durable(`e2e:conv:weekly-${runId}`, async () => ({ type: 'weekly' }));

        // ========== TEST 1: everyMinute() ==========
        console.log('Test 1: everyMinute() convenience method');
        console.log('-'.repeat(40));

        const minuteSchedule = await reseolio.everyMinute(`e2e:conv:minute-${runId}`);
        schedulesToCleanup.push(minuteSchedule);

        const minuteDetails = await minuteSchedule.details();
        console.log(`    Schedule ID: ${minuteSchedule.id}`);
        console.log(`    Cron: ${minuteDetails.cronExpression}`);
        console.log(`    Next run: ${new Date(minuteDetails.nextRunAt).toISOString()}`);

        logTest('everyMinute creates schedule',
            minuteSchedule.id.length > 0);
        logTest('everyMinute uses correct cron (* * * * *)',
            minuteDetails.cronExpression === '* * * * *');

        // Verify next run is within 60 seconds
        const minuteNextRun = await minuteSchedule.nextRunAt();
        const minuteDiff = (minuteNextRun.getTime() - Date.now()) / 1000;
        console.log(`    Next run in: ${minuteDiff.toFixed(1)} seconds`);

        logTest('Next run within 60 seconds',
            minuteDiff > 0 && minuteDiff <= 60);

        // ========== TEST 2: hourly() ==========
        console.log('\nTest 2: hourly() convenience method');
        console.log('-'.repeat(40));

        const hourlySchedule = await reseolio.hourly(`e2e:conv:hourly-${runId}`);
        schedulesToCleanup.push(hourlySchedule);

        const hourlyDetails = await hourlySchedule.details();
        console.log(`    Schedule ID: ${hourlySchedule.id}`);
        console.log(`    Cron: ${hourlyDetails.cronExpression}`);
        console.log(`    Next run: ${new Date(hourlyDetails.nextRunAt).toISOString()}`);

        logTest('hourly creates schedule',
            hourlySchedule.id.length > 0);
        logTest('hourly uses correct cron (0 * * * *)',
            hourlyDetails.cronExpression === '0 * * * *');

        // Verify next run is at the top of an hour
        const hourlyNextRun = await hourlySchedule.nextRunAt();
        console.log(`    Next run hour: ${hourlyNextRun.getUTCHours()}, minute: ${hourlyNextRun.getMinutes()}`);

        logTest('Next run is at minute 0',
            hourlyNextRun.getMinutes() === 0);

        // ========== TEST 3: daily() ==========
        console.log('\nTest 3: daily() convenience method');
        console.log('-'.repeat(40));

        // Test with default hour (0)
        const dailyDefaultSchedule = await reseolio.daily(`e2e:conv:daily-${runId}`);
        schedulesToCleanup.push(dailyDefaultSchedule);

        const dailyDefaultDetails = await dailyDefaultSchedule.details();
        console.log(`    Default - Cron: ${dailyDefaultDetails.cronExpression}`);

        logTest('daily() with default hour uses cron (0 0 * * *)',
            dailyDefaultDetails.cronExpression === '0 0 * * *');

        // Test with specific hour (8 AM)
        reseolio.durable(`e2e:conv:daily8-${runId}`, async () => ({ type: 'daily8' }));
        const daily8Schedule = await reseolio.daily(`e2e:conv:daily8-${runId}`, 8);
        schedulesToCleanup.push(daily8Schedule);

        const daily8Details = await daily8Schedule.details();
        console.log(`    8 AM - Cron: ${daily8Details.cronExpression}`);

        logTest('daily(8) uses cron (0 8 * * *)',
            daily8Details.cronExpression === '0 8 * * *');

        // Verify next run is at the specified hour
        const daily8NextRun = await daily8Schedule.nextRunAt();
        console.log(`    Next run hour (UTC): ${daily8NextRun.getUTCHours()}`);

        logTest('Next run is at 8 AM UTC',
            daily8NextRun.getUTCHours() === 8 && daily8NextRun.getMinutes() === 0);

        // ========== TEST 4: weekly() ==========
        console.log('\nTest 4: weekly() convenience method');
        console.log('-'.repeat(40));

        // Test Monday at 9 AM
        reseolio.durable(`e2e:conv:weekly-mon-${runId}`, async () => ({ type: 'weekly-mon' }));
        const weeklyMonSchedule = await reseolio.weekly(`e2e:conv:weekly-mon-${runId}`, 1, 9);
        schedulesToCleanup.push(weeklyMonSchedule);

        const weeklyMonDetails = await weeklyMonSchedule.details();
        console.log(`    Monday 9 AM - Cron: ${weeklyMonDetails.cronExpression}`);

        logTest('weekly(1, 9) uses cron (0 9 * * 1)',
            weeklyMonDetails.cronExpression === '0 9 * * 1');

        // Test Friday at 5 PM (17:00)
        reseolio.durable(`e2e:conv:weekly-fri-${runId}`, async () => ({ type: 'weekly-fri' }));
        const weeklyFriSchedule = await reseolio.weekly(`e2e:conv:weekly-fri-${runId}`, 5, 17);
        schedulesToCleanup.push(weeklyFriSchedule);

        const weeklyFriDetails = await weeklyFriSchedule.details();
        console.log(`    Friday 5 PM - Cron: ${weeklyFriDetails.cronExpression}`);

        logTest('weekly(5, 17) uses cron (0 17 * * 5)',
            weeklyFriDetails.cronExpression === '0 17 * * 5');

        // Verify next run is on the correct day of week
        const weeklyFriNextRun = await weeklyFriSchedule.nextRunAt();
        console.log(`    Next run: ${weeklyFriNextRun.toISOString()}`);
        console.log(`    Day of week: ${weeklyFriNextRun.getUTCDay()} (5 = Friday)`);

        logTest('Next run is on Friday',
            weeklyFriNextRun.getUTCDay() === 5);
        logTest('Next run is at 17:00 UTC',
            weeklyFriNextRun.getUTCHours() === 17);

        // ========== TEST 5: Sunday (day 0) ==========
        console.log('\nTest 5: Weekly on Sunday (day 0)');
        console.log('-'.repeat(40));

        reseolio.durable(`e2e:conv:weekly-sun-${runId}`, async () => ({ type: 'weekly-sun' }));
        const weeklySunSchedule = await reseolio.weekly(`e2e:conv:weekly-sun-${runId}`, 0, 10);
        schedulesToCleanup.push(weeklySunSchedule);

        const weeklySunDetails = await weeklySunSchedule.details();
        console.log(`    Sunday 10 AM - Cron: ${weeklySunDetails.cronExpression}`);

        logTest('weekly(0, 10) uses cron (0 10 * * 0)',
            weeklySunDetails.cronExpression === '0 10 * * 0');

        const weeklySunNextRun = await weeklySunSchedule.nextRunAt();
        console.log(`    Day of week: ${weeklySunNextRun.getUTCDay()} (0 = Sunday)`);

        logTest('Next run is on Sunday',
            weeklySunNextRun.getUTCDay() === 0);

        // ========== TEST 6: Verify All Active ==========
        console.log('\nTest 6: All convenience schedules are active');
        console.log('-'.repeat(40));

        let allActive = true;
        for (const schedule of schedulesToCleanup) {
            const status = await schedule.status();
            if (status !== 'ACTIVE') {
                allActive = false;
                console.log(`    Schedule ${schedule.id} is ${status}`);
            }
        }
        console.log(`    ${schedulesToCleanup.length} schedules checked`);

        logTest('All convenience schedules are ACTIVE', allActive);

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
