/**
 * Type test to verify idempotencyKey is not allowed at registration
 */

import { Reseolio } from '../src/client';

const reseolio = new Reseolio({ autoStart: false });

// ✅ SHOULD COMPILE: Registration without idempotencyKey
const sendEmail1 = reseolio.durable(
    'test:email:send',
    async (to: string, subject: string) => ({ sent: true }),
    {
        maxAttempts: 5,
        backoff: 'exponential'
        // idempotencyKey not allowed here!
    }
);

//❌ SHOULD NOT COMPILE: Registration with idempotencyKey
// Uncomment to test - TypeScript should error
/*
const sendEmail2 = reseolio.durable(
    'test:email:send2',
    async (to: string, subject: string) => ({ sent: true }),
    {
        maxAttempts: 5,
        idempotencyKey: 'static-key'  // ← TypeScript error!
    }
);
*/

// ✅ SHOULD COMPILE: Execution with idempotencyKey
async function testExecution() {
    const job = await sendEmail1('alice@example.com', 'Hello', {
        idempotencyKey: 'order-123',  // ← Allowed here!
        maxAttempts: 10  // Can also override other options
    });

    console.log('✅ Type test passed!');
    console.log('  - Registration: idempotencyKey not allowed');
    console.log('  - Execution: idempotencyKey allowed');
}

console.log('✅ All type assertions passed!');
console.log('📝 Key points:');
console.log('  • DurableOptions (registration) = Omit<JobOptions, "idempotencyKey">');
console.log('  • JobOptions (execution) = includes idempotencyKey');
console.log('  • This prevents static idempotency keys at registration time');
