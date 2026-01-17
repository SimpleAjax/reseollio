/**
 * E2E Test Runner
 * Runs all E2E tests sequentially and reports overall results
 * Run: npx tsx tests/e2e/run-all.ts
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const tests = [
    { file: '01-basic-job-lifecycle.ts', name: 'Basic Job Lifecycle' },
    { file: '02-retry-and-failure-handling.ts', name: 'Retry and Failure Handling' },
    { file: '03-idempotency-deduplication.ts', name: 'Idempotency and Deduplication' },
    { file: '04-function-namespacing.ts', name: 'Function Namespacing' },
    { file: '05-events-and-observability.ts', name: 'Events and Observability' },
    { file: '06-workflow-patterns.ts', name: 'Workflow Patterns' },
    { file: '07-timeout-handling.ts', name: 'Timeout Handling' },
    { file: '08-latency-benchmarks.ts', name: 'Latency Benchmarks' },
    { file: '09-chained-durables.ts', name: 'Chained Durable Functions (Saga)' },
    { file: '10-fanout-parallel.ts', name: 'Fan-Out and Parallel Execution' },
    { file: '11-result-caching.ts', name: 'Result Caching' },
    { file: '12-schedule-lifecycle.ts', name: 'Cron Schedule Lifecycle' },
    { file: '13-schedule-triggering.ts', name: 'Schedule Triggering' },
    { file: '14-schedule-edge-cases.ts', name: 'Schedule Edge Cases' },
];

interface TestResult {
    name: string;
    file: string;
    passed: boolean;
    duration: number;
}

async function runTest(testFile: string, testName: string): Promise<TestResult> {
    const startTime = Date.now();
    const testPath = path.join(__dirname, testFile);

    return new Promise((resolve) => {
        const child = spawn('npx', ['tsx', testPath], {
            cwd: path.join(__dirname, '../..'),
            stdio: 'inherit',
            shell: true,
        });

        child.on('close', (code) => {
            const duration = Date.now() - startTime;
            resolve({
                name: testName,
                file: testFile,
                passed: code === 0,
                duration,
            });
        });

        child.on('error', () => {
            const duration = Date.now() - startTime;
            resolve({
                name: testName,
                file: testFile,
                passed: false,
                duration,
            });
        });
    });
}

async function main() {
    console.log('═'.repeat(60));
    console.log('🧪 RESEOLIO E2E TEST SUITE');
    console.log('═'.repeat(60));
    console.log(`\nRunning ${tests.length} test files...\n`);

    const results: TestResult[] = [];
    const overallStart = Date.now();

    for (const test of tests) {
        console.log('\n' + '─'.repeat(60));
        console.log(`📋 Running: ${test.name}`);
        console.log('─'.repeat(60) + '\n');

        const result = await runTest(test.file, test.name);
        results.push(result);

        // Small delay between tests to allow cleanup
        await new Promise(r => setTimeout(r, 1000));
    }

    const overallDuration = Date.now() - overallStart;

    // Summary
    console.log('\n' + '═'.repeat(60));
    console.log('📊 TEST SUITE SUMMARY');
    console.log('═'.repeat(60));

    const passed = results.filter(r => r.passed);
    const failed = results.filter(r => !r.passed);

    results.forEach(r => {
        const icon = r.passed ? '✅' : '❌';
        const duration = (r.duration / 1000).toFixed(1);
        console.log(`  ${icon} ${r.name} (${duration}s)`);
    });

    console.log('\n' + '─'.repeat(60));
    console.log(`  Total:    ${results.length} test files`);
    console.log(`  Passed:   ${passed.length}`);
    console.log(`  Failed:   ${failed.length}`);
    console.log(`  Duration: ${(overallDuration / 1000).toFixed(1)}s`);
    console.log('─'.repeat(60));

    if (failed.length > 0) {
        console.log('\n❌ SOME TESTS FAILED');
        failed.forEach(f => console.log(`   - ${f.file}`));
        process.exit(1);
    } else {
        console.log('\n🎉 ALL TESTS PASSED!');
        process.exit(0);
    }
}

main().catch(err => {
    console.error('Fatal error in test runner:', err);
    process.exit(1);
});
