/**
 * Reseolio - The Durable Execution for Modern Backends
 * 
 * Node.js SDK for durable function execution
 */

export { Reseolio, type ReseolioConfig } from './client';
export { durable, type DurableOptions } from './durable';
export { JobHandle, type JobStatus } from './job';
export { ScheduleHandle } from './schedule';
export {
    type Job,
    type JobOptions,
    type BackoffStrategy,
    type Schedule,
    type ScheduleStatus,
    type ScheduleOptions,
} from './types';
