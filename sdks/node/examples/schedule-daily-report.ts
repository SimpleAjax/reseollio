/**
 * Schedule Example: Daily Report Generation
 * 
 * This example demonstrates how to schedule a job that runs daily
 * at a specific time with timezone support.
 */

import { Reseolio } from '../src/client';

async function main() {
    const reseolio = new Reseolio({
        storage: 'localhost:50051',
        autoStart: false,
    });

    await reseolio.start();
    console.log('✅ Reseolio connected\n');

    // Define a durable function for report generation
    const generateDailyReport = reseolio.durable(
        'reports:daily-summary',
        async () => {
            console.log('📊 Generating daily report...');

            // Simulate report generation
            const reportData = {
                date: new Date().toISOString(),
                totalOrders: Math.floor(Math.random() * 1000),
                revenue: Math.floor(Math.random() * 50000),
            };

            console.log('Report generated:', reportData);
            return reportData;
        }
    );

    // Schedule the report to run every day at 8 AM New York time
    console.log('📅 Creating daily schedule...');
    const dailyReportSchedule = await generateDailyReport.schedule({
        cron: '0 8 * * *',           // 8 AM every day
        timezone: 'America/New_York', // Eastern Time
    });

    console.log(`✅ Schedule created: ${dailyReportSchedule.id}`);

    // Get schedule details
    const details = await dailyReportSchedule.details();
    console.log('\n📋 Schedule Details:');
    console.log(`  - Name: ${details.name}`);
    console.log(`  - Cron: ${details.cronExpression}`);
    console.log(`  - Timezone: ${details.timezone}`);
    console.log(`  - Status: ${details.status}`);
    console.log(`  - Next run: ${new Date(details.nextRunAt).toLocaleString()}`);

    // Example: Pause the schedule
    console.log('\n⏸️  Pausing schedule...');
    await dailyReportSchedule.pause();
    console.log('Schedule paused');

    // Example: Resume the schedule
    console.log('\n▶️  Resuming schedule...');
    await dailyReportSchedule.resume();
    console.log('Schedule resumed');

    // Example: Update the schedule to run at 9 AM instead
    console.log('\n🔄 Updating schedule to 9 AM...');
    await dailyReportSchedule.update({
        cron: '0 9 * * *',
    });
    console.log('Schedule updated');

    // Get updated next run time
    const nextRun = await dailyReportSchedule.nextRunAt();
    console.log(`  - New next run: ${nextRun.toLocaleString()}`);

    // Clean up
    console.log('\n🗑️  Deleting schedule...');
    await dailyReportSchedule.delete();
    console.log('Schedule deleted');

    await reseolio.stop();
    console.log('\n✅ Done!');
}

main().catch(console.error);
