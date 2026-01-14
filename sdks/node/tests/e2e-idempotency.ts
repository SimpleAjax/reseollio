/**
 * E2E Test: Idempotency Key Deduplication
 * 
 * Prerequisites: Docker must be running with reseolio-dev container
 * Run: docker-compose -f docker-compose.loadtest.yml up -d dev
 * 
 * This test verifies that:
 * 1. Jobs with the same idempotency key are deduplicated
 * 2. Jobs with different keys create separate jobs
 * 3. Jobs without keys always create new jobs
 */

import { Reseolio } from '../src/client';

async function testIdempotencyE2E() {
    console.log('🧪 E2E Test: Idempotency Key Deduplication\n');
    console.log('📋 Prerequisites:');
    console.log('  • Docker must be running');
    console.log('  • Run: docker-compose -f docker-compose.loadtest.yml up -d dev\n');

    const reseolio = new Reseolio({
        address: 'localhost:50051',  // Connect to Docker container
        autoStart: false  // Don't start core, use Docker
    });

    try {
        await reseolio.start();
        console.log('✅ Connected to Reseolio server\n');

        // Define a simple durable function
        const processOrder = reseolio.durable(
            reseolio.namespace('e2e', 'orders', 'process'),
            async (orderId: string, amount: number) => {
                console.log(`  📦 Processing order ${orderId} for $${amount}`);
                await new Promise(r => setTimeout(r, 100)); // Small delay
                return { orderId, amount, processed: true, timestamp: Date.now() };
            }
        );

        console.log('Test 1: Same idempotency key should deduplicate');
        console.log('-----------------------------------------------');

        const key1 = `order-123-${Date.now()}`;

        // Call 1: Create job with idempotency key
        const job1 = await processOrder('order-123', 99.99, {
            idempotencyKey: key1
        });
        console.log(`  Job 1 ID: ${job1.jobId}`);

        // Small delay to ensure first call is processed
        await new Promise(r => setTimeout(r, 50));

        // Call 2: Same key - should return same job
        const job2 = await processOrder('order-123', 99.99, {
            idempotencyKey: key1  // Same key!
        });
        console.log(`  Job 2 ID: ${job2.jobId}`);

        if (job1.jobId === job2.jobId) {
            console.log('✅ PASS: Same idempotency key returned same job\n');
        } else {
            console.error(`❌ FAIL: Expected same job ID`);
            console.error(`  Job 1: ${job1.jobId}`);
            console.error(`  Job 2: ${job2.jobId}`);
            throw new Error('Idempotency test failed: different job IDs for same key');
        }

        console.log('Test 2: Different idempotency keys create different jobs');
        console.log('----------------------------------------------------------');

        const key2 = `order-456-${Date.now()}`;

        // Call 3: Different key - should create new job
        const job3 = await processOrder('order-456', 199.99, {
            idempotencyKey: key2  // Different key
        });
        console.log(`  Job 3 ID: ${job3.jobId}`);

        if (job1.jobId !== job3.jobId) {
            console.log('✅ PASS: Different idempotency key created different job\n');
        } else {
            console.error('❌ FAIL: Expected different job ID for different key');
            throw new Error('Idempotency test failed: same job ID for different keys');
        }

        console.log('Test 3: No idempotency key always creates new jobs');
        console.log('---------------------------------------------------');

        // Call 4 & 5: No key - should create new jobs every time
        const job4 = await processOrder('order-789', 299.99);
        const job5 = await processOrder('order-789', 299.99);  // Same args, no key

        console.log(`  Job 4 ID: ${job4.jobId}`);
        console.log(`  Job 5 ID: ${job5.jobId}`);

        if (job4.jobId !== job5.jobId) {
            console.log('✅ PASS: No idempotency key created different jobs\n');
        } else {
            console.error('❌ FAIL: Expected different job IDs without idempotency key');
            throw new Error('Idempotency test failed: same job without keys');
        }

        console.log('Test 4: Verify jobs execute correctly');
        console.log('---------------------------------------');

        // Wait for job to complete (with timeout)
        console.log('  Waiting for job 1 to complete...');
        const result1 = await Promise.race([
            job1.result(),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Timeout waiting for job')), 10000)
            )
        ]);
        console.log(`  Job 1 result:`, result1);

        if (result1.orderId === 'order-123' && result1.processed === true) {
            console.log('✅ PASS: Job executed and returned correct result\n');
        } else {
            console.error('❌ FAIL: Job result incorrect', result1);
            throw new Error('Job execution test failed');
        }

        console.log('Test 5: Check job details');
        console.log('--------------------------');

        const details = await job1.details();
        console.log(`  Status: ${details.status}`);
        console.log(`  Attempt: ${details.attempt}`);
        console.log(`  Name: ${details.name}`);

        if (details.status === 'success' && details.name === 'e2e:orders:process') {
            console.log('✅ PASS: Job details correct\n');
        } else {
            console.error('❌ FAIL: Job details incorrect', details);
            throw new Error('Job details test failed');
        }

        console.log('Test 6: Override other options with idempotency key');
        console.log('----------------------------------------------------');

        const key3 = `order-critical-${Date.now()}`;
        const job6 = await processOrder('order-999', 9999.99, {
            idempotencyKey: key3,
            maxAttempts: 10,  // Override default
            initialDelayMs: 500
        });

        console.log(`  Job 6 ID: ${job6.jobId}`);
        console.log('✅ PASS: Can pass options along with idempotency key\n');

        console.log('🎉 All idempotency tests passed!');
        console.log('\n📊 Summary:');
        console.log(`  ✅ Same key deduplication: ${job1.jobId === job2.jobId ? 'PASS' : 'FAIL'}`);
        console.log(`  ✅ Different keys create different jobs: ${job1.jobId !== job3.jobId ? 'PASS' : 'FAIL'}`);
        console.log(`  ✅ No key creates new jobs: ${job4.jobId !== job5.jobId ? 'PASS' : 'FAIL'}`);
        console.log(`  ✅ Job execution: ${details.status === 'success' ? 'PASS' : 'FAIL'}`);
        console.log(`  ✅ Per-execution options: PASS`);

    } catch (error) {
        console.error('\n❌ Test failed:', error);
        console.error('\n💡 Troubleshooting:');
        console.error('  1. Make sure Docker is running');
        console.error('  2. Run: docker-compose -f ../../docker-compose.loadtest.yml up -d dev');
        console.error('  3. Check logs: docker logs reseolio-dev');
        throw error;
    } finally {
        await reseolio.stop();
        console.log('\n✅ Test cleanup complete');
    }
}

// Run the test
testIdempotencyE2E().catch((err) => {
    console.error('\nTest suite failed');
    process.exit(1);
});
