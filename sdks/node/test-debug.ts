import { Reseolio } from './src/client.js';

console.log('🔍 Starting debug session...\n');

const client = new Reseolio({
    storage: 'postgres://user:password@postgres:5433/reseolio',
    address: '127.0.0.1:50051',  // gRPC server port (9230 is debug port!)
    workerConcurrency: 5,
    autoStart: false  // Don't start core - connect to existing server
});

// Event listeners to see what's happening
client.on('ready', () => console.log('✅ Client is ready!'));
client.on('core:stdout', (data: any) => console.log('📤 Core:', data.trim()));
client.on('job:start', (job: any) => console.log(`🚀 Job started: ${job.id} (${job.name})`));
client.on('job:success', (job: any, result: any) => console.log(`✅ Job ${job.id} succeeded:`, result));
client.on('job:error', (job: any, error: any) => console.error(`❌ Job ${job.id} failed:`, error));

try {
    // Start the client
    console.log('📍 Step 1: Starting client...');
    await client.start();
    console.log('✅ Client started\n');

    // Define a durable function  
    console.log('📍 Step 2: Defining function...');
    const multiply = client.durable('multiply', async (a: number, b: number) => {
        console.log(`  🔢 Executing: ${a} * ${b}`);
        await new Promise(r => setTimeout(r, 100));
        return a * b;
    });
    console.log('✅ Function registered\n');

    // Enqueue a job
    console.log('📍 Step 3: Enqueuing job...');
    const handle = await multiply(6, 7);
    console.log(`✅ Job enqueued: ${handle.jobId}\n`);

    // Wait for result
    console.log('📍 Step 4: Waiting for result...');
    const result = await handle.result();
    console.log(`✅ Result: ${result}\n`);

    // Check status
    const jobInfo = await client.getJob(handle.jobId);
    console.log('📊 Job details:', {
        id: jobInfo.id,
        name: jobInfo.name,
        status: jobInfo.status,
        attempt: jobInfo.attempt
    });

    console.log('\n📍 Step 5: Stopping client...');
    await client.stop();
    console.log('✅ Client stopped\n');

    console.log('🎉 Debug session complete!');

} catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
}
