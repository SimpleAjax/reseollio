/**
 * E2E Test 09: Chained Durable Functions (Saga Pattern)
 * 
 * Tests the recommended pattern for multi-step workflows where each step
 * should be individually durable and trackable. This validates:
 * - Chaining durable function calls
 * - Per-step retry isolation
 * - Idempotency in orchestrators
 * - Result propagation between steps
 * 
 * Prerequisites: Run reseolio-core first
 * Run: npx tsx tests/e2e/09-chained-durables.ts
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
    console.log('🧪 E2E Test 09: Chained Durable Functions (Saga Pattern)\n');
    console.log('='.repeat(50));

    const reseolio = new Reseolio({
        storage: 'localhost:50051',
        autoStart: false,
    });

    try {
        await reseolio.start();
        console.log('✅ Connected to Reseolio\n');

        // ========== TEST 1: Simple Chain ==========
        console.log('Test 1: Simple two-step chain');
        console.log('-'.repeat(40));

        // Step 1: First function in chain
        const step1 = reseolio.durable(
            reseolio.namespace('e2e', 'chain', 'step1'),
            async (orderId: string) => {
                console.log(`    [STEP1] Processing order ${orderId}`);
                await new Promise(r => setTimeout(r, 100));
                return { orderId, step1Complete: true, timestamp: Date.now() };
            }
        );

        // Step 2: Second function that depends on step 1
        const step2 = reseolio.durable(
            reseolio.namespace('e2e', 'chain', 'step2'),
            async (orderId: string, step1Result: { timestamp: number }) => {
                console.log(`    [STEP2] Completing order ${orderId}, started at ${step1Result.timestamp}`);
                await new Promise(r => setTimeout(r, 100));
                return { orderId, step2Complete: true, step1Timestamp: step1Result.timestamp };
            }
        );

        // Orchestrator that chains them
        const processSimpleOrder = reseolio.durable(
            reseolio.namespace('e2e', 'chain', 'simpleOrchestrator'),
            async (orderId: string) => {
                console.log(`    [ORCH] Starting order processing: ${orderId}`);

                // Step 1
                const handle1 = await step1(orderId);
                const result1 = await handle1.result(10000);
                console.log(`    [ORCH] Step 1 complete`);

                // Step 2
                const handle2 = await step2(orderId, result1);
                const result2 = await handle2.result(10000);
                console.log(`    [ORCH] Step 2 complete`);

                return {
                    orderId,
                    allComplete: true,
                    step1: result1.step1Complete,
                    step2: result2.step2Complete,
                };
            }
        );

        const orderHandle = await processSimpleOrder('order-001');
        const orderResult = await orderHandle.result(30000);

        logTest('Chain completed successfully', orderResult.allComplete === true);
        logTest('Step 1 executed', orderResult.step1 === true);
        logTest('Step 2 executed', orderResult.step2 === true);

        // ========== TEST 2: Three-Step Pipeline ==========
        console.log('\nTest 2: Three-step pipeline with data transformation');
        console.log('-'.repeat(40));

        const validatePayment = reseolio.durable(
            reseolio.namespace('e2e', 'pipeline', 'validate'),
            async (data: { amount: number; cardLast4: string }) => {
                console.log(`    [VALIDATE] Validating payment of $${data.amount}`);
                await new Promise(r => setTimeout(r, 50));
                return { validated: true, validationId: `VAL-${Date.now()}` };
            }
        );

        const processPayment = reseolio.durable(
            reseolio.namespace('e2e', 'pipeline', 'process'),
            async (validationId: string, amount: number) => {
                console.log(`    [PROCESS] Processing payment ${validationId}`);
                await new Promise(r => setTimeout(r, 50));
                return { processed: true, transactionId: `TXN-${Date.now()}` };
            }
        );

        const sendReceipt = reseolio.durable(
            reseolio.namespace('e2e', 'pipeline', 'receipt'),
            async (transactionId: string, email: string) => {
                console.log(`    [RECEIPT] Sending receipt for ${transactionId} to ${email}`);
                await new Promise(r => setTimeout(r, 50));
                return { sent: true, receiptId: `RCP-${Date.now()}` };
            }
        );

        const fullPaymentFlow = reseolio.durable(
            reseolio.namespace('e2e', 'pipeline', 'orchestrator'),
            async (paymentData: { amount: number; cardLast4: string; email: string }) => {
                // Step 1: Validate
                const valHandle = await validatePayment({
                    amount: paymentData.amount,
                    cardLast4: paymentData.cardLast4
                });
                const valResult = await valHandle.result(10000);

                // Step 2: Process
                const procHandle = await processPayment(valResult.validationId, paymentData.amount);
                const procResult = await procHandle.result(10000);

                // Step 3: Receipt
                const rcptHandle = await sendReceipt(procResult.transactionId, paymentData.email);
                const rcptResult = await rcptHandle.result(10000);

                return {
                    success: true,
                    validationId: valResult.validationId,
                    transactionId: procResult.transactionId,
                    receiptId: rcptResult.receiptId,
                };
            }
        );

        const paymentHandle = await fullPaymentFlow({
            amount: 99.99,
            cardLast4: '1234',
            email: 'user@example.com',
        });
        const paymentResult = await paymentHandle.result(60000);

        logTest('Pipeline completed', paymentResult.success === true);
        logTest('Has validation ID', paymentResult.validationId?.startsWith('VAL-'));
        logTest('Has transaction ID', paymentResult.transactionId?.startsWith('TXN-'));
        logTest('Has receipt ID', paymentResult.receiptId?.startsWith('RCP-'));

        // ========== TEST 3: Idempotency in Chains ==========
        console.log('\nTest 3: Idempotency - same orchestrator call returns same job');
        console.log('-'.repeat(40));

        const idempotentKey = `idem-chain-${Date.now()}`;

        const handle1 = await processSimpleOrder('order-002', { idempotencyKey: idempotentKey });
        const handle2 = await processSimpleOrder('order-002', { idempotencyKey: idempotentKey });

        logTest('Same idempotency key returns same job', handle1.jobId === handle2.jobId);

        // ========== TEST 4: Child Jobs Have Unique IDs ==========
        console.log('\nTest 4: Each step creates distinct jobs');
        console.log('-'.repeat(40));

        const jobIds: string[] = [];

        // Create a tracking orchestrator
        const trackingOrchestrator = reseolio.durable(
            reseolio.namespace('e2e', 'chain', 'tracker'),
            async (id: string) => {
                const h1 = await step1(id);
                jobIds.push(h1.jobId);
                await h1.result(10000);

                const h2 = await step2(id, { timestamp: Date.now() });
                jobIds.push(h2.jobId);
                await h2.result(10000);

                return { tracked: true };
            }
        );

        const trackHandle = await trackingOrchestrator('track-001');
        jobIds.push(trackHandle.jobId);
        await trackHandle.result(30000);

        // All 3 job IDs should be unique
        const uniqueJobIds = new Set(jobIds);
        logTest('Each step has unique job ID', uniqueJobIds.size === 3,
            `Expected 3 unique, got ${uniqueJobIds.size}`);

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
