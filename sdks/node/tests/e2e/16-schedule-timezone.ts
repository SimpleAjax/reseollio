/**
 * E2E Test 16: Schedule Timezone Support
 * 
 * Tests timezone-aware scheduling to ensure schedules trigger at
 * the correct times in different timezones.
 * 
 * Prerequisites: Run reseolio-core first
 * Run: npx tsx tests/e2e/16-schedule-timezone.ts
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
    console.log('🧪 E2E Test 16: Schedule Timezone Support\n');
    console.log('='.repeat(50));

    const reseolio = new Reseolio({
        storage: 'localhost:50051',
        autoStart: false,
    });

    try {
        await reseolio.start();
        console.log('✅ Connected to Reseolio\n');

        const runId = generateUniqueId();

        // Define handlers
        reseolio.durable(`e2e:tz:task-${runId}`, async () => {
            return { executed: true };
        });

        // ========== TEST 1: UTC Timezone ==========
        console.log('Test 1: Schedule with UTC timezone');
        console.log('-'.repeat(40));

        const utcSchedule = await reseolio.schedule(`e2e:tz:task-${runId}`, {
            cron: '0 12 * * *', // 12:00 PM daily
            timezone: 'UTC',
        });

        const utcDetails = await utcSchedule.details();
        console.log(`    Timezone: ${utcDetails.timezone}`);
        console.log(`    Next run: ${new Date(utcDetails.nextRunAt).toISOString()}`);

        logTest('UTC timezone stored correctly',
            utcDetails.timezone === 'UTC');

        // Check that next run is at 12:00 UTC
        const utcNextRun = new Date(utcDetails.nextRunAt);
        logTest('Next run is at 12:00 hour',
            utcNextRun.getUTCHours() === 12 && utcNextRun.getUTCMinutes() === 0);

        // ========== TEST 2: US Eastern Timezone ==========
        console.log('\nTest 2: Schedule with US Eastern timezone');
        console.log('-'.repeat(40));

        reseolio.durable(`e2e:tz:eastern-${runId}`, async () => {
            return { executed: true };
        });

        const easternSchedule = await reseolio.schedule(`e2e:tz:eastern-${runId}`, {
            cron: '0 9 * * *', // 9:00 AM daily
            timezone: 'America/New_York',
        });

        const easternDetails = await easternSchedule.details();
        console.log(`    Timezone: ${easternDetails.timezone}`);
        console.log(`    Next run (UTC): ${new Date(easternDetails.nextRunAt).toISOString()}`);

        logTest('America/New_York timezone stored',
            easternDetails.timezone === 'America/New_York');

        // Eastern is UTC-5 (standard) or UTC-4 (daylight saving)
        // 9 AM ET = 14:00 or 13:00 UTC
        const easternNextRun = new Date(easternDetails.nextRunAt);
        const easternHourUTC = easternNextRun.getUTCHours();
        console.log(`    Next run hour (UTC): ${easternHourUTC}`);

        logTest('Next run is at expected UTC hour (13 or 14)',
            easternHourUTC === 13 || easternHourUTC === 14);

        // ========== TEST 3: Asia/Tokyo Timezone ==========
        console.log('\nTest 3: Schedule with Asia/Tokyo timezone');
        console.log('-'.repeat(40));

        reseolio.durable(`e2e:tz:tokyo-${runId}`, async () => {
            return { executed: true };
        });

        const tokyoSchedule = await reseolio.schedule(`e2e:tz:tokyo-${runId}`, {
            cron: '0 9 * * *', // 9:00 AM daily
            timezone: 'Asia/Tokyo',
        });

        const tokyoDetails = await tokyoSchedule.details();
        console.log(`    Timezone: ${tokyoDetails.timezone}`);
        console.log(`    Next run (UTC): ${new Date(tokyoDetails.nextRunAt).toISOString()}`);

        logTest('Asia/Tokyo timezone stored',
            tokyoDetails.timezone === 'Asia/Tokyo');

        // Tokyo is UTC+9
        // 9 AM Tokyo = 00:00 UTC
        const tokyoNextRun = new Date(tokyoDetails.nextRunAt);
        const tokyoHourUTC = tokyoNextRun.getUTCHours();
        console.log(`    Next run hour (UTC): ${tokyoHourUTC}`);

        logTest('Next run is at 00:00 UTC (9 AM Tokyo)',
            tokyoHourUTC === 0);

        // ========== TEST 4: Europe/London Timezone ==========
        console.log('\nTest 4: Schedule with Europe/London timezone');
        console.log('-'.repeat(40));

        reseolio.durable(`e2e:tz:london-${runId}`, async () => {
            return { executed: true };
        });

        const londonSchedule = await reseolio.schedule(`e2e:tz:london-${runId}`, {
            cron: '30 14 * * *', // 2:30 PM daily
            timezone: 'Europe/London',
        });

        const londonDetails = await londonSchedule.details();
        console.log(`    Timezone: ${londonDetails.timezone}`);
        console.log(`    Next run (UTC): ${new Date(londonDetails.nextRunAt).toISOString()}`);

        logTest('Europe/London timezone stored',
            londonDetails.timezone === 'Europe/London');

        // London is UTC+0 (winter) or UTC+1 (summer/BST)
        // 14:30 London = 14:30 or 13:30 UTC
        const londonNextRun = new Date(londonDetails.nextRunAt);
        const londonMinuteUTC = londonNextRun.getUTCMinutes();
        console.log(`    Next run minute (UTC): ${londonMinuteUTC}`);

        logTest('Next run is at 30 minutes past the hour',
            londonMinuteUTC === 30);

        // ========== TEST 5: Update Timezone ==========
        console.log('\nTest 5: Update schedule timezone');
        console.log('-'.repeat(40));

        const beforeUpdate = await utcSchedule.details();
        console.log(`    Before: ${beforeUpdate.timezone}`);

        await utcSchedule.update({ timezone: 'America/Los_Angeles' });

        const afterUpdate = await utcSchedule.details();
        console.log(`    After: ${afterUpdate.timezone}`);

        logTest('Timezone updated from UTC to America/Los_Angeles',
            afterUpdate.timezone === 'America/Los_Angeles');

        // LA is UTC-8 (standard) or UTC-7 (daylight saving)
        // 12:00 LA = 20:00 or 19:00 UTC
        const laNextRun = new Date(afterUpdate.nextRunAt);
        const laHourUTC = laNextRun.getUTCHours();
        console.log(`    New next run (UTC): ${laNextRun.toISOString()}`);
        console.log(`    Hour (UTC): ${laHourUTC}`);

        logTest('Next run recalculated for LA timezone (19 or 20 UTC)',
            laHourUTC === 19 || laHourUTC === 20);

        // ========== TEST 6: Default Timezone (UTC) ==========
        console.log('\nTest 6: Default timezone when not specified');
        console.log('-'.repeat(40));

        reseolio.durable(`e2e:tz:default-${runId}`, async () => {
            return { executed: true };
        });

        const defaultSchedule = await reseolio.schedule(`e2e:tz:default-${runId}`, {
            cron: '0 6 * * *', // 6 AM daily, no timezone specified
        });

        const defaultDetails = await defaultSchedule.details();
        console.log(`    Timezone: ${defaultDetails.timezone}`);

        logTest('Default timezone is UTC',
            defaultDetails.timezone === 'UTC');

        const defaultNextRun = new Date(defaultDetails.nextRunAt);
        logTest('Next run is at 06:00 UTC',
            defaultNextRun.getUTCHours() === 6 && defaultNextRun.getUTCMinutes() === 0);

        // ========== TEST 7: Multiple Timezones Same Cron ==========
        console.log('\nTest 7: Same cron expression, different timezones');
        console.log('-'.repeat(40));

        const sameCronSchedules = [
            { tz: 'UTC', schedule: utcSchedule },
            { tz: 'America/New_York', schedule: easternSchedule },
            { tz: 'Asia/Tokyo', schedule: tokyoSchedule },
        ];

        // All have 9 AM cron except UTC which is 12 PM now...
        // Let's just verify they all have different next_run_at times
        const nextRunTimes = new Map<string, number>();
        for (const s of sameCronSchedules) {
            const d = await s.schedule.details();
            nextRunTimes.set(s.tz, d.nextRunAt);
            console.log(`    ${s.tz}: ${new Date(d.nextRunAt).toISOString()}`);
        }

        // All times should be different (different timezones)
        const uniqueTimes = new Set(nextRunTimes.values());
        logTest('Different timezones produce different next_run_at',
            uniqueTimes.size === sameCronSchedules.length);

        // ========== CLEANUP ==========
        console.log('\n🗑️  Cleaning up schedules...');

        await utcSchedule.delete().catch(() => { });
        await easternSchedule.delete().catch(() => { });
        await tokyoSchedule.delete().catch(() => { });
        await londonSchedule.delete().catch(() => { });
        await defaultSchedule.delete().catch(() => { });
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
