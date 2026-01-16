/**
 * E2E Test 11: Result Caching and Completed Job Access
 * 
 * Tests that completed job results are properly cached and can be
 * retrieved multiple times without re-execution. Validates:
 * - Completed job results are cached
 * - Multiple result() calls return same data
 * - details() returns full job information
 * - Results persist after job completion
 * 
 * Prerequisites: Run reseolio-core first
 * Run: npx tsx tests/e2e/11-result-caching.ts
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

async function runTests() {
    console.log('🧪 E2E Test 11: Result Caching and Completed Job Access\n');
    console.log('='.repeat(50));

    const reseolio = new Reseolio({
        storage: 'localhost:50051',
        autoStart: false,
    });

    try {
        await reseolio.start();
        console.log('✅ Connected to Reseolio\n');

        // ========== TEST 1: Basic Result Caching ==========
        console.log('Test 1: Result is cached after completion');
        console.log('-'.repeat(40));

        let executionCount = 0;
        const countedJob = reseolio.durable(
            reseolio.namespace('e2e', 'cache', 'counted'),
            async (value: number) => {
                executionCount++;
                console.log(`    [EXEC] Execution #${executionCount}`);
                return { value, execNumber: executionCount };
            }
        );

        const handle = await countedJob(42);

        // First result call
        const result1 = await handle.result(10000);
        console.log(`    First result: execNumber=${result1.execNumber}`);

        // Second result call - should NOT re-execute
        const result2 = await handle.result(10000);
        console.log(`    Second result: execNumber=${result2.execNumber}`);

        logTest('Job executed only once', executionCount === 1);
        logTest('Both result() calls return same data',
            result1.execNumber === result2.execNumber && result1.value === result2.value);

        // ========== TEST 2: Status Remains After Completion ==========
        console.log('\nTest 2: Status remains "success" after completion');
        console.log('-'.repeat(40));

        const status1 = await handle.status();
        await new Promise(r => setTimeout(r, 100)); // Small delay
        const status2 = await handle.status();

        logTest('Status is success', status1 === 'success');
        logTest('Status remains consistent', status1 === status2);

        // ========== TEST 3: Details Contain Full Information ==========
        console.log('\nTest 3: Details contain complete job info');
        console.log('-'.repeat(40));

        const details = await handle.details();
        console.log(`    Details: id=${details.id}, status=${details.status}, attempt=${details.attempt}`);

        logTest('Details include job ID', details.id === handle.jobId);
        logTest('Details show success status', details.status === 'success');
        logTest('Details show attempt number', details.attempt >= 1);
        logTest('Details include job name', details.name?.includes('cache:counted'));

        // ========== TEST 4: Multiple Jobs - Independent Caching ==========
        console.log('\nTest 4: Multiple jobs have independent cached results');
        console.log('-'.repeat(40));

        const handleA = await countedJob(100);
        const handleB = await countedJob(200);
        const handleC = await countedJob(300);

        const resultA = await handleA.result(10000);
        const resultB = await handleB.result(10000);
        const resultC = await handleC.result(10000);

        logTest('Job A has correct value', resultA.value === 100);
        logTest('Job B has correct value', resultB.value === 200);
        logTest('Job C has correct value', resultC.value === 300);

        // Re-fetch results - should be cached
        const resultA2 = await handleA.result(10000);
        const resultB2 = await handleB.result(10000);

        logTest('Re-fetched A matches original', resultA2.value === resultA.value);
        logTest('Re-fetched B matches original', resultB2.value === resultB.value);

        // ========== TEST 5: Error Results Are Also Cached ==========
        console.log('\nTest 5: Failed job results are accessible');
        console.log('-'.repeat(40));

        const failingJob = reseolio.durable(
            reseolio.namespace('e2e', 'cache', 'failing'),
            async () => {
                throw new Error('Intentional test failure');
            },
            { maxAttempts: 1 }
        );

        const failHandle = await failingJob();

        try {
            await failHandle.result(10000);
            logTest('Failed job throws error', false, 'Should have thrown');
        } catch (err: any) {
            logTest('Failed job throws error', true);
            logTest('Error message is preserved', err.message?.includes('Intentional') || err.message?.includes('failed'));
        }

        const failStatus = await failHandle.status();
        logTest('Failed job status is dead', failStatus === 'dead');

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
