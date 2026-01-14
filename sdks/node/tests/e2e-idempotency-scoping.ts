/**
 * E2E Test: Idempotency Key Scoping
 * 
 * Verifies that idempotency keys are scoped per function name,
 * not globally across all functions.
 */

import { Reseolio } from '../src/client';

async function testIdempotencyScoping() {
    console.log('🧪 E2E Test: Idempotency Key Scoping (name + key uniqueness)\n');
    console.log('📋 Prerequisites: Docker container must be running\n');

    const reseolio = new Reseolio({
        address: 'localhost:50051',
        autoStart: false
    });

    try {
        await reseolio.start();
        console.log('✅ Connected to Reseolio server\n');

        // Define two different durable functions
        const processPayment = reseolio.durable(
            reseolio.namespace('test', 'payments', 'process'),
            async (amount: number, orderId: string) => {
                console.log(`  💰 Processing payment: $${amount} for order ${orderId}`);
                await new Promise(r => setTimeout(r, 100));
                return { success: true, amount, orderId, type: 'payment' };
            }
        );

        const sendEmail = reseolio.durable(
            reseolio.namespace('test', 'notifications', 'send'),
            async (to: string, subject: string) => {
                console.log(`  📧 Sending email to ${to}: "${subject}"`);
                await new Promise(r => setTimeout(r, 100));
                return { sent: true, to, subject, type: 'email' };
            }
        );

        const timestamp = Date.now();
        const sharedKey = `test-key-${timestamp}`;

        console.log('Test 1: Different functions can use same idempotency key');
        console.log('-----------------------------------------------------------');
        console.log(`  Using shared key: ${sharedKey}\n`);

        // Call 1: Payment with key 'shared-key'
        const payment1 = await processPayment(99.99, 'order-123', {
            idempotencyKey: sharedKey
        });
        console.log(`  Payment job ID: ${payment1.jobId}`);

        // Call 2: Email with SAME key 'shared-key'
        const email1 = await sendEmail('alice@example.com', 'Order Confirmed', {
            idempotencyKey: sharedKey  // Same key, different function
        });
        console.log(`  Email job ID: ${email1.jobId}`);

        if (payment1.jobId !== email1.jobId) {
            console.log('✅ PASS: Different functions created different jobs with same key\n');
        } else {
            console.error('❌ FAIL: Same job ID for different functions!');
            throw new Error('Idempotency scoping test failed');
        }

        console.log('Test 2: Same function + same key = deduplication');
        console.log('--------------------------------------------------');

        // Call 3: Same payment function with same key
        const payment2 = await processPayment(99.99, 'order-123', {
            idempotencyKey: sharedKey  // Same function + same key
        });
        console.log(`  Payment job ID (2nd call): ${payment2.jobId}`);

        if (payment1.jobId === payment2.jobId) {
            console.log('✅ PASS: Same function + same key returned same job\n');
        } else {
            console.error('❌ FAIL: Expected same job ID for deduplication');
            throw new Error('Deduplication test failed');
        }

        console.log('Test 3: Same function + different key = different jobs');
        console.log('---------------------------------------------------------');

        const differentKey = `different-key-${timestamp}`;
        const payment3 = await processPayment(199.99, 'order-456', {
            idempotencyKey: differentKey  // Different key
        });
        console.log(`  Payment job ID (different key): ${payment3.jobId}`);

        if (payment1.jobId !== payment3.jobId) {
            console.log('✅ PASS: Different key created different job\n');
        } else {
            console.error('❌ FAIL: Expected different job ID for different key');
            throw new Error('Different key test failed');
        }

        console.log('Test 4: Verify all jobs execute correctly');
        console.log('------------------------------------------');

        const paymentResult = await payment1.result();
        console.log(`  Payment result:`, paymentResult);

        const emailResult = await email1.result();
        console.log(`  Email result:`, emailResult);

        if (
            paymentResult.type === 'payment' &&
            paymentResult.success === true &&
            emailResult.type === 'email' &&
            emailResult.sent === true
        ) {
            console.log('✅ PASS: Both jobs executed correctly\n');
        } else {
            console.error('❌ FAIL: Job results incorrect');
            throw new Error('Job execution test failed');
        }

        console.log('🎉 All idempotency scoping tests passed!');
        console.log('\n📊 Summary:');
        console.log(`  ✅ Different functions, same key: ${payment1.jobId !== email1.jobId ? 'PASS' : 'FAIL'}`);
        console.log(`  ✅ Same function, same key (dedupe): ${payment1.jobId === payment2.jobId ? 'PASS' : 'FAIL'}`);
        console.log(`  ✅ Same function, different key: ${payment1.jobId !== payment3.jobId ? 'PASS' : 'FAIL'}`);
        console.log(`  ✅ Job execution: PASS`);

    } catch (error) {
        console.error('\n❌ Test failed:', error);
        throw error;
    } finally {
        await reseolio.stop();
        console.log('\n✅ Test cleanup complete');
    }
}

testIdempotencyScoping().catch((err) => {
    console.error('\nTest suite failed');
    process.exit(1);
});
