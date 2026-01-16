/**
 * E2E Test 10: Fan-Out and Parallel Execution
 * 
 * Tests parallel job execution patterns where multiple independent jobs
 * are spawned and their results aggregated. Validates:
 * - Fan-out: spawning multiple jobs in parallel
 * - Fan-in: waiting for all jobs to complete
 * - Mixed success/failure handling with Promise.allSettled
 * - Performance of parallel vs sequential execution
 * 
 * Prerequisites: Run reseolio-core first
 * Run: npx tsx tests/e2e/10-fanout-parallel.ts
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
    console.log('🧪 E2E Test 10: Fan-Out and Parallel Execution\n');
    console.log('='.repeat(50));

    const reseolio = new Reseolio({
        storage: 'localhost:50051',
        autoStart: false,
    });

    try {
        await reseolio.start();
        console.log('✅ Connected to Reseolio\n');

        // ========== TEST 1: Basic Fan-Out ==========
        console.log('Test 1: Fan-out - spawn multiple jobs in parallel');
        console.log('-'.repeat(40));

        const processItem = reseolio.durable(
            reseolio.namespace('e2e', 'fanout', 'processItem'),
            async (itemId: string, delayMs: number) => {
                console.log(`    [ITEM] Processing ${itemId}`);
                await new Promise(r => setTimeout(r, delayMs));
                return { itemId, processed: true };
            }
        );

        const items = ['item-1', 'item-2', 'item-3', 'item-4', 'item-5'];

        // Fan-out: spawn all jobs in parallel
        const startTime = Date.now();
        const handles = await Promise.all(
            items.map((item, idx) => processItem(item, 100 + idx * 10))
        );
        const enqueueTime = Date.now() - startTime;
        console.log(`    Enqueue time for ${items.length} jobs: ${enqueueTime}ms`);

        logTest('All jobs enqueued', handles.length === 5);

        // Fan-in: wait for all results
        const fanInStart = Date.now();
        const allResults = await Promise.all(handles.map(h => h.result(30000)));
        const fanInTime = Date.now() - fanInStart;
        console.log(`    Fan-in time: ${fanInTime}ms`);

        logTest('All results received', allResults.length === 5);
        logTest('All items processed', allResults.every(r => r.processed === true));

        // ========== TEST 2: Fan-Out with Different Timeouts ==========
        console.log('\nTest 2: Fan-out with varying execution times');
        console.log('-'.repeat(40));

        const variableTimeJob = reseolio.durable(
            reseolio.namespace('e2e', 'fanout', 'variableTime'),
            async (id: string, delayMs: number) => {
                const start = Date.now();
                await new Promise(r => setTimeout(r, delayMs));
                return { id, actualDelay: Date.now() - start };
            }
        );

        const delays = [50, 100, 150, 200, 250];
        const varHandles = await Promise.all(
            delays.map((d, i) => variableTimeJob(`var-${i}`, d))
        );

        const varResults = await Promise.all(varHandles.map(h => h.result(30000)));

        // All should complete
        logTest('All variable-time jobs complete', varResults.length === delays.length);

        // ========== TEST 3: Aggregation Pattern ==========
        console.log('\nTest 3: Aggregation - collect results from parallel jobs');
        console.log('-'.repeat(40));

        const fetchPrice = reseolio.durable(
            reseolio.namespace('e2e', 'fanout', 'fetchPrice'),
            async (source: string) => {
                // Simulate fetching price from different sources
                const prices: Record<string, number> = {
                    'source-A': 100.00,
                    'source-B': 99.50,
                    'source-C': 101.25,
                };
                await new Promise(r => setTimeout(r, 50));
                return { source, price: prices[source] || 0 };
            }
        );

        const aggregator = reseolio.durable(
            reseolio.namespace('e2e', 'fanout', 'aggregator'),
            async (sources: string[]) => {
                // Fan-out to all sources
                const handles = await Promise.all(
                    sources.map(s => fetchPrice(s))
                );

                // Fan-in and aggregate
                const prices = await Promise.all(handles.map(h => h.result(10000)));

                const avgPrice = prices.reduce((sum, p) => sum + p.price, 0) / prices.length;
                const minPrice = Math.min(...prices.map(p => p.price));
                const maxPrice = Math.max(...prices.map(p => p.price));

                return { avgPrice, minPrice, maxPrice, sources: prices.length };
            }
        );

        const aggHandle = await aggregator(['source-A', 'source-B', 'source-C']);
        const aggResult = await aggHandle.result(30000);

        logTest('Aggregation completed', aggResult.sources === 3);
        logTest('Average price calculated', aggResult.avgPrice > 0);
        logTest('Min price is smallest', aggResult.minPrice === 99.50);
        logTest('Max price is largest', aggResult.maxPrice === 101.25);

        // ========== TEST 4: Partial Failure with allSettled ==========
        console.log('\nTest 4: Handling partial failures with Promise.allSettled');
        console.log('-'.repeat(40));

        let attemptCount = 0;
        const mayFail = reseolio.durable(
            reseolio.namespace('e2e', 'fanout', 'mayFail'),
            async (shouldFail: boolean) => {
                attemptCount++;
                console.log(`    [MAYFAIL] Attempt ${attemptCount}, shouldFail=${shouldFail}`);
                await new Promise(r => setTimeout(r, 50));
                if (shouldFail) {
                    throw new Error('Intentional failure');
                }
                return { success: true };
            },
            { maxAttempts: 1 } // No retries - fail immediately
        );

        // Mix of success and failure jobs
        const mayFailHandles = await Promise.all([
            mayFail(false),  // Will succeed
            mayFail(true),   // Will fail
            mayFail(false),  // Will succeed
        ]);

        // Use allSettled to get all results regardless of success/failure
        const settledResults = await Promise.allSettled(
            mayFailHandles.map(h => h.result(10000))
        );

        const succeeded = settledResults.filter(r => r.status === 'fulfilled').length;
        const failed = settledResults.filter(r => r.status === 'rejected').length;

        console.log(`    Succeeded: ${succeeded}, Failed: ${failed}`);

        logTest('allSettled captures all outcomes', settledResults.length === 3);
        logTest('Some jobs succeeded', succeeded >= 1);
        logTest('Some jobs failed as expected', failed >= 1);

        // ========== TEST 5: Map-Reduce Pattern ==========
        console.log('\nTest 5: Map-Reduce pattern');
        console.log('-'.repeat(40));

        const mapJob = reseolio.durable(
            reseolio.namespace('e2e', 'mapreduce', 'map'),
            async (chunk: number[]) => {
                // Map: sum each chunk
                const sum = chunk.reduce((a, b) => a + b, 0);
                return { chunkSum: sum, count: chunk.length };
            }
        );

        const reduceJob = reseolio.durable(
            reseolio.namespace('e2e', 'mapreduce', 'reduce'),
            async (partialResults: { chunkSum: number; count: number }[]) => {
                // Reduce: combine all chunk results
                const totalSum = partialResults.reduce((acc, r) => acc + r.chunkSum, 0);
                const totalCount = partialResults.reduce((acc, r) => acc + r.count, 0);
                return { totalSum, totalCount, average: totalSum / totalCount };
            }
        );

        // Data to process
        const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        const chunkSize = 3;
        const chunks: number[][] = [];
        for (let i = 0; i < data.length; i += chunkSize) {
            chunks.push(data.slice(i, i + chunkSize));
        }

        // Map phase: process all chunks in parallel
        const mapHandles = await Promise.all(chunks.map(chunk => mapJob(chunk)));
        const mapResults = await Promise.all(mapHandles.map(h => h.result(10000)));

        // Reduce phase: aggregate results
        const reduceHandle = await reduceJob(mapResults);
        const finalResult = await reduceHandle.result(10000);

        logTest('Map phase completed', mapResults.length === 4); // 3+3+3+1 = 10 items in 4 chunks
        logTest('Reduce computed correct sum', finalResult.totalSum === 55); // 1+2+...+10 = 55
        logTest('Reduce computed correct count', finalResult.totalCount === 10);
        logTest('Average is correct', finalResult.average === 5.5);

        // ========== SUMMARY ==========
        console.log('\n' + '='.repeat(50));
        console.log('📊 TEST SUMMARY');
        console.log('='.repeat(50));

        const passed = results.filter(r => r.passed).length;
        const failedCount = results.filter(r => !r.passed).length;

        console.log(`  Total:  ${results.length}`);
        console.log(`  Passed: ${passed}`);
        console.log(`  Failed: ${failedCount}`);

        if (failedCount > 0) {
            console.log('\n❌ Failed tests:');
            results.filter(r => !r.passed).forEach(r => {
                console.log(`    - ${r.name}: ${r.error}`);
            });
        }

        await reseolio.stop();

        console.log('\n' + (failedCount === 0 ? '🎉 ALL TESTS PASSED!' : '❌ SOME TESTS FAILED'));
        process.exit(failedCount === 0 ? 0 : 1);

    } catch (error) {
        console.error('\n❌ Fatal error:', error);
        await reseolio.stop().catch(() => { });
        process.exit(1);
    }
}

runTests();
