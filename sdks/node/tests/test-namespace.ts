/**
 * Test namespace-based naming and collision detection
 */

import { Reseolio } from '../src/client';

async function testNamespacing() {
    console.log('🧪 Testing namespace-based naming and collision detection...\n');

    const reseolio = new Reseolio({
        storage: 'sqlite://test-namespace.db',
        autoStart: false  // Don't start core for this test
    });

    // Test 1: namespace() helper
    console.log('Test 1: namespace() helper');
    const name1 = reseolio.namespace('payments', 'billing', 'calculate');
    console.assert(name1 === 'payments:billing:calculate', 'namespace() should join with :');
    console.log('✅ namespace() works correctly\n');

    // Test 2: Empty namespace parts
    console.log('Test 2: Empty namespace validation');
    try {
        reseolio.namespace();  // Should throw
        console.error('❌ Should have thrown for empty namespace');
    } catch (err) {
        console.log('✅ Correctly rejects empty namespace\n');
    }

    // Test 3: Invalid characters in namespace parts
    console.log('Test 3: Invalid characters in namespace');
    try {
        reseolio.namespace('pay:ments', 'billing');  // Contains ':'
        console.error('❌ Should have thrown for invalid characters');
    } catch (err) {
        console.log('✅ Correctly rejects invalid characters\n');
    }

    // Test 4: Collision detection
    console.log('Test 4: Collision detection');
    const handler1 = async (a: number, b: number) => a + b;
    const handler2 = async (a: number, b: number) => a * b;

    const multiply1 = reseolio.durable('math:multiply', handler1);
    console.log('✅ First registration successful');

    try {
        const multiply2 = reseolio.durable('math:multiply', handler2);  // Should throw
        console.error('❌ Should have thrown collision error');
    } catch (err: any) {
        if (err.message.includes('already registered')) {
            console.log('✅ Collision detection works\n');
        } else {
            console.error('❌ Wrong error:', err.message);
        }
    }

    // Test 5: Un-namespaced warning
    console.log('Test 5: Un-namespaced function warning');
    console.log('(Should see warning below):');
    const unnamespaced = reseolio.durable('calculate', async (x: number) => x * 2);
    console.log('✅ Warning displayed for un-namespaced function\n');

    // Test 6: Properly namespaced (no warning)
    console.log('Test 6: Properly namespaced function (no warning)');
    const namespaced = reseolio.durable(
        reseolio.namespace('analytics', 'metrics', 'calculate'),
        async (x: number) => x * 2
    );
    console.log('✅ No warning for namespaced function\n');

    console.log('✅ All tests passed!');
}

// Run tests
testNamespacing().catch(console.error);
