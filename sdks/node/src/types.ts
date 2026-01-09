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
