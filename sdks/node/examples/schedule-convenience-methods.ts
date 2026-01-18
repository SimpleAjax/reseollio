/**
 * Schedule Example: Convenience Methods
 * 
 * This example shows how to use the convenience methods for
 * creating common schedule patterns.
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
    const cleanupTemp = reseolio.durable('cleanup:temp-files', async () => {
        console.log('🧹 Cleaning up temporary files...');
        return { cleaned: true, timestamp: Date.now() };
    });

    const generateHourlyMetrics = reseolio.durable('metrics:hourly', async () => {
        console.log('📊 Generating hourly metrics...');
        return { metrics: 'generated', timestamp: Date.now() };
    });

    const weeklyBackup = reseolio.durable('backup:database', async () => {
        console.log('💾 Running weekly database backup...');
        return { backup: 'complete', timestamp: Date.now() };
    });

    const deepCleanup = reseolio.durable('cleanup:deep', async () => {
        console.log('🧹 Running deep cleanup...');
        return { cleaned: true, timestamp: Date.now() };
    });

    // Example 1: Run every minute
    console.log('📅 Setting up every-minute schedule...');
    const everyMinuteSchedule = await cleanupTemp.everyMinute();
    console.log(`  ✅ Created: ${everyMinuteSchedule.id}`);
    console.log(`  Next run: ${(await everyMinuteSchedule.nextRunAt()).toLocaleString()}\n`);

    // Example 2: Run every hour
    console.log('📅 Setting up hourly schedule...');
    const hourlySchedule = await generateHourlyMetrics.hourly();
    console.log(`  ✅ Created: ${hourlySchedule.id}`);
    console.log(`  Next run: ${(await hourlySchedule.nextRunAt()).toLocaleString()}\n`);

    // Example 3: Run daily at 2 AM
    console.log('📅 Setting up daily schedule (2 AM)...');
    const dailySchedule = await deepCleanup.daily(2);
    console.log(`  ✅ Created: ${dailySchedule.id}`);
    console.log(`  Next run: ${(await dailySchedule.nextRunAt()).toLocaleString()}\n`);

    // Example 4: Run weekly on Monday at 3 AM
    console.log('📅 Setting up weekly schedule (Monday 3 AM)...');
    const weeklySchedule = await weeklyBackup.weekly(1, 3); // 1 = Monday
    console.log(`  ✅ Created: ${weeklySchedule.id}`);
    console.log(`  Next run: ${(await weeklySchedule.nextRunAt()).toLocaleString()}\n`);

    // List all schedules
    console.log('📋 Listing all schedules:');
    const allSchedules = await reseolio.listSchedules();
    console.log(`  Total: ${allSchedules.total}`);
    allSchedules.schedules.forEach(schedule => {
        console.log(`  - ${schedule.name} (${schedule.status})`);
    });

    // Clean up
    console.log('\n🗑️  Cleaning up schedules...');
    await everyMinuteSchedule.delete();
    await hourlySchedule.delete();
    await dailySchedule.delete();
    await weeklySchedule.delete();
    console.log('All schedules deleted');

    await reseolio.stop();
    console.log('\n✅ Done!');
}

main().catch(console.error);
