import { Reseolio } from '../src';

/**
 * Complex Scheduling Patterns Example
 * 
 * Demonstrates how to achieve complex scheduling requirements that go beyond
 * standard single-pattern cron expressions, such as:
 * 1. Multiple disjoint schedules for the same logic (e.g. Mon at 6am AND Tue at 7am)
 * 2. Application-side filtering (e.g. "Every alternating Wednesday")
 * 
 * Usage: npx tsx examples/schedule-complex-patterns.ts
 */

const reseolio = new Reseolio({
    storage: 'sqlite://./reseolio.db', // Use your local DB
    autoStart: false,
});

async function main() {
    await reseolio.start();
    console.log('✅ Reseolio started\n');

    // =========================================================================
    // Core Business Logic
    // =========================================================================
    // This is the shared function that does the actual work.
    async function generateReport(scheduleName: string) {
        console.log(`[JOB] 📊 Generating report... (Triggered by: ${scheduleName})`);

        // Simulate work
        await new Promise(resolve => setTimeout(resolve, 1000));

        console.log(`[JOB] ✅ Report generated for ${scheduleName}`);
        return { generated: true, source: scheduleName };
    }

    // =========================================================================
    // Pattern 1 & 2: Disjoint Schedules (Monday & Tuesday)
    // =========================================================================
    // Since Reseolio maps Schedule Name 1:1 to Function Name, we use "Handler Aliasing".
    // We register the SAME function under multiple different names.

    // Schedule 1: Every Monday at 6:00 AM
    await reseolio.durable(
        'report-gen-monday',
        () => generateReport('Monday Morning')
    ).schedule({ cron: '0 6 * * 1' });
    console.log('📅 Scheduled: Monday at 6:00 AM');

    // Schedule 2: Every Tuesday at 7:00 AM
    await reseolio.durable(
        'report-gen-tuesday',
        () => generateReport('Tuesday Morning')
    ).schedule({ cron: '0 7 * * 2' });
    console.log('📅 Scheduled: Tuesday at 7:00 AM');


    // =========================================================================
    // Pattern 3: Application-Side Filtering (Alternative Wednesdays)
    // =========================================================================
    // Cron does not support "every 2 weeks".
    // Strategy: Schedule for EVERY Wednesday, but skip execution in the handler if it's the wrong week.

    await reseolio.durable(
        'report-gen-wed-alt',
        async () => {
            // 1. Check constraints
            if (!isAlternateWeek()) {
                console.log('[JOB] ⏭️ Skipping execution (Not the target week)');

                // Return early - job succeeds but does nothing
                return { skipped: true };
            }

            // 2. Run core logic
            return await generateReport('Generic Wednesday');
        }
    ).schedule({ cron: '0 21 * * 3' }); // Every Wednesday at 9:00 PM
    console.log('📅 Scheduled: Alternate Wednesdays at 9:00 PM');


    // =========================================================================
    // Verification
    // =========================================================================
    console.log('\nVerify schedules:');
    const schedules = await reseolio.listSchedules();
    schedules.schedules.forEach(s => {
        if (s.name.startsWith('report-gen')) {
            console.log(`- ${s.name.padEnd(20)} | Cron: ${s.cronExpression} | Next: ${new Date(s.nextRunAt).toLocaleString()}`);
        }
    });

    console.log('\nPress Ctrl+C to exit. Listening for triggers...');
}

// Helper: Determine if current week is even/odd
function isAlternateWeek(): boolean {
    const now = new Date();
    // Simple week number calculation
    const oneJan = new Date(now.getFullYear(), 0, 1);
    const numberOfDays = Math.floor((now.getTime() - oneJan.getTime()) / (24 * 60 * 60 * 1000));
    const weekNumber = Math.ceil((now.getDay() + 1 + numberOfDays) / 7);

    // Change to (weekNumber % 2 !== 0) to swap weeks
    return weekNumber % 2 === 0;
}

main().catch(console.error);
