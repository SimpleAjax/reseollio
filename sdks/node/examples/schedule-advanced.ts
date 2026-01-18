/**
 * Schedule Example: Advanced Patterns
 * 
 * This example demonstrates advanced scheduling patterns including:
 * - Multiple timezones
 * - Complex cron expressions
 * - Schedule management and monitoring
 */

import { Reseolio } from '../src/client';

async function main() {
    const reseolio = new Reseolio({
        storage: 'localhost:50051',
        autoStart: false,
    });

    await reseolio.start();
    console.log('✅ Reseolio connected\n');

    // Define handlers
    const sendReminder = reseolio.durable('notifications:reminder', async (timezone: string) => {
        console.log(`📧 Sending reminder in ${timezone} timezone`);
        return { sent: true, timezone, timestamp: Date.now() };
    });

    const processPayroll = reseolio.durable('payroll:process', async () => {
        console.log('💰 Processing payroll...');
        return { processed: true, timestamp: Date.now() };
    });

    const healthCheck = reseolio.durable('system:health-check', async () => {
        console.log('🏥 Running health check...');
        return { healthy: true, timestamp: Date.now() };
    });

    // Example 1: Business hours only (9 AM - 5 PM, weekdays)
    console.log('📅 Schedule 1: Business hours only');
    const businessHoursSchedule = await sendReminder.schedule({
        cron: '0 9-17 * * 1-5', // Every hour from 9 AM to 5 PM, Monday-Friday
        timezone: 'America/New_York',
    }, 'America/New_York');
    console.log(`  ✅ Created: ${businessHoursSchedule.id}`);
    console.log(`  Next run: ${(await businessHoursSchedule.nextRunAt()).toLocaleString()}\n`);

    // Example 2: First day of every month at midnight
    console.log('📅 Schedule 2: Monthly payroll (1st of month)');
    const monthlySchedule = await processPayroll.schedule({
        cron: '0 0 1 * *', // Midnight on the 1st of every month
        timezone: 'UTC',
    });
    console.log(`  ✅ Created: ${monthlySchedule.id}`);
    console.log(`  Next run: ${(await monthlySchedule.nextRunAt()).toLocaleString()}\n`);

    // Example 3: Every 15 minutes
    console.log('📅 Schedule 3: High-frequency health checks');
    const frequentSchedule = await healthCheck.schedule({
        cron: '*/15 * * * *', // Every 15 minutes
        timezone: 'UTC',
    });
    console.log(`  ✅ Created: ${frequentSchedule.id}`);
    console.log(`  Next run: ${(await frequentSchedule.nextRunAt()).toLocaleString()}\n`);

    // Example 4: Multiple timezone schedules
    const timezones = ['America/New_York', 'Europe/London', 'Asia/Tokyo'];
    const regionalSchedules = [];

    console.log('📅 Schedule 4: Regional notifications (9 AM in each timezone)');
    for (const tz of timezones) {
        // Create an alias handler for this region (implicit logic: different schedule name needs different handler name)
        const regionalHandler = reseolio.durable(`notifications:reminder:${tz}`, async () => {
            console.log(`📧 Sending regional reminder for ${tz}`);
            return { sent: true, timezone: tz };
        });

        const schedule = await regionalHandler.schedule({
            cron: '0 9 * * *', // 9 AM daily
            timezone: tz,
        });
        regionalSchedules.push(schedule);
        console.log(`  ✅ Created for ${tz}: ${schedule.id}`);
    }
    console.log();

    // Monitor schedule status
    console.log('📊 Schedule Status Report:');
    const allSchedules = await reseolio.listSchedules();

    console.log(`\n  Total schedules: ${allSchedules.total}`);
    console.log('  Active schedules:');

    for (const schedule of allSchedules.schedules) {
        const nextRun = schedule.nextRunAt
            ? new Date(schedule.nextRunAt).toLocaleString()
            : 'N/A';
        const lastRun = schedule.lastRunAt
            ? new Date(schedule.lastRunAt).toLocaleString()
            : 'Never';

        console.log(`\n    📋 ${schedule.name}`);
        console.log(`       Status: ${schedule.status}`);
        console.log(`       Cron: ${schedule.cronExpression}`);
        console.log(`       Timezone: ${schedule.timezone}`);
        console.log(`       Next run: ${nextRun}`);
        console.log(`       Last run: ${lastRun}`);
    }

    // Example: Conditional pause based on time
    console.log('\n\n⏸️  Pausing weekend schedules...');
    const now = new Date();
    const isWeekend = now.getDay() === 0 || now.getDay() === 6;

    if (isWeekend) {
        await businessHoursSchedule.pause();
        console.log('  Schedule paused (weekend mode)');
    } else {
        console.log('  Schedule active (weekday)');
    }

    // Clean up
    console.log('\n🗑️  Cleaning up schedules...');
    await businessHoursSchedule.delete();
    await monthlySchedule.delete();
    await frequentSchedule.delete();

    for (const schedule of regionalSchedules) {
        await schedule.delete();
    }
    console.log('All schedules deleted');

    await reseolio.stop();
    console.log('\n✅ Done!');
}

main().catch(console.error);
