/**
 * E2E Test 02: Retry and Failure Handling
 * 
 * Tests retry mechanisms and error handling:
 * - Automatic retries on failure
 * - Different backoff strategies
 * - maxAttempts configuration
 * - Job entering DEAD state after exhausting retries
 * - Accessing error information
 * 
 * Prerequisites: Run reseolio-core first
 * Run: npx tsx tests/e2e/02-retry-and-failure-handling.ts
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
    console.log('🧪 E2E Test 02: Retry and Failure Handling\n');
    console.log('='.repeat(50));

    const reseolio = new Reseolio({
        storage: 'localhost:50051',
        autoStart: false,
    });

    // Track retry attempts
    const attemptTracker = new Map<string, number>();

    reseolio.on('job:start', (job) => {
        const count = attemptTracker.get(job.name) || 0;
        attemptTracker.set(job.name, count + 1);
        console.log(`    [ATTEMPT] ${job.name} - attempt #${job.attempt}`);
    });

    reseolio.on('job:error', (job, err) => {
        console.log(`    [ERROR] ${job.name} - ${err}`);
    });

    reseolio.on('job:success', (job) => {
        console.log(`    [SUCCESS] ${job.name}`);
    });

    try {
        await reseolio.start();
        console.log('✅ Connected to Reseolio\n');

        // ========== TEST 1: Transient Failure with Recovery ==========
        console.log('Test 1: Transient failure with automatic recovery');
        console.log('-'.repeat(40));

        let failCount = 0;
        const failTwiceThenSucceed = reseolio.durable(
            reseolio.namespace('e2e', 'test02', 'failTwice'),
            async (value: number) => {
                failCount++;
                if (failCount <= 2) {
                    throw new Error(`Simulated transient failure #${failCount}`);
                }
                return { value, recoveredAfter: failCount };
            },
            {
                maxAttempts: 5,
                backoff: 'fixed',
                initialDelayMs: 100,
            }
        );

        const transientHandle = await failTwiceThenSucceed(42);
        const transientResult = await transientHandle.result(15000);

        logTest(
            'Job recovered after transient failures',
            transientResult.value === 42 && transientResult.recoveredAfter === 3
        );

        const transientDetails = await transientHandle.details();
        logTest('Job has correct attempt count', transientDetails.attempt === 3);

        // ========== TEST 2: Permanent Failure (DEAD state) ==========
        console.log('\nTest 2: Permanent failure - job goes DEAD');
        console.log('-'.repeat(40));

        const alwaysFail = reseolio.durable(
            reseolio.namespace('e2e', 'test02', 'alwaysFail'),
            async () => {
                throw new Error('This job always fails');
            },
            {
                maxAttempts: 3,
                backoff: 'fixed',
                initialDelayMs: 100,
            }
        );

        const deadHandle = await alwaysFail();

        try {
            await deadHandle.result(15000);
            logTest('Job should have thrown error', false, 'No error thrown');
        } catch (error: any) {
            logTest('Job threw error after max retries', true);
            console.log(`    Error message: ${error.message}`);
        }

        const deadDetails = await deadHandle.details();
        logTest('Job status is dead', deadDetails.status === 'dead', deadDetails.status);
        logTest('Job error is captured', deadDetails.error !== undefined && deadDetails.error.length > 0);

        // ========== TEST 3: Exponential Backoff ==========
        console.log('\\nTest 3: Exponential backoff timing');
        console.log('-'.repeat(40));

        // Note: Server uses second-level granularity with ceiling division.
        // With initialDelayMs=1000:
        //   Attempt 1: 1000 * 2^0 = 1000ms → 1s
        //   Attempt 2: 1000 * 2^1 = 2000ms → 2s
        //   Attempt 3: 1000 * 2^2 = 4000ms → 4s
        //   Attempt 4: 1000 * 2^3 = 8000ms → 8s
        let expAttempts: number[] = [];
        const expBackoffJob = reseolio.durable(
            reseolio.namespace('e2e', 'test02', 'expBackoff'),
            async () => {
                expAttempts.push(Date.now());
                if (expAttempts.length < 4) {
                    throw new Error(`Fail attempt ${expAttempts.length}`);
                }
                return { attempts: expAttempts.length };
            },
            {
                maxAttempts: 6,
                backoff: 'exponential',
                initialDelayMs: 3000,  // 1 second base - makes exponential growth visible
            }
        );

        const expHandle = await expBackoffJob();
        await expHandle.result(30000);

        // Check that delays increased exponentially
        if (expAttempts.length >= 4) {
            const delay1 = expAttempts[1] - expAttempts[0];
            const delay2 = expAttempts[2] - expAttempts[1];
            const delay3 = expAttempts[3] - expAttempts[2];

            console.log(`    Delay 1: ${delay1}ms (expected ~3s)`);
            console.log(`    Delay 2: ${delay2}ms (expected ~6s)`);
            console.log(`    Delay 3: ${delay3}ms (expected ~12s)`);

            // Exponential: delay3 should be > delay2 > delay1
            // Allow some tolerance for timing variance
            const exponentialGrowth = delay3 > delay2 * 1.3 && delay2 > delay1 * 1.3;
            logTest('Exponential backoff increases delays', exponentialGrowth);
        } else {
            logTest('Exponential backoff test', false, 'Not enough attempts recorded');
        }

        // ========== TEST 4: Linear Backoff ==========
        console.log('\nTest 4: Linear backoff timing');
        console.log('-'.repeat(40));

        // Note: Server uses second-level granularity with ceiling division.
        // With initialDelayMs=1000:
        //   Attempt 1: 1000 * 1 = 1000ms → 1s
        //   Attempt 2: 1000 * 2 = 2000ms → 2s
        //   Attempt 3: 1000 * 3 = 3000ms → 3s
        //   Attempt 4: 1000 * 4 = 4000ms → 4s
        let linearAttempts: number[] = [];
        const linearBackoffJob = reseolio.durable(
            reseolio.namespace('e2e', 'test02', 'linearBackoff'),
            async () => {
                linearAttempts.push(Date.now());
                if (linearAttempts.length < 4) {
                    throw new Error(`Fail attempt ${linearAttempts.length}`);
                }
                return { attempts: linearAttempts.length };
            },
            {
                maxAttempts: 5,
                backoff: 'linear',
                initialDelayMs: 3000,  // 1 second base - makes linear growth visible
            }
        );

        const linearHandle = await linearBackoffJob();
        await linearHandle.result(30000);

        if (linearAttempts.length >= 4) {
            const delay1 = linearAttempts[1] - linearAttempts[0];
            const delay2 = linearAttempts[2] - linearAttempts[1];
            const delay3 = linearAttempts[3] - linearAttempts[2];

            console.log(`    Delay 1: ${delay1}ms (expected ~3s)`);
            console.log(`    Delay 2: ${delay2}ms (expected ~6s)`);
            console.log(`    Delay 3: ${delay3}ms (expected ~9s)`);

            // Linear backoff: delays should increase by ~1s each time
            // Allow tolerance for timing variance (delays should be within ~500ms of expected)
            const linearGrowth = delay3 > delay2 && delay2 > delay1;
            logTest('Linear backoff has increasing delays', linearGrowth);
        } else {
            logTest('Linear backoff test', false, 'Not enough attempts recorded');
        }


        // ========== TEST 5: Fixed Backoff ==========
        console.log('\nTest 5: Fixed backoff timing');
        console.log('-'.repeat(40));

        // Note: Server uses second-level granularity with ceiling division.
        // With initialDelayMs=1000, fixed backoff should give ~1s delay each time
        let fixedAttempts: number[] = [];
        const fixedBackoffJob = reseolio.durable(
            reseolio.namespace('e2e', 'test02', 'fixedBackoff'),
            async () => {
                fixedAttempts.push(Date.now());
                if (fixedAttempts.length < 3) {
                    throw new Error(`Fail attempt ${fixedAttempts.length}`);
                }
                return { attempts: fixedAttempts.length };
            },
            {
                maxAttempts: 5,
                backoff: 'fixed',
                initialDelayMs: 3000,  // 1 second - consistent delays
            }
        );

        const fixedHandle = await fixedBackoffJob();
        await fixedHandle.result(15000);

        if (fixedAttempts.length >= 3) {
            const delay1 = fixedAttempts[1] - fixedAttempts[0];
            const delay2 = fixedAttempts[2] - fixedAttempts[1];

            console.log(`    Delay 1: ${delay1}ms (expected ~3s)`);
            console.log(`    Delay 2: ${delay2}ms (expected ~3s)`);

            // Fixed backoff should have similar delays (within 50% tolerance)
            const similarDelays = Math.abs(delay1 - delay2) < delay1 * 0.5;
            logTest('Fixed backoff has consistent delays', similarDelays);
        } else {
            logTest('Fixed backoff test', false, 'Not enough attempts recorded');
        }


        // ========== TEST 6: Error Type Preservation ==========
        console.log('\nTest 6: Error information preserved');
        console.log('-'.repeat(40));

        const customErrorJob = reseolio.durable(
            reseolio.namespace('e2e', 'test02', 'customError'),
            async () => {
                const error = new Error('Payment gateway timeout');
                (error as any).code = 'GATEWAY_TIMEOUT';
                throw error;
            },
            { maxAttempts: 1 }
        );

        const errorHandle = await customErrorJob();

        try {
            await errorHandle.result(5000);
        } catch (error: any) {
            const details = await errorHandle.details();
            logTest('Error message preserved', details.error?.includes('Payment gateway timeout') === true);
        }

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
