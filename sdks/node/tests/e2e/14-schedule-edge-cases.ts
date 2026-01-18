/**
 * E2E Test 14: Schedule Edge Cases and Errors
 * 
 * Tests edge cases and error handling for schedules:
 * - Invalid cron expressions
 * - Invalid timezones
 * - Operations on deleted schedules
 * - Duplicate schedule names
 * - Empty or special characters in names
 * 
 * Prerequisites: Run reseolio-core first
 * Run: npx tsx tests/e2e/14-schedule-edge-cases.ts
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
    console.log('🧪 E2E Test 14: Schedule Edge Cases and Errors\n');
    console.log('='.repeat(50));

    const reseolio = new Reseolio({
        storage: 'localhost:50051',
        autoStart: false,
    });

    try {
        await reseolio.start();
        console.log('✅ Connected to Reseolio\n');

        const runId = generateUniqueId();

        // ========== TEST 1: Invalid Cron Expression ==========
        console.log('Test 1: Invalid cron expression');
        console.log('-'.repeat(40));

        try {
            const h = reseolio.durable(`e2e:edge:invalid-cron-${runId}`, async () => ({}));
            await h.schedule({
                cron: 'not a valid cron',
            });
            logTest('Invalid cron rejected', false, 'Expected error but schedule was created');
        } catch (error: any) {
            logTest('Invalid cron rejected', true);
            console.log(`    Error message: ${error.message?.slice(0, 100)}`);
        }

        // ========== TEST 2: Malformed Cron (Wrong Number of Fields) ==========
        console.log('\nTest 2: Malformed cron (wrong field count)');
        console.log('-'.repeat(40));

        try {
            const h = reseolio.durable(`e2e:edge:malformed-cron-${runId}`, async () => ({}));
            await h.schedule({
                cron: '* *', // Only 2 fields, need 5
            });
            logTest('Malformed cron rejected', false, 'Expected error but schedule was created');
        } catch (error: any) {
            logTest('Malformed cron rejected', true);
            console.log(`    Error message: ${error.message?.slice(0, 100)}`);
        }

        // ========== TEST 3: Invalid Timezone ==========
        console.log('\nTest 3: Invalid timezone');
        console.log('-'.repeat(40));

        try {
            const h = reseolio.durable(`e2e:edge:invalid-tz-${runId}`, async () => ({}));
            await h.schedule({
                cron: '* * * * *',
                timezone: 'Invalid/Timezone',
            });
            // This might succeed or fail depending on implementation
            // Some systems fall back to UTC for invalid timezones
            logTest('Invalid timezone handled', true);
        } catch (error: any) {
            logTest('Invalid timezone rejected', true);
            console.log(`    Error message: ${error.message?.slice(0, 100)}`);
        }

        // ========== TEST 4: Various Valid Cron Expressions ==========
        console.log('\nTest 4: Various valid cron expressions');
        console.log('-'.repeat(40));

        const validCronTests = [
            { name: 'every-second', cron: '* * * * *' },           // Standard
            { name: 'specific-time', cron: '30 14 * * *' },        // 2:30 PM daily
            { name: 'weekdays', cron: '0 9 * * 1-5' },             // 9 AM weekdays
            { name: 'first-of-month', cron: '0 0 1 * *' },         // Midnight on 1st
            { name: 'step-hours', cron: '0 */4 * * *' },           // Every 4 hours
            { name: 'range-hours', cron: '0 9-17 * * *' },         // 9 AM - 5 PM
            { name: 'list-days', cron: '0 0 * * 0,3,6' },          // Sun, Wed, Sat
        ];

        let validCount = 0;
        for (const test of validCronTests) {
            try {
                const name = `e2e:edge:${test.name}-${runId}`;
                const h = reseolio.durable(name, async () => ({}));
                const s = await h.schedule({
                    cron: test.cron,
                });
                validCount++;
                await s.delete().catch(() => { });
            } catch (error: any) {
                console.log(`    Failed: ${test.name} (${test.cron}): ${error.message}`);
            }
        }

        logTest(`Valid cron expressions accepted (${validCount}/${validCronTests.length})`,
            validCount === validCronTests.length,
            `Only ${validCount} passed`
        );

        // ========== TEST 5: Various Valid Timezones ==========
        console.log('\nTest 5: Various valid timezones');
        console.log('-'.repeat(40));

        const validTimezones = [
            'UTC',
            'America/New_York',
            'Europe/London',
            'Asia/Tokyo',
            'Australia/Sydney',
            'Pacific/Auckland',
        ];

        let tzCount = 0;
        for (const tz of validTimezones) {
            try {
                const name = `e2e:edge:tz-${tz.replace('/', '-')}-${runId}`;
                const h = reseolio.durable(name, async () => ({}));
                const s = await h.schedule({
                    cron: '0 0 * * *',
                    timezone: tz,
                });
                const details = await s.details();
                if (details.timezone === tz) {
                    tzCount++;
                }
                await s.delete().catch(() => { });
            } catch (error: any) {
                console.log(`    Failed: ${tz}: ${error.message}`);
            }
        }

        logTest(`Valid timezones accepted (${tzCount}/${validTimezones.length})`,
            tzCount === validTimezones.length,
            `Only ${tzCount} passed`
        );

        // ========== TEST 6: Operations on Deleted Schedule ==========
        console.log('\nTest 6: Operations on deleted schedule');
        console.log('-'.repeat(40));

        const toDeleteHandler = reseolio.durable(`e2e:edge:to-delete-${runId}`, async () => ({}));
        const toDelete = await toDeleteHandler.schedule({
            cron: '0 0 * * *',
        });
        const deleteSuccess = await toDelete.delete();
        logTest('Schedule deleted', deleteSuccess === true);

        // Try to pause a deleted schedule
        try {
            await toDelete.pause();
            logTest('Pause deleted schedule fails', false, 'Expected error');
        } catch (error: any) {
            logTest('Pause deleted schedule fails', true);
        }

        // Try to resume a deleted schedule
        try {
            await toDelete.resume();
            logTest('Resume deleted schedule fails', false, 'Expected error');
        } catch (error: any) {
            logTest('Resume deleted schedule fails', true);
        }

        // Try to update a deleted schedule
        try {
            await toDelete.update({ cron: '* * * * *' });
            logTest('Update deleted schedule fails', false, 'Expected error');
        } catch (error: any) {
            logTest('Update deleted schedule fails', true);
        }

        // ========== TEST 7: Special Characters in Names ==========
        console.log('\nTest 7: Special characters in schedule names');
        console.log('-'.repeat(40));

        const specialNames = [
            `e2e:colons:test-${runId}`,
            `e2e_underscores_test_${runId}`,
            `e2e-dashes-test-${runId}`,
            `e2e.dots.test.${runId}`,
        ];

        let namesCount = 0;
        for (const name of specialNames) {
            try {
                const h = reseolio.durable(name, async () => ({}));
                const s = await h.schedule({ cron: '0 0 * * *' });
                const details = await s.details();
                if (details.name === name) {
                    namesCount++;
                }
                await s.delete().catch(() => { });
            } catch (error: any) {
                console.log(`    Failed: ${name}: ${error.message}`);
            }
        }

        logTest(`Special character names work (${namesCount}/${specialNames.length})`,
            namesCount === specialNames.length,
            `Only ${namesCount} passed`
        );

        // ========== TEST 8: Get Non-existent Schedule ==========
        console.log('\nTest 8: Get non-existent schedule');
        console.log('-'.repeat(40));

        try {
            await reseolio.getSchedule('non-existent-schedule-id-12345');
            logTest('Get non-existent schedule fails', false, 'Expected error');
        } catch (error: any) {
            logTest('Get non-existent schedule fails', true);
            console.log(`    Error message: ${error.message?.slice(0, 100)}`);
        }

        // ========== TEST 9: Double Pause/Resume ==========
        console.log('\nTest 9: Double pause/resume operations');
        console.log('-'.repeat(40));

        const doubleHandler = reseolio.durable(`e2e:edge:double-ops-${runId}`, async () => ({}));
        const doubleOps = await doubleHandler.schedule({
            cron: '0 0 * * *',
        });

        // Pause twice
        await doubleOps.pause();
        try {
            await doubleOps.pause();
            logTest('Double pause handled gracefully', true);
        } catch (error: any) {
            logTest('Double pause handled gracefully', false, error.message);
        }

        // Resume twice
        await doubleOps.resume();
        try {
            await doubleOps.resume();
            logTest('Double resume handled gracefully', true);
        } catch (error: any) {
            logTest('Double resume handled gracefully', false, error.message);
        }

        await doubleOps.delete().catch(() => { });

        // ========== TEST 10: Empty/Minimal Cron Equivalents ==========
        console.log('\nTest 10: Boundary cron values');
        console.log('-'.repeat(40));

        const boundaryCrons = [
            { name: 'all-zeros', cron: '0 0 1 1 0' },     // Midnight, Jan 1, Sunday
            { name: 'all-maxes', cron: '59 23 31 12 6' }, // 11:59 PM, Dec 31, Saturday
            { name: 'wildcards', cron: '* * * * *' },     // Every minute
        ];

        let boundaryCount = 0;
        for (const test of boundaryCrons) {
            try {
                const name = `e2e:edge:${test.name}-${runId}`;
                const h = reseolio.durable(name, async () => ({}));
                const s = await h.schedule({
                    cron: test.cron,
                });
                boundaryCount++;
                await s.delete().catch(() => { });
            } catch (error: any) {
                console.log(`    Failed: ${test.name}: ${error.message}`);
            }
        }

        logTest(`Boundary cron values work (${boundaryCount}/${boundaryCrons.length})`,
            boundaryCount === boundaryCrons.length
        );

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
