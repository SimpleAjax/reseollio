/**
 * LOAD TEST 7: Chained Workflows
 * 
 * Tests: Multi-step workflow performance at scale
 * Scenario: Each job triggers sequential child jobs (saga pattern)
 * Validates: Chain overhead, end-to-end latency, no deadlocks
 */

import './preload-tracing';
import { Reseolio } from '../../dist/index.js';

async function main() {
    const NUM_WORKFLOWS = 100;  // Number of concurrent workflows
    const CHAIN_LENGTH = 3;     // Steps per workflow
    const STEP_DURATION_MS = 20;

    console.log(`\n========================================`);
    console.log(`LOAD TEST: Chained Workflows`);
    console.log(`========================================`);
    console.log(`Concurrent workflows: ${NUM_WORKFLOWS}`);
    console.log(`Chain length:         ${CHAIN_LENGTH} steps`);
    console.log(`Step duration:        ${STEP_DURATION_MS}ms`);
    console.log(`Total jobs:           ${NUM_WORKFLOWS * (CHAIN_LENGTH + 1)} (orchestrators + steps)\n`);

    const reseolio = new Reseolio({
        storage: process.env.RESEOLIO_DB || 'sqlite://./load-test-chain.db',
        autoStart: false,
        // IMPORTANT: Concurrency must be high enough for orchestrators + child jobs.
        // If all worker slots are taken by orchestrators waiting for children,
        // children can't run -> deadlock.
        // Rule: concurrency >= max_concurrent_orchestrators + max_concurrent_children
        // Here: 100 orchestrators, each needs 1-3 child slots -> need ~200+ concurrency
        workerConcurrency: 250
    });

    // Metrics
    let orchestratorsCompleted = 0;
    let stepsCompleted = 0;
    let failures = 0;
    const workflowLatencies: number[] = [];
    const stepLatencies: number[] = [];
    const startTimes = new Map<string, number>();

    reseolio.on('job:start', (job) => {
        startTimes.set(job.id, Date.now());
    });

    reseolio.on('job:success', (job) => {
        const latency = Date.now() - (startTimes.get(job.id) || 0);
        if (job.name.includes('orchestrator')) {
            orchestratorsCompleted++;
            workflowLatencies.push(latency);
            if (orchestratorsCompleted % 10 === 0) {
                console.log(`  [WORKFLOW] Completed: ${orchestratorsCompleted}/${NUM_WORKFLOWS}`);
            }
        } else {
            stepsCompleted++;
            stepLatencies.push(latency);
        }
    });

    reseolio.on('job:error', () => {
        failures++;
    });

    try {
        await reseolio.start();

        // Define step jobs
        const step1 = reseolio.durable(
            'workflow:step1',
            async (workflowId: string) => {
                await new Promise(r => setTimeout(r, STEP_DURATION_MS));
                return { workflowId, step: 1, timestamp: Date.now() };
            }
        );

        const step2 = reseolio.durable(
            'workflow:step2',
            async (workflowId: string, step1Result: { timestamp: number }) => {
                await new Promise(r => setTimeout(r, STEP_DURATION_MS));
                return { workflowId, step: 2, prevTimestamp: step1Result.timestamp, timestamp: Date.now() };
            }
        );

        const step3 = reseolio.durable(
            'workflow:step3',
            async (workflowId: string, step2Result: { timestamp: number }) => {
                await new Promise(r => setTimeout(r, STEP_DURATION_MS));
                return { workflowId, step: 3, prevTimestamp: step2Result.timestamp, timestamp: Date.now() };
            }
        );

        // Orchestrator that chains them
        const runWorkflow = reseolio.durable(
            'workflow:orchestrator',
            async (workflowId: string) => {
                // Step 1
                const h1 = await step1(workflowId);
                const r1 = await h1.result(30000);

                // Step 2
                const h2 = await step2(workflowId, r1);
                const r2 = await h2.result(30000);

                // Step 3
                const h3 = await step3(workflowId, r2);
                const r3 = await h3.result(30000);

                return {
                    workflowId,
                    completed: true,
                    steps: [r1.timestamp, r2.timestamp, r3.timestamp],
                };
            },
            { timeoutMs: 120000 }  // 2 minute timeout for full workflow
        );

        // Start all workflows concurrently
        // Use unique run ID to avoid interference from previous runs
        const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        console.log(`=> Starting ${NUM_WORKFLOWS} workflows (run: ${runId})...`);
        const testStart = Date.now();

        const workflowHandles = await Promise.all(
            Array.from({ length: NUM_WORKFLOWS }, (_, i) => runWorkflow(`wf-${runId}-${i}`))
        );

        const enqueueTime = Date.now() - testStart;
        console.log(`  All workflows enqueued in ${enqueueTime}ms`);

        // Wait for all to complete
        console.log(`\n=> Waiting for workflow completion...`);
        const processStart = Date.now();

        const results = await Promise.all(workflowHandles.map(h => h.result(180000)));

        const processTime = Date.now() - processStart;
        const totalTime = Date.now() - testStart;

        // Calculate metrics
        const avgWorkflowLatency = workflowLatencies.length > 0
            ? workflowLatencies.reduce((a, b) => a + b, 0) / workflowLatencies.length
            : 0;
        const avgStepLatency = stepLatencies.length > 0
            ? stepLatencies.reduce((a, b) => a + b, 0) / stepLatencies.length
            : 0;

        const sortedWorkflow = workflowLatencies.sort((a, b) => a - b);
        const p50Workflow = sortedWorkflow[Math.floor(sortedWorkflow.length * 0.5)] || 0;
        const p95Workflow = sortedWorkflow[Math.floor(sortedWorkflow.length * 0.95)] || 0;

        const sortedStep = stepLatencies.sort((a, b) => a - b);
        const p50Step = sortedStep[Math.floor(sortedStep.length * 0.5)] || 0;
        const p95Step = sortedStep[Math.floor(sortedStep.length * 0.95)] || 0;

        // Verify workflow correctness
        const correctResults = results.filter(r =>
            r.completed && r.steps.length === 3 && r.steps[2] > r.steps[1] && r.steps[1] > r.steps[0]
        ).length;

        // Report
        console.log(`\n========================================`);
        console.log(`RESULTS`);
        console.log(`========================================`);
        console.log(`Workflows:`);
        console.log(`  Completed:        ${orchestratorsCompleted}/${NUM_WORKFLOWS}`);
        console.log(`  Correct order:    ${correctResults}/${NUM_WORKFLOWS}`);
        console.log(`\nSteps:`);
        console.log(`  Completed:        ${stepsCompleted}/${NUM_WORKFLOWS * CHAIN_LENGTH}`);
        console.log(`  Failures:         ${failures}`);
        console.log(`\nWorkflow Latency (ms):`);
        console.log(`  Average:          ${avgWorkflowLatency.toFixed(2)}`);
        console.log(`  p50:              ${p50Workflow}`);
        console.log(`  p95:              ${p95Workflow}`);
        console.log(`\nStep Latency (ms):`);
        console.log(`  Average:          ${avgStepLatency.toFixed(2)}`);
        console.log(`  p50:              ${p50Step}`);
        console.log(`  p95:              ${p95Step}`);
        console.log(`\nTiming:`);
        console.log(`  Enqueue Time:     ${enqueueTime}ms`);
        console.log(`  Process Time:     ${processTime}ms`);
        console.log(`  Total Time:       ${totalTime}ms`);
        console.log(`\nOverhead Analysis:`);
        const theoreticalMin = CHAIN_LENGTH * STEP_DURATION_MS;
        const actualOverhead = avgWorkflowLatency - theoreticalMin;
        console.log(`  Theoretical min:  ${theoreticalMin}ms (${CHAIN_LENGTH} steps × ${STEP_DURATION_MS}ms)`);
        console.log(`  Actual average:   ${avgWorkflowLatency.toFixed(2)}ms`);
        console.log(`  Chain overhead:   ${actualOverhead.toFixed(2)}ms`);
        console.log(`========================================\n`);

        // Success criteria
        const allComplete = orchestratorsCompleted === NUM_WORKFLOWS;
        const allStepsComplete = stepsCompleted === NUM_WORKFLOWS * CHAIN_LENGTH;
        const noFailures = failures === 0;
        const allCorrect = correctResults === NUM_WORKFLOWS;

        const passed = allComplete && allStepsComplete && noFailures && allCorrect;

        if (passed) {
            console.log(`[PASS] TEST PASSED`);
            console.log(`  - All workflows completed`);
            console.log(`  - All steps completed in order`);
            console.log(`  - No failures\n`);
        } else {
            console.log(`[FAIL] TEST FAILED`);
            if (!allComplete) console.log(`  - Workflows incomplete: ${orchestratorsCompleted}/${NUM_WORKFLOWS}`);
            if (!allStepsComplete) console.log(`  - Steps incomplete: ${stepsCompleted}/${NUM_WORKFLOWS * CHAIN_LENGTH}`);
            if (!noFailures) console.log(`  - Failures occurred: ${failures}`);
            if (!allCorrect) console.log(`  - Incorrect ordering: ${NUM_WORKFLOWS - correctResults} workflows`);
            console.log();
        }

        await reseolio.stop();
        process.exit(passed ? 0 : 1);

    } catch (error) {
        console.error('\n[FATAL] Error:', error);
        await reseolio.stop().catch(() => { });
        process.exit(1);
    }
}

main();
