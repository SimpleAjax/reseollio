/**
 * E2E Test 03: Idempotency and Deduplication
 * 
 * Tests idempotency key functionality:
 * - Same key returns same job
 * - Different keys create different jobs
 * - Keys are scoped per function name
 * - Jobs without keys always create new jobs
 * 
 * Prerequisites: Run reseolio-core first
 * Run: npx tsx tests/e2e/03-idempotency-deduplication.ts
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
    console.log('🧪 E2E Test 03: Idempotency and Deduplication\n');
    console.log('='.repeat(50));

    const reseolio = new Reseolio({
        storage: 'localhost:50051',
        autoStart: false,
    });

    try {
        await reseolio.start();
        console.log('✅ Connected to Reseolio\n');

        // Define test functions
        const processPayment = reseolio.durable(
            reseolio.namespace('e2e', 'test03', 'payment'),
            async (orderId: string, amount: number) => {
                await new Promise(r => setTimeout(r, 100));
                return {
                    orderId,
                    amount,
                    processed: true,
                    timestamp: Date.now(),
                };
            }
        );

        const sendNotification = reseolio.durable(
            reseolio.namespace('e2e', 'test03', 'notify'),
            async (userId: string, message: string) => {
                await new Promise(r => setTimeout(r, 100));
                return {
                    userId,
                    message,
                    sent: true,
                    timestamp: Date.now(),
                };
            }
        );

        const timestamp = Date.now();

        // ========== TEST 1: Same Idempotency Key ==========
        console.log('Test 1: Same idempotency key returns same job');
        console.log('-'.repeat(40));

        const key1 = `payment-order-123-${timestamp}`;

        const payment1 = await processPayment('order-123', 99.99, {
            idempotencyKey: key1,
        });
        console.log(`    Job 1 ID: ${payment1.jobId}`);

        // Small delay
        await new Promise(r => setTimeout(r, 50));

        const payment2 = await processPayment('order-123', 99.99, {
            idempotencyKey: key1,  // Same key
        });
        console.log(`    Job 2 ID: ${payment2.jobId}`);

        logTest('Same key returns same job ID', payment1.jobId === payment2.jobId);

        // ========== TEST 2: Different Idempotency Key ==========
        console.log('\nTest 2: Different idempotency key creates new job');
        console.log('-'.repeat(40));

        const key2 = `payment-order-456-${timestamp}`;

        const payment3 = await processPayment('order-456', 199.99, {
            idempotencyKey: key2,
        });
        console.log(`    Job 3 ID: ${payment3.jobId}`);

        logTest('Different key creates different job', payment1.jobId !== payment3.jobId);

        // ========== TEST 3: No Idempotency Key ==========
        console.log('\nTest 3: No idempotency key always creates new job');
        console.log('-'.repeat(40));

        const noKey1 = await processPayment('order-789', 49.99);
        const noKey2 = await processPayment('order-789', 49.99);  // Same args
        const noKey3 = await processPayment('order-789', 49.99);  // Same args again

        console.log(`    Job (no key) 1: ${noKey1.jobId}`);
        console.log(`    Job (no key) 2: ${noKey2.jobId}`);
        console.log(`    Job (no key) 3: ${noKey3.jobId}`);

        logTest(
            'Each call without key creates new job',
            noKey1.jobId !== noKey2.jobId && noKey2.jobId !== noKey3.jobId
        );

        // ========== TEST 4: Keys Scoped Per Function ==========
        console.log('\nTest 4: Idempotency keys are scoped per function');
        console.log('-'.repeat(40));

        const sharedKey = `shared-key-${timestamp}`;

        const paymentWithSharedKey = await processPayment('order-999', 299.99, {
            idempotencyKey: sharedKey,
        });
        console.log(`    Payment job ID: ${paymentWithSharedKey.jobId}`);

        const notifyWithSharedKey = await sendNotification('user-123', 'Order confirmed', {
            idempotencyKey: sharedKey,  // Same key, different function
        });
        console.log(`    Notification job ID: ${notifyWithSharedKey.jobId}`);

        logTest(
            'Same key on different functions creates different jobs',
            paymentWithSharedKey.jobId !== notifyWithSharedKey.jobId
        );

        // ========== TEST 5: Same Function + Same Key = Deduplicated ==========
        console.log('\nTest 5: Same function + same key = deduplicated');
        console.log('-'.repeat(40));

        const dedupKey = `dedup-test-${timestamp}`;

        const notify1 = await sendNotification('user-456', 'Welcome!', {
            idempotencyKey: dedupKey,
        });

        // Call 5 more times with same key
        const notifyDuplicates = await Promise.all([
            sendNotification('user-456', 'Welcome!', { idempotencyKey: dedupKey }),
            sendNotification('user-456', 'Welcome!', { idempotencyKey: dedupKey }),
            sendNotification('user-456', 'Welcome!', { idempotencyKey: dedupKey }),
            sendNotification('user-456', 'Welcome!', { idempotencyKey: dedupKey }),
            sendNotification('user-456', 'Welcome!', { idempotencyKey: dedupKey }),
        ]);

        const allSameId = notifyDuplicates.every(n => n.jobId === notify1.jobId);
        console.log(`    All ${notifyDuplicates.length + 1} calls returned same job ID: ${allSameId}`);
        logTest('Multiple calls with same key all deduplicated', allSameId);

        // ========== TEST 6: Results Are Shared ==========
        console.log('\nTest 6: Deduplicated jobs share results');
        console.log('-'.repeat(40));

        const resultKey = `result-test-${timestamp}`;

        const result1 = await processPayment('order-shared', 500.00, {
            idempotencyKey: resultKey,
        });

        // Start waiting for result before creating second handle
        const result2 = await processPayment('order-shared', 500.00, {
            idempotencyKey: resultKey,
        });

        const [r1, r2] = await Promise.all([
            result1.result(5000),
            result2.result(5000),
        ]);

        console.log(`    Result 1 timestamp: ${r1.timestamp}`);
        console.log(`    Result 2 timestamp: ${r2.timestamp}`);

        logTest(
            'Both handles get same result',
            r1.orderId === r2.orderId && r1.timestamp === r2.timestamp
        );

        // ========== TEST 7: Idempotency with Per-Execution Options ==========
        console.log('\nTest 7: Idempotency key with custom options');
        console.log('-'.repeat(40));

        const criticalKey = `critical-payment-${timestamp}`;

        const criticalPayment = await processPayment('order-critical', 10000.00, {
            idempotencyKey: criticalKey,
            maxAttempts: 10,      // Override default
            initialDelayMs: 500,  // Custom delay
        });

        console.log(`    Critical payment job ID: ${criticalPayment.jobId}`);
        logTest('Idempotency key works with custom options', criticalPayment.jobId.length > 0);

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
