/**
 * Load Test Runner
 * Runs all load tests sequentially and reports overall results
 * Run: npx tsx tests/load/run-all.ts
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const tests = [
    { file: '01-throughput.ts', name: 'Basic Throughput' },
    { file: '02-multi-worker.ts', name: 'Multi-Worker Concurrency' },
    { file: '03-retry-storm.ts', name: 'Retry Storm' },
    { file: '04-idempotency-stress.ts', name: 'Idempotency Stress' },
    { file: '05-long-running-jobs.ts', name: 'Long-Running Jobs' },
    { file: '06-burst-traffic.ts', name: 'Burst Traffic' },
    { file: '07-chained-workflows.ts', name: 'Chained Workflows' },
    { file: '08-schedule-throughput.ts', name: 'Schedule Throughput' },
    { file: '09-schedule-triggering.ts', name: 'Schedule Triggering' },
    { file: '10-schedule-idempotency.ts', name: 'Schedule Idempotency' },
    { file: '11-schedule-updates.ts', name: 'Schedule Updates' },
    { file: '12-schedule-mixed-workload.ts', name: 'Schedule Mixed Workload' },
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
    console.log('🚀 RESEOLIO LOAD TEST SUITE');
    console.log('═'.repeat(60));
    console.log(`\nRunning ${tests.length} load tests...\n`);

    const results: TestResult[] = [];
    const overallStart = Date.now();

    for (const test of tests) {
        console.log('\n' + '─'.repeat(60));
        console.log(`📋 Running: ${test.name}`);
        console.log('─'.repeat(60) + '\n');

        const result = await runTest(test.file, test.name);
        results.push(result);

        // Small delay between tests to allow cleanup
        await new Promise(r => setTimeout(r, 2000));
    }

    const overallDuration = Date.now() - overallStart;

    // Summary
    console.log('\n' + '═'.repeat(60));
    console.log('📊 LOAD TEST SUITE SUMMARY');
    console.log('═'.repeat(60));

    const passed = results.filter(r => r.passed);
    const failed = results.filter(r => !r.passed);

    results.forEach(r => {
        const icon = r.passed ? '✅' : '❌';
        const duration = (r.duration / 1000).toFixed(1);
        console.log(`  ${icon} ${r.name} (${duration}s)`);
    });

    console.log('\n' + '─'.repeat(60));
    console.log(`  Total:    ${results.length} load tests`);
    console.log(`  Passed:   ${passed.length}`);
    console.log(`  Failed:   ${failed.length}`);
    console.log(`  Duration: ${(overallDuration / 1000).toFixed(1)}s`);
    console.log('─'.repeat(60));

    if (failed.length > 0) {
        console.log('\n❌ SOME LOAD TESTS FAILED');
        failed.forEach(f => console.log(`   - ${f.file}`));
        process.exit(1);
    } else {
        console.log('\n🎉 ALL LOAD TESTS PASSED!');
        process.exit(0);
    }
}

main().catch(err => {
    console.error('Fatal error in test runner:', err);
    process.exit(1);
});
