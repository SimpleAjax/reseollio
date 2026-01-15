/**
 * E2E Test 07: Timeout and Deadline Handling
 * Tests job timeouts, long-running jobs, and deadline enforcement
 * Run: npx tsx tests/e2e/07-timeout-handling.ts
 */

import { Reseolio } from '../../src/client';

const results: { name: string; passed: boolean; error?: string }[] = [];

function logTest(name: string, passed: boolean, error?: string) {
    results.push({ name, passed, error });
    console.log(passed ? `  ✅ ${name}` : `  ❌ ${name}: ${error}`);
}

async function runTests() {
    console.log('🧪 E2E Test 07: Timeout and Deadline Handling\n');

    const reseolio = new Reseolio({
        storage: 'localhost:50051',
        autoStart: false,
    });

    try {
        await reseolio.start();
        console.log('✅ Connected to Reseolio\n');

        // ========== TEST 1: Quick Job Completes Before Timeout ==========
        console.log('Test 1: Quick job completes before timeout');
        console.log('-'.repeat(40));

        const quickJob = reseolio.durable('timeout:quick',
            async () => {
                await new Promise(r => setTimeout(r, 100));
                return { completed: true };
            },
            { timeoutMs: 5000 }
        );

        const quickHandle = await quickJob();
        const quickResult = await quickHandle.result(10000);
        logTest('Quick job completes successfully', quickResult.completed === true);

        // ========== TEST 2: Result Wait Timeout ==========
        console.log('\nTest 2: Result wait timeout');
        console.log('-'.repeat(40));

        const slowJob = reseolio.durable('timeout:slow',
            async () => {
                await new Promise(r => setTimeout(r, 10000)); // 10 seconds
                return { completed: true };
            }
        );

        const slowHandle = await slowJob();
        const startTime = Date.now();

        try {
            // Wait only 1 second for a 10-second job
            await slowHandle.result(1000);
            logTest('Timeout should have thrown', false);
        } catch (error: any) {
            const elapsed = Date.now() - startTime;
            console.log(`    Timed out after ${elapsed}ms`);
            logTest('Result wait timed out correctly', elapsed < 3000);
        }

        // ========== TEST 3: Job with Custom Timeout ==========
        console.log('\nTest 3: Job with custom timeout option');
        console.log('-'.repeat(40));

        const customTimeoutJob = reseolio.durable('timeout:custom',
            async (duration: number) => {
                await new Promise(r => setTimeout(r, duration));
                return { duration, completed: true };
            },
            { timeoutMs: 30000, maxAttempts: 1 }
        );

        // Should complete within timeout
        const customHandle = await customTimeoutJob(100);
        const customResult = await customHandle.result(5000);
        logTest('Job with custom timeout works', customResult.completed === true);

        // ========== TEST 4: Multiple Concurrent with Different Timeouts ==========
        console.log('\nTest 4: Concurrent jobs with varying durations');
        console.log('-'.repeat(40));

        const handles = await Promise.all([
            customTimeoutJob(50),
            customTimeoutJob(100),
            customTimeoutJob(150),
            customTimeoutJob(200),
        ]);

        const allResults = await Promise.all(handles.map(h => h.result(5000)));
        const allCompleted = allResults.every(r => r.completed === true);
        console.log(`    All ${allResults.length} jobs completed`);
        logTest('All concurrent jobs completed', allCompleted);

        // ========== SUMMARY ==========
        console.log('\n' + '='.repeat(50));
        const passed = results.filter(r => r.passed).length;
        console.log(`📊 Passed: ${passed}/${results.length}`);

        await reseolio.stop();
        process.exit(results.every(r => r.passed) ? 0 : 1);

    } catch (error) {
        console.error('❌ Fatal error:', error);
        await reseolio.stop().catch(() => { });
        process.exit(1);
    }
}

runTests();
