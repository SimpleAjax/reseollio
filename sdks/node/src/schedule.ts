/**
 * Schedule handle for managing cron schedules
 */

import type { Reseolio } from './client';
import type { Schedule, ScheduleStatus, JobOptions } from './types';
import { protoToScheduleStatus } from './types';

/**
 * A handle to a cron schedule
 * 
 * Provides methods to manage the schedule lifecycle:
 * - pause/resume to control triggering
 * - update to modify the cron expression, timezone, or options
 * - delete to soft-delete the schedule
 */
export class ScheduleHandle {
    constructor(
        public readonly id: string,
        public readonly name: string,
        private readonly client: Reseolio
    ) { }

    /**
     * Get the current schedule details
     */
    async details(): Promise<Schedule> {
        return this.client.getSchedule(this.id);
    }

    /**
     * Get the current schedule status
     */
    async status(): Promise<ScheduleStatus> {
        const schedule = await this.client.getSchedule(this.id);
        return schedule.status;
    }

    /**
     * Pause the schedule (stops triggering)
     */
    async pause(): Promise<Schedule> {
        return this.client.pauseSchedule(this.id);
    }

    /**
     * Resume a paused schedule
     */
    async resume(): Promise<Schedule> {
        return this.client.resumeSchedule(this.id);
    }

    /**
     * Update the schedule's cron expression, timezone, or options
     */
    async update(options: {
        cron?: string;
        timezone?: string;
        handlerOptions?: JobOptions;
    }): Promise<Schedule> {
        return this.client.updateSchedule(this.id, options);
    }

    /**
     * Delete (soft-delete) the schedule
     */
    async delete(): Promise<boolean> {
        return this.client.deleteSchedule(this.id);
    }

    /**
     * Get the next run time (in milliseconds since epoch)
     */
    async nextRunAt(): Promise<Date> {
        const schedule = await this.client.getSchedule(this.id);
        return new Date(schedule.nextRunAt);
    }

    /**
     * Get the last run time (in milliseconds since epoch)
     */
    async lastRunAt(): Promise<Date | null> {
        const schedule = await this.client.getSchedule(this.id);
        return schedule.lastRunAt ? new Date(schedule.lastRunAt) : null;
    }
}

/**
 * Helper function to convert proto schedule to client format
 */
export function protoToSchedule(proto: any): Schedule {
    return {
        id: proto.id,
        name: proto.name,
        cronExpression: proto.cronExpression,
        timezone: proto.timezone || 'UTC',
        status: protoToScheduleStatus(proto.status),
        nextRunAt: Number(proto.nextRunAt),
        lastRunAt: proto.lastRunAt ? Number(proto.lastRunAt) : 0,
        createdAt: Number(proto.createdAt),
        updatedAt: Number(proto.updatedAt),
        handlerOptions: proto.handlerOptions ? {
            maxAttempts: proto.handlerOptions.maxAttempts,
            backoff: proto.handlerOptions.backoff,
            initialDelayMs: proto.handlerOptions.initialDelayMs,
            maxDelayMs: proto.handlerOptions.maxDelayMs,
            timeoutMs: proto.handlerOptions.timeoutMs,
            jitter: proto.handlerOptions.jitter,
        } : undefined,
    };
}
