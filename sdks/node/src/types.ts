/**
 * Type definitions for Reseolio SDK
 */

export type BackoffStrategy = 'fixed' | 'exponential' | 'linear';

export type JobStatus =
    | 'pending'
    | 'running'
    | 'success'
    | 'failed'
    | 'dead'
    | 'cancelled';

export interface JobOptions {
    /** Maximum retry attempts (default: 3) */
    maxAttempts?: number;
    /** Backoff strategy (default: 'exponential') */
    backoff?: BackoffStrategy;
    /** Initial delay between retries in ms (default: 1000) */
    initialDelayMs?: number;
    /** Maximum delay cap in ms (default: 60000) */
    maxDelayMs?: number;
    /** Per-attempt timeout in ms (default: 30000) */
    timeoutMs?: number;
    /** Jitter factor 0.0-1.0 (default: 0.1) */
    jitter?: number;
    /** Idempotency key for deduplication */
    idempotencyKey?: string;
}

export interface Job {
    id: string;
    name: string;
    args: Uint8Array;
    attempt: number;
    deadlineMs: number;
    status: JobStatus;
    error?: string;
    result?: Uint8Array;
    createdAt: number;
    scheduledAt: number;
}

export interface EnqueueResult {
    jobId: string;
    deduplicated: boolean;
}

export interface AckResult {
    newStatus: JobStatus;
    nextAttempt: number;
    nextRunAt: number;
}

/**
 * Function type for durable handlers
 */
export type DurableHandler<TArgs extends unknown[], TResult> =
    (...args: TArgs) => Promise<TResult>;

/**
 * Convert proto status number to JobStatus
 */
export function protoToStatus(status: number): JobStatus {
    switch (status) {
        case 1: return 'pending';
        case 2: return 'running';
        case 3: return 'success';
        case 4: return 'failed';
        case 5: return 'dead';
        case 6: return 'cancelled';
        default: return 'pending';
    }
}

// === Schedule Types ===

export type ScheduleStatus = 'active' | 'paused' | 'deleted';

export interface Schedule {
    id: string;
    name: string;
    cronExpression: string;
    timezone: string;
    status: ScheduleStatus;
    nextRunAt: number;
    lastRunAt: number;
    createdAt: number;
    updatedAt: number;
    handlerOptions?: JobOptions;
    args?: any[];
}

export interface ScheduleOptions {
    /** Cron expression (e.g., "0 8 * * *" for 8am daily) */
    cron: string;
    /** IANA timezone (default: "UTC") */
    timezone?: string;
    /** Options applied to triggered jobs */
    handlerOptions?: JobOptions;
    /** Arguments passed to the job */
    args?: any[];
}

/**
 * Convert proto schedule status number to ScheduleStatus
 */
export function protoToScheduleStatus(status: number): ScheduleStatus {
    switch (status) {
        case 1: return 'active';
        case 2: return 'paused';
        case 3: return 'deleted';
        default: return 'active';
    }
}

