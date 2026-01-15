/**
 * E2E Test 04: Function Namespacing
 * 
 * Tests function naming and namespacing best practices:
 * - Namespace helper creates correct names
 * - Collision detection prevents duplicate registrations
 * - Multiple functions can coexist
 * - Namespaced functions work correctly
 * 
 * Prerequisites: Run reseolio-core first
 * Run: npx tsx tests/e2e/04-function-namespacing.ts
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
    console.log('🧪 E2E Test 04: Function Namespacing\n');
    console.log('='.repeat(50));

    const reseolio = new Reseolio({
        storage: 'localhost:50051',
        autoStart: false,
    });

    try {
        await reseolio.start();
        console.log('✅ Connected to Reseolio\n');

        // ========== TEST 1: Namespace Helper ==========
        console.log('Test 1: Namespace helper creates correct names');
        console.log('-'.repeat(40));

        const name1 = reseolio.namespace('payments', 'billing', 'process');
        console.log(`    namespace('payments', 'billing', 'process') = '${name1}'`);
        logTest('Three-part namespace', name1 === 'payments:billing:process');

        const name2 = reseolio.namespace('notifications', 'email');
        console.log(`    namespace('notifications', 'email') = '${name2}'`);
        logTest('Two-part namespace', name2 === 'notifications:email');

        const name3 = reseolio.namespace('single');
        console.log(`    namespace('single') = '${name3}'`);
        logTest('Single-part namespace', name3 === 'single');

        // ========== TEST 2: Register Multiple Namespaced Functions ==========
        console.log('\nTest 2: Multiple functions with different namespaces');
        console.log('-'.repeat(40));

        const ordersProcess = reseolio.durable(
            reseolio.namespace('orders', 'fulfillment', 'process'),
            async (orderId: string) => ({ orderId, module: 'orders' })
        );

        const inventoryReserve = reseolio.durable(
            reseolio.namespace('inventory', 'stock', 'reserve'),
            async (sku: string, quantity: number) => ({ sku, quantity, module: 'inventory' })
        );

        const notificationsSend = reseolio.durable(
            reseolio.namespace('notifications', 'email', 'send'),
            async (to: string, subject: string) => ({ to, subject, module: 'notifications' })
        );

        logTest('Multiple namespaced functions registered', true);

        // Verify they work
        const orderJob = await ordersProcess('order-123');
        const inventoryJob = await inventoryReserve('SKU-456', 5);
        const notifyJob = await notificationsSend('user@example.com', 'Hello');

        const [orderResult, inventoryResult, notifyResult] = await Promise.all([
            orderJob.result(5000),
            inventoryJob.result(5000),
            notifyJob.result(5000),
        ]);

        logTest(
            'All functions execute correctly',
            orderResult.module === 'orders' &&
            inventoryResult.module === 'inventory' &&
            notifyResult.module === 'notifications'
        );

        // ========== TEST 3: Function Name Stored Correctly ==========
        console.log('\nTest 3: Function name stored in job details');
        console.log('-'.repeat(40));

        const orderDetails = await orderJob.details();
        console.log(`    Job name: ${orderDetails.name}`);
        logTest(
            'Job details show namespaced name',
            orderDetails.name === 'orders:fulfillment:process'
        );

        // ========== TEST 4: Collision Detection ==========
        console.log('\nTest 4: Collision detection prevents duplicates');
        console.log('-'.repeat(40));

        // First registration should succeed (already done above)
        // Second registration with same name should throw
        let collisionDetected = false;
        try {
            reseolio.durable(
                reseolio.namespace('orders', 'fulfillment', 'process'),  // Same name!
                async (orderId: string) => ({ orderId, handler: 'duplicate' })
            );
        } catch (error: any) {
            collisionDetected = true;
            console.log(`    Error caught: ${error.message}`);
        }

        logTest('Collision detection throws error', collisionDetected);

        // ========== TEST 5: Similar Names Are Different ==========
        console.log('\nTest 5: Similar but different names work');
        console.log('-'.repeat(40));

        const processA = reseolio.durable(
            reseolio.namespace('module', 'service', 'processA'),
            async () => ({ type: 'A' })
        );

        const processB = reseolio.durable(
            reseolio.namespace('module', 'service', 'processB'),
            async () => ({ type: 'B' })
        );

        const [jobA, jobB] = await Promise.all([processA(), processB()]);
        const [resultA, resultB] = await Promise.all([
            jobA.result(5000),
            jobB.result(5000),
        ]);

        logTest(
            'Similar names work independently',
            resultA.type === 'A' && resultB.type === 'B'
        );

        // ========== TEST 6: DurableFunction Properties ==========
        console.log('\nTest 6: DurableFunction exposes name and options');
        console.log('-'.repeat(40));

        const configuredFunction = reseolio.durable(
            reseolio.namespace('test', 'config', 'example'),
            async () => ({ done: true }),
            {
                maxAttempts: 10,
                backoff: 'exponential',
                initialDelayMs: 500,
            }
        );

        console.log(`    functionName: ${configuredFunction.functionName}`);
        console.log(`    options.maxAttempts: ${configuredFunction.options.maxAttempts}`);
        console.log(`    options.backoff: ${configuredFunction.options.backoff}`);

        logTest(
            'DurableFunction exposes correct properties',
            configuredFunction.functionName === 'test:config:example' &&
            configuredFunction.options.maxAttempts === 10 &&
            configuredFunction.options.backoff === 'exponential'
        );

        // ========== TEST 7: Domain-Driven Namespacing Pattern ==========
        console.log('\nTest 7: Domain-driven design pattern');
        console.log('-'.repeat(40));

        // E-commerce example
        const ecommerceJobs = {
            createOrder: reseolio.durable(
                reseolio.namespace('ecommerce', 'orders', 'create'),
                async (customerId: string, items: string[]) => ({
                    orderId: `ORD-${Date.now()}`,
                    customerId,
                    itemCount: items.length,
                })
            ),

            shipOrder: reseolio.durable(
                reseolio.namespace('ecommerce', 'orders', 'ship'),
                async (orderId: string) => ({
                    orderId,
                    shipped: true,
                    trackingNumber: `TRACK-${Date.now()}`,
                })
            ),

            sendReceipt: reseolio.durable(
                reseolio.namespace('ecommerce', 'billing', 'receipt'),
                async (orderId: string, email: string) => ({
                    orderId,
                    email,
                    sent: true,
                })
            ),
        };

        // Use the domain jobs
        const createJob = await ecommerceJobs.createOrder('cust-001', ['item1', 'item2', 'item3']);
        const createResult = await createJob.result(5000);

        const shipJob = await ecommerceJobs.shipOrder(createResult.orderId);
        const shipResult = await shipJob.result(5000);

        const receiptJob = await ecommerceJobs.sendReceipt(createResult.orderId, 'customer@example.com');
        const receiptResult = await receiptJob.result(5000);

        logTest(
            'Domain-driven pattern works correctly',
            createResult.itemCount === 3 &&
            shipResult.shipped === true &&
            receiptResult.sent === true
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
