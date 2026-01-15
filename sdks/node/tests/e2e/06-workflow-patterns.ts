/**
 * E2E Test 06: Real-World Workflow Patterns
 * Tests common developer patterns: chained jobs, fan-out/fan-in, saga pattern
 * Run: npx tsx tests/e2e/06-workflow-patterns.ts
 */

import { Reseolio } from '../../src/client';

const results: { name: string; passed: boolean; error?: string }[] = [];

function logTest(name: string, passed: boolean, error?: string) {
    results.push({ name, passed, error });
    console.log(passed ? `  ✅ ${name}` : `  ❌ ${name}: ${error}`);
}

async function runTests() {
    console.log('🧪 E2E Test 06: Real-World Workflow Patterns\n');

    const reseolio = new Reseolio({
        storage: 'localhost:50051',
        autoStart: false,
    });

    try {
        await reseolio.start();
        console.log('✅ Connected to Reseolio\n');

        // ========== TEST 1: Chained Jobs (Sequential Pipeline) ==========
        console.log('Test 1: Chained jobs (sequential pipeline)');
        console.log('-'.repeat(40));

        const validateOrder = reseolio.durable('workflow:order:validate',
            async (orderId: string, items: string[]) => {
                await new Promise(r => setTimeout(r, 50));
                return { orderId, validated: true, itemCount: items.length };
            }
        );

        const processPayment = reseolio.durable('workflow:payment:process',
            async (orderId: string, amount: number) => {
                await new Promise(r => setTimeout(r, 50));
                return { orderId, paid: true, amount, txnId: `TXN-${Date.now()}` };
            }
        );

        const shipOrder = reseolio.durable('workflow:shipping:ship',
            async (orderId: string, txnId: string) => {
                await new Promise(r => setTimeout(r, 50));
                return { orderId, shipped: true, trackingId: `TRACK-${Date.now()}` };
            }
        );

        // Execute pipeline
        const step1 = await validateOrder('ORD-001', ['item1', 'item2']);
        const result1 = await step1.result(5000);
        console.log(`    Step 1: Validated ${result1.itemCount} items`);

        const step2 = await processPayment(result1.orderId, 99.99);
        const result2 = await step2.result(5000);
        console.log(`    Step 2: Payment ${result2.txnId}`);

        const step3 = await shipOrder(result1.orderId, result2.txnId);
        const result3 = await step3.result(5000);
        console.log(`    Step 3: Tracking ${result3.trackingId}`);

        logTest('Chained pipeline completes', result3.shipped === true);

        // ========== TEST 2: Fan-Out/Fan-In Pattern ==========
        console.log('\nTest 2: Fan-out/Fan-in pattern');
        console.log('-'.repeat(40));

        const processItem = reseolio.durable('workflow:items:process',
            async (itemId: number) => {
                await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
                return { itemId, processed: true, score: Math.random() };
            }
        );

        const aggregateResults = reseolio.durable('workflow:items:aggregate',
            async (scores: number[]) => {
                const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
                return { avgScore: avg, count: scores.length };
            }
        );

        // Fan-out: process items in parallel
        const fanOutHandles = await Promise.all([
            processItem(1), processItem(2), processItem(3),
            processItem(4), processItem(5), processItem(6),
        ]);

        // Wait for all
        const itemResults = await Promise.all(fanOutHandles.map(h => h.result(10000)));
        console.log(`    Processed ${itemResults.length} items in parallel`);

        // Fan-in: aggregate
        const scores = itemResults.map(r => r.score);
        const aggHandle = await aggregateResults(scores);
        const aggResult = await aggHandle.result(5000);
        console.log(`    Aggregated: avg=${aggResult.avgScore.toFixed(2)}, count=${aggResult.count}`);

        logTest('Fan-out/fan-in pattern works', aggResult.count === 6);

        // ========== TEST 3: Saga Pattern with Compensation ==========
        console.log('\nTest 3: Saga pattern (with compensation on failure)');
        console.log('-'.repeat(40));

        const sagaState = { reserved: false, charged: false };

        const reserveInventory = reseolio.durable('saga:inventory:reserve',
            async (sku: string) => {
                sagaState.reserved = true;
                return { sku, reserved: true };
            }
        );

        const rollbackInventory = reseolio.durable('saga:inventory:rollback',
            async (sku: string) => {
                sagaState.reserved = false;
                return { sku, rolledBack: true };
            }
        );

        const chargeCreditCard = reseolio.durable('saga:payment:charge',
            async (amount: number, shouldFail: boolean) => {
                if (shouldFail) throw new Error('Card declined');
                sagaState.charged = true;
                return { amount, charged: true };
            },
            { maxAttempts: 1 }
        );

        // Execute saga that will fail
        const reserveHandle = await reserveInventory('SKU-123');
        await reserveHandle.result(5000);
        console.log(`    Step 1: Inventory reserved`);

        try {
            const chargeHandle = await chargeCreditCard(100, true); // Will fail
            await chargeHandle.result(5000);
        } catch {
            console.log(`    Step 2: Payment failed, rolling back...`);
            const rollbackHandle = await rollbackInventory('SKU-123');
            await rollbackHandle.result(5000);
            console.log(`    Step 3: Inventory rollback completed`);
        }

        logTest('Saga compensation executed', sagaState.reserved === false);

        // ========== SUMMARY ==========
        console.log('\n' + '='.repeat(50));
        const passed = results.filter(r => r.passed).length;
        const failed = results.filter(r => !r.passed).length;
        console.log(`📊 Passed: ${passed}/${results.length}`);

        await reseolio.stop();
        process.exit(failed === 0 ? 0 : 1);

    } catch (error) {
        console.error('❌ Fatal error:', error);
        await reseolio.stop().catch(() => { });
        process.exit(1);
    }
}

runTests();
