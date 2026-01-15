/**
 * E2E Test 01: Basic Job Lifecycle
 * 
 * Tests the fundamental job operations that every developer will use:
 * - Creating and enqueuing jobs
 * - Waiting for job results
 * - Checking job status
 * - Getting job details
 * 
 * Prerequisites: Run reseolio-core first
 * Run: npx tsx tests/e2e/01-basic-job-lifecycle.ts
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
    console.log('🧪 E2E Test 01: Basic Job Lifecycle\n');
    console.log('='.repeat(50));

    const reseolio = new Reseolio({
        storage: 'localhost:50051',
        autoStart: false,
    });

    // Event logging
    reseolio.on('job:start', (job) => console.log(`    [EVENT] job:start - ${job.id}`));
    reseolio.on('job:success', (job) => console.log(`    [EVENT] job:success - ${job.id}`));
    reseolio.on('job:error', (job, err) => console.log(`    [EVENT] job:error - ${job.id}: ${err}`));

    try {
        await reseolio.start();
        console.log('✅ Connected to Reseolio\n');

        // ========== TEST 1: Simple Job Execution ==========
        console.log('Test 1: Simple job execution');
        console.log('-'.repeat(40));

        const simpleJob = reseolio.durable(
            reseolio.namespace('e2e', 'test01', 'simple'),
            async (name: string, value: number) => {
                await new Promise(r => setTimeout(r, 100));
                return { greeting: `Hello ${name}`, doubled: value * 2 };
            }
        );

        const handle1 = await simpleJob('Developer', 21);
        logTest('Job created successfully', handle1.jobId.length > 0);

        const result1 = await handle1.result(5000);
        logTest(
            'Job returned correct result',
            result1.greeting === 'Hello Developer' && result1.doubled === 42,
            JSON.stringify(result1)
        );

        const status1 = await handle1.status();
        logTest('Job status is success', status1 === 'success', status1);

        // ========== TEST 2: Multiple Jobs in Parallel ==========
        console.log('\nTest 2: Multiple jobs in parallel');
        console.log('-'.repeat(40));

        const startTime = Date.now();
        const parallelJobs = await Promise.all([
            simpleJob('Alice', 1),
            simpleJob('Bob', 2),
            simpleJob('Charlie', 3),
            simpleJob('Diana', 4),
            simpleJob('Eve', 5),
        ]);

        logTest('All 5 jobs enqueued', parallelJobs.length === 5);

        const parallelResults = await Promise.all(parallelJobs.map(j => j.result(10000)));
        const elapsedTime = Date.now() - startTime;

        logTest(
            'All jobs completed',
            parallelResults.length === 5,
            `${parallelResults.length}/5`
        );

        // Check results are correct
        const correctResults = parallelResults.every((r, i) => r.doubled === (i + 1) * 2);
        logTest('All results are correct', correctResults);

        // ========== TEST 3: Job with Object Arguments ==========
        console.log('\nTest 3: Complex object arguments');
        console.log('-'.repeat(40));

        const processOrder = reseolio.durable(
            reseolio.namespace('e2e', 'test01', 'processOrder'),
            async (order: { id: string; items: string[]; total: number }) => {
                await new Promise(r => setTimeout(r, 50));
                return {
                    orderId: order.id,
                    itemCount: order.items.length,
                    processed: true,
                    timestamp: Date.now(),
                };
            }
        );

        const orderHandle = await processOrder({
            id: 'order-12345',
            items: ['Widget A', 'Widget B', 'Widget C'],
            total: 99.99,
        });

        const orderResult = await orderHandle.result(5000);
        logTest(
            'Complex object arguments work',
            orderResult.orderId === 'order-12345' && orderResult.itemCount === 3
        );

        // ========== TEST 4: Job Details ==========
        console.log('\nTest 4: Job details retrieval');
        console.log('-'.repeat(40));

        const details = await orderHandle.details();
        logTest('Details contain job ID', details.id === orderHandle.jobId);
        logTest('Details contain correct name', details.name === 'e2e:test01:processOrder');
        logTest('Details show success status', details.status === 'success');
        logTest('Details have attempt count', details.attempt >= 1);

        // ========== TEST 5: Job Cancellation (Pending Job) ==========
        console.log('\nTest 5: Job cancellation');
        console.log('-'.repeat(40));

        const slowJob = reseolio.durable(
            reseolio.namespace('e2e', 'test01', 'slowJob'),
            async () => {
                await new Promise(r => setTimeout(r, 30000)); // Very slow
                return { completed: true };
            }
        );

        // Create a slow job and immediately try to cancel
        // Note: This test depends on timing - the job may already be running
        const slowHandle = await slowJob();
        const cancelResult = await slowHandle.cancel();
        console.log(`    Cancel result: ${cancelResult}`);
        logTest(
            'Cancel returns boolean',
            typeof cancelResult === 'boolean'
        );

        // ========== TEST 6: Empty/Null Arguments ==========
        console.log('\nTest 6: Edge case - no arguments');
        console.log('-'.repeat(40));

        const noArgsJob = reseolio.durable(
            reseolio.namespace('e2e', 'test01', 'noArgs'),
            async () => {
                return { noArgs: true, timestamp: Date.now() };
            }
        );

        const noArgsHandle = await noArgsJob();
        const noArgsResult = await noArgsHandle.result(5000);
        logTest('No-argument job works', noArgsResult.noArgs === true);

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
