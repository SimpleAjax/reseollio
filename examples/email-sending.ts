/**
 * Example: Email sending with durable execution
 * 
 * This example shows how to use Reseolio to ensure emails
 * are sent even if the server crashes during execution.
 */

import { Reseolio } from '../sdks/node/src';

// Mock email provider
const emailProvider = {
    async send(to: string, body: string): Promise<void> {
        console.log(`📧 Sending email to ${to}: ${body}`);

        // Simulate occasional failures
        if (Math.random() < 0.3) {
            throw new Error('Email provider temporarily unavailable');
        }

        // Simulate network delay
        await new Promise(r => setTimeout(r, 1000));
        console.log(`✅ Email sent to ${to}`);
    }
};

async function main() {
    // Initialize Reseolio
    const reseolio = new Reseolio({
        storage: 'sqlite://./example.db',
        autoStart: true,
    });

    // Start the client (spawns core process)
    await reseolio.start();
    console.log('🚀 Reseolio started');

    // Define a durable email sending function
    const sendEmail = reseolio.durable(
        'send-email',
        async (to: string, subject: string, body: string) => {
            await emailProvider.send(to, `${subject}\n\n${body}`);
            return { sent: true, to, timestamp: Date.now() };
        },
        {
            maxAttempts: 5,
            backoff: 'exponential',
            initialDelayMs: 1000,
            timeoutMs: 10000,
        }
    );

    // Send some emails
    console.log('\n📬 Queueing emails...\n');

    const jobs = await Promise.all([
        sendEmail('alice@example.com', 'Welcome!', 'Thanks for signing up.'),
        sendEmail('bob@example.com', 'Order Confirmed', 'Your order #123 is confirmed.'),
        sendEmail('carol@example.com', 'Password Reset', 'Click here to reset your password.'),
    ]);

    console.log(`\n📋 Queued ${jobs.length} jobs:`);
    for (const job of jobs) {
        console.log(`  - Job ${job.jobId}`);
    }

    // Wait for all jobs to complete
    console.log('\n⏳ Waiting for jobs to complete...\n');

    const results = await Promise.allSettled(
        jobs.map(job => job.result())
    );

    console.log('\n📊 Results:');
    for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === 'fulfilled') {
            console.log(`  ✅ Job ${jobs[i].jobId}: ${JSON.stringify(result.value)}`);
        } else {
            console.log(`  ❌ Job ${jobs[i].jobId}: ${result.reason}`);
        }
    }

    // Cleanup
    await reseolio.stop();
    console.log('\n👋 Reseolio stopped');
}

main().catch(console.error);
