
import { Reseolio } from '../../src/client';

// Test function-centric scheduling with arguments
async function main() {
    console.log('--- Starting Function-Centric Scheduling Test ---');

    // 1. Initialize client
    const reseolio = new Reseolio({
        storage: 'localhost:50051',
        autoStart: false,
    });

    try {
        await reseolio.start();

        // 2. Define a durable function that takes arguments
        const uniqueId = Date.now().toString(36);
        const funcName = `greet-scheduled-${uniqueId}`;
        const greet = reseolio.durable(
            funcName,
            async (name: string, greeting: string) => {
                console.log(`[JOB] ${greeting}, ${name}!`);
                return `${greeting}, ${name}!`;
            }
        );

        // 3. Schedule it with arguments using the new API
        console.log('Scheduling greeting directly from function...');
        const scheduleHandle = await greet.schedule(
            { cron: '* * * * * *' },
            // Let's use a "every minute" cron but we'll manually trigger or just wait.
            // For the test, we'll verify the schedule is created with args.

            // Function args:
            'Alice',
            'Hello'
        );

        console.log(`Schedule created with ID: ${scheduleHandle.id}`);

        // 4. Verify schedule details
        const schedule = await scheduleHandle.details();
        console.log('Schedule details:', schedule);

        if (!schedule.args || schedule.args.length !== 2) {
            throw new Error(`Expected 2 args, got ${schedule.args?.length}`);
        }

        if (schedule.args[0] !== 'Alice' || schedule.args[1] !== 'Hello') {
            throw new Error(`Args mismatch. Expected ['Alice', 'Hello'], got ${JSON.stringify(schedule.args)}`);
        }

        console.log('Function-centric scheduling with arguments validated successfully!');

        // Cleanup
        await scheduleHandle.delete();
        console.log('Schedule deleted.');

    } catch (error) {
        console.error('Test failed:', error);
        process.exit(1);
    } finally {
        await reseolio.stop();
    }
}

main();
