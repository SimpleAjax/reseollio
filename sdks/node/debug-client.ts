/**
 * Debug Script for Reseolio Client
 * 
 * Run this with the debugger to step through client execution:
 * 
 * In VS Code:
 * 1. Set breakpoints in client.ts where you want to pause
 * 2. Press F5 and select "Debug Current File"
 * 
 * Or from command line:
 * node --inspect-brk --loader tsx sdks/node/debug-client.ts
 */

import { Reseolio } from './dist/client.js';

async function debugClient() {
    console.log('🔍 Starting debug session...\n');

    // Create client instance
    const client = new Reseolio({
        storage: 'sqlite://./debug-reseolio.db',
        address: '127.0.0.1:50051',
        workerConcurrency: 5
    });

    // Set up event listeners to see what's happening
    client.on('ready', () => {
        console.log('✅ Client is ready!');
    });

    client.on('core:stdout', (data) => {
        console.log('📤 [Core Output]:', data.trim());
    });

    client.on('core:stderr', (data) => {
        console.error('⚠️ [Core Error]:', data.trim());
    });

    client.on('core:error', (err) => {
        console.error('❌ [Core Process Error]:', err);
    });

    client.on('core:exit', (code) => {
        console.log(`🛑 Core process exited with code: ${code}`);
    });

    client.on('job:start', (job) => {
        console.log(`🚀 [Job Started] ID: ${job.id}, Name: ${job.name}`);
    });

    client.on('job:success', (job, result) => {
        console.log(`✅ [Job Success] ID: ${job.id}, Result:`, result);
    });

    client.on('job:error', (job, error) => {
        console.error(`❌ [Job Error] ID: ${job.id}, Error:`, error);
    });

    client.on('worker:error', (error) => {
        console.error('⚠️ [Worker Error]:', error);
    });

    try {
        // ============================================
        // STEP 1: Start the client
        // ============================================
        console.log('\n📍 STEP 1: Starting client...');
        await client.start();
        console.log('✅ Client started successfully\n');

        // ============================================
        // STEP 2: Define a durable function
        // ============================================
        console.log('📍 STEP 2: Defining durable function...');
        const multiplyNumbers = client.durable<[number, number], number>(
            'multiply',
            async (a, b) => {
                console.log(`  🔢 Executing multiply(${a}, ${b})`);
                await new Promise(r => setTimeout(r, 100)); // Simulate some work
                const result = a * b;
                console.log(`  ✅ Result: ${result}`);
                return result;
            },
            {
                maxAttempts: 3,
                timeoutMs: 5000
            }
        );
        console.log('✅ Function registered: multiply\n');

        // ============================================
        // STEP 3: Enqueue a job
        // ============================================
        console.log('📍 STEP 3: Enqueuing job...');
        const handle = await multiplyNumbers(6, 7);
        console.log(`✅ Job enqueued with ID: ${handle.jobId}\n`);

        // ============================================
        // STEP 4: Wait for result
        // ============================================
        console.log('📍 STEP 4: Waiting for job result...');
        const result = await handle.wait();
        console.log(`✅ Final result: ${result}\n`);

        // ============================================
        // STEP 5: Check job status
        // ============================================
        console.log('📍 STEP 5: Checking job status...');
        const jobInfo = await client.getJob(handle.jobId);
        console.log('Job details:', {
            id: jobInfo.id,
            name: jobInfo.name,
            status: jobInfo.status,
            attempt: jobInfo.attempt,
            maxAttempts: jobInfo.maxAttempts
        });
        console.log('\n');

        // ============================================
        // STEP 6: Test multiple jobs concurrently
        // ============================================
        console.log('📍 STEP 6: Testing concurrent jobs...');
        const handles = await Promise.all([
            multiplyNumbers(2, 3),
            multiplyNumbers(4, 5),
            multiplyNumbers(10, 20)
        ]);
        console.log(`✅ Enqueued ${handles.length} concurrent jobs\n`);

        console.log('📍 Waiting for all results...');
        const results = await Promise.all(handles.map(h => h.wait()));
        console.log('✅ All results:', results);
        console.log('\n');

        // ============================================
        // STEP 7: Test error handling
        // ============================================
        console.log('📍 STEP 7: Testing error handling...');
        const errorFunc = client.durable<[string], void>(
            'errorTest',
            async (msg) => {
                console.log(`  ⚠️ About to throw error: "${msg}"`);
                throw new Error(msg);
            }
        );

        try {
            const errorHandle = await errorFunc('Test error message');
            await errorHandle.wait();
        } catch (error) {
            console.log('✅ Error caught as expected:', (error as Error).message);
        }
        console.log('\n');

        // ============================================
        // STEP 8: Cleanup
        // ============================================
        console.log('📍 STEP 8: Stopping client...');
        await client.stop();
        console.log('✅ Client stopped successfully\n');

        console.log('🎉 Debug session complete!\n');

    } catch (error) {
        console.error('\n❌ Error during debug session:', error);
        process.exit(1);
    }
}

// Run the debug session
debugClient().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
