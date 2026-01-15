/**
 * E2E Test 05: Events and Observability
 * Prerequisites: Run reseolio-core first
 * Run: npx tsx tests/e2e/05-events-and-observability.ts
 */

import { Reseolio } from '../../src/client';

interface EventLog {
    type: 'start' | 'success' | 'error';
    jobId: string;
    name: string;
    attempt: number;
    timestamp: number;
}

const results: { name: string; passed: boolean; error?: string }[] = [];
const eventLogs: EventLog[] = [];

function logTest(name: string, passed: boolean, error?: string) {
    results.push({ name, passed, error });
    console.log(passed ? `  ✅ ${name}` : `  ❌ ${name}: ${error}`);
}

async function runTests() {
    console.log('🧪 E2E Test 05: Events and Observability\n');

    const reseolio = new Reseolio({
        storage: 'localhost:50051',
        autoStart: false,
    });

    reseolio.on('job:start', (job) => {
        eventLogs.push({ type: 'start', jobId: job.id, name: job.name, attempt: job.attempt, timestamp: Date.now() });
    });
    reseolio.on('job:success', (job) => {
        eventLogs.push({ type: 'success', jobId: job.id, name: job.name, attempt: job.attempt, timestamp: Date.now() });
    });
    reseolio.on('job:error', (job) => {
        eventLogs.push({ type: 'error', jobId: job.id, name: job.name, attempt: job.attempt, timestamp: Date.now() });
    });

    try {
        await reseolio.start();

        // TEST 1: Success events
        eventLogs.length = 0;
        const successJob = reseolio.durable('e2e:test05:success', async () => ({ ok: true }));
        await (await successJob()).result(5000);
        await new Promise(r => setTimeout(r, 200));

        logTest('Start event fired', eventLogs.some(e => e.type === 'start'));
        logTest('Success event fired', eventLogs.some(e => e.type === 'success'));

        // TEST 2: Error events
        eventLogs.length = 0;
        const failJob = reseolio.durable('e2e:test05:fail', async () => { throw new Error('fail'); }, { maxAttempts: 1 });
        try { await (await failJob()).result(5000); } catch { }
        await new Promise(r => setTimeout(r, 200));

        logTest('Error event fired', eventLogs.some(e => e.type === 'error'));

        // Summary
        const passed = results.filter(r => r.passed).length;
        console.log(`\n📊 Passed: ${passed}/${results.length}`);

        await reseolio.stop();
        process.exit(results.every(r => r.passed) ? 0 : 1);
    } catch (error) {
        console.error('❌ Fatal error:', error);
        await reseolio.stop().catch(() => { });
        process.exit(1);
    }
}

runTests();
