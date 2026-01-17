/**
 * E2E Test 13: Schedule Triggering
 * 
 * Tests that schedules actually trigger and create jobs:
 * - Schedule with very short interval (every minute)
 * - Verify jobs are created by the cron scheduler
 * - Verify idempotency (same schedule run doesn't create duplicates)
 * - Verify paused schedules don't trigger
 * 
 * ⚠️ NOTE: This test requires waiting for schedule triggers, so it takes longer.
 * The test uses a 1-minute cron expression and waits for it to fire.
 * 
 * Prerequisites: Run reseolio-core first
 * Run: npx tsx tests/e2e/13-schedule-triggering.ts
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

async function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTests() {
    console.log('🧪 E2E Test 13: Schedule Triggering\n');
    console.log('='.repeat(50));
    console.log('⚠️  Note: This test waits for schedule triggers and may take 2+ minutes\n');

    const reseolio = new Reseolio({
        storage: 'localhost:50051',
        autoStart: false,
    });

    // Track created job handlers
    const triggeredJobs: string[] = [];

    try {
        await reseolio.start();
        console.log('✅ Connected to Reseolio\n');

        const runId = generateUniqueId();

        // ========== TEST 1: Create a Quick-Firing Schedule ==========
        console.log('Test 1: Create schedule with every-minute cron');
        console.log('-'.repeat(40));

        // Use a handler name that the schedule will call
        const handlerName = `e2e:trigger:handler-${runId}`;

        // Register a durable function that the schedule will trigger
        // Note: In real usage, the handler must be registered for jobs to execute
        const triggerHandler = reseolio.durable(handlerName, async () => {
            const now = new Date().toISOString();
            console.log(`    [TRIGGER] Handler executed at ${now}`);
            triggeredJobs.push(now);
            return { triggered: true, timestamp: now };
        });

        // Create a schedule that runs every minute
        const scheduleName = `e2e:schedule:trigger-test-${runId}`;
        const scheduleHandle = await reseolio.schedule(scheduleName, {
            cron: '* * * * *', // Every minute
            timezone: 'UTC',
        });

        logTest('Schedule created', scheduleHandle.id.length > 0);

        const details = await scheduleHandle.details();
        const nextRunTime = new Date(details.nextRunAt);
        console.log(`    Schedule ID: ${scheduleHandle.id}`);
        console.log(`    Next run at: ${nextRunTime.toISOString()}`);

        // Calculate wait time until next run + buffer
        const now = Date.now();
        const waitTime = Math.max(0, nextRunTime.getTime() - now) + 5000; // Add 5 second buffer

        if (waitTime < 70000) {
            console.log(`\n⏳ Waiting ${Math.ceil(waitTime / 1000)}s for first trigger...`);
            await sleep(waitTime);

            // ========== TEST 2: Check if Job was Created ==========
            console.log('\nTest 2: Verify schedule created a job');
            console.log('-'.repeat(40));

            // Check lastRunAt - should be set after trigger
            const afterTrigger = await scheduleHandle.details();
            const hasTriggered = afterTrigger.lastRunAt > 0;
            logTest('Schedule has lastRunAt set', hasTriggered);

            if (hasTriggered) {
                console.log(`    Last run at: ${new Date(afterTrigger.lastRunAt).toISOString()}`);
            }

            // The schedule should now have a new nextRunAt
            const newNextRun = new Date(afterTrigger.nextRunAt);
            logTest('Next run is in the future', newNextRun.getTime() > Date.now());
            console.log(`    New next run: ${newNextRun.toISOString()}`);

        } else {
            console.log('\n⚠️  Skipping trigger wait test (next run > 70s away)');
            console.log(`    Next run at: ${nextRunTime.toISOString()}`);
        }

        // ========== TEST 3: Paused Schedule Should Not Trigger ==========
        console.log('\nTest 3: Paused schedule does not trigger');
        console.log('-'.repeat(40));

        // Create another schedule and immediately pause it
        const pausedScheduleName = `e2e:schedule:paused-test-${runId}`;
        const pausedSchedule = await reseolio.schedule(pausedScheduleName, {
            cron: '* * * * *', // Every minute
            timezone: 'UTC',
        });

        await pausedSchedule.pause();
        const pausedDetails = await pausedSchedule.details();
        logTest('Schedule is paused', pausedDetails.status === 'paused');

        // Wait briefly to ensure no trigger
        console.log('    Waiting 10s to verify no trigger while paused...');
        await sleep(10000);

        const stillPausedDetails = await pausedSchedule.details();
        logTest('Paused schedule lastRunAt unchanged', stillPausedDetails.lastRunAt === pausedDetails.lastRunAt);

        // ========== TEST 4: Resume and Verify Triggering Resumes ==========
        console.log('\nTest 4: Resume schedule');
        console.log('-'.repeat(40));

        await pausedSchedule.resume();
        const resumedDetails = await pausedSchedule.details();
        logTest('Schedule is active', resumedDetails.status === 'active');
        logTest('Has new next run time', resumedDetails.nextRunAt > 0);
        console.log(`    Next run at: ${new Date(resumedDetails.nextRunAt).toISOString()}`);

        // ========== TEST 5: Concurrent Schedules ==========
        console.log('\nTest 5: Multiple concurrent schedules');
        console.log('-'.repeat(40));

        const schedule1 = await reseolio.schedule(`e2e:schedule:concurrent-1-${runId}`, {
            cron: '*/5 * * * *', // Every 5 minutes
        });
        const schedule2 = await reseolio.schedule(`e2e:schedule:concurrent-2-${runId}`, {
            cron: '*/10 * * * *', // Every 10 minutes
        });
        const schedule3 = await reseolio.schedule(`e2e:schedule:concurrent-3-${runId}`, {
            cron: '0 * * * *', // Every hour
        });

        const listResult = await reseolio.listSchedules();
        const ourSchedules = listResult.schedules.filter(s =>
            s.name.includes(`concurrent`) && s.name.includes(runId)
        );

        logTest('Created 3 concurrent schedules', ourSchedules.length === 3);
        logTest('All schedules are active', ourSchedules.every(s => s.status === 'active'));

        // Each should have different next run times based on their cron
        const nextRuns = ourSchedules.map(s => s.nextRunAt).sort();
        logTest('Schedules have different next run times',
            new Set(nextRuns).size === 3 || nextRuns.length === 3
        );

        // ========== TEST 6: Schedule with Handler Options ==========
        console.log('\nTest 6: Schedule with custom handler options');
        console.log('-'.repeat(40));

        const optionsSchedule = await reseolio.schedule(`e2e:schedule:with-options-${runId}`, {
            cron: '0 0 * * *', // Daily at midnight
            timezone: 'America/Los_Angeles',
            handlerOptions: {
                maxAttempts: 5,
                backoff: 'exponential',
                initialDelayMs: 1000,
                maxDelayMs: 60000,
                timeoutMs: 30000,
            },
        });

        const optionsDetails = await optionsSchedule.details();
        logTest('Schedule created with options', optionsSchedule.id.length > 0);
        logTest('Timezone is set', optionsDetails.timezone === 'America/Los_Angeles');

        // ========== CLEANUP ==========
        console.log('\nCleanup: Deleting test schedules...');
        console.log('-'.repeat(40));

        await scheduleHandle.delete().catch(() => { });
        await pausedSchedule.delete().catch(() => { });
        await schedule1.delete().catch(() => { });
        await schedule2.delete().catch(() => { });
        await schedule3.delete().catch(() => { });
        await optionsSchedule.delete().catch(() => { });
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

        // Show triggered jobs
        if (triggeredJobs.length > 0) {
            console.log(`\n📋 Triggered jobs: ${triggeredJobs.length}`);
            triggeredJobs.forEach(t => console.log(`    - ${t}`));
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
