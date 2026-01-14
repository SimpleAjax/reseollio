/**
 * Job handle for tracking job status and results
 */

import type { Reseolio } from './client';
import type { Job, JobStatus, protoToStatus } from './types';

export { JobStatus };

/**
 * A handle to a running or completed job
 */
export class JobHandle<TResult = unknown> {
    private _result: TResult | null = null;
    private _status: JobStatus = 'pending';
    private _resolved: boolean = false;
    private _error: string | null = null;

    constructor(
        public readonly jobId: string,
        private readonly client: Reseolio
    ) { }

    /**
     * Get the current job status
     */
    async status(): Promise<JobStatus> {
        const job = await this.client.getJob(this.jobId);
        this._status = this.protoToStatus(job.status as unknown as number);
        return this._status;
    }

    /**
     * Wait for the job result
     * 
     * Uses push-based subscription (no polling) for efficient result notification.
     * Falls back to one-time check if push doesn't arrive within timeout.
     */
    async result(timeoutMs: number = 30000): Promise<TResult> {
        // Subscribe to completion notification immediately (no initial check)
        const subscriptionPromise = this.client.subscribeToJob<TResult>(this.jobId);

        // Timeout fallback - if push doesn't arrive, check once
        const timeoutPromise = new Promise<TResult>((resolve, reject) => {
            setTimeout(async () => {
                try {
                    const job = await this.client.getJob(this.jobId);
                    const status = this.protoToStatus(job.status as unknown as number);

                    if (status === 'success') {
                        const result = job.result
                            ? JSON.parse(Buffer.from(job.result).toString())
                            : null;
                        resolve(result as TResult);
                    } else if (status === 'dead') {
                        reject(new Error(`Job failed after max retries: ${job.error}`));
                    } else if (status === 'cancelled') {
                        reject(new Error('Job was cancelled'));
                    } else {
                        reject(new Error(`Job still pending after ${timeoutMs}ms`));
                    }
                } catch (err) {
                    reject(err);
                }
            }, timeoutMs);
        });

        // Return whichever completes first
        return Promise.race([subscriptionPromise, timeoutPromise]);
    }

    /**
     * Cancel the job if it's still pending
     */
    async cancel(): Promise<boolean> {
        return this.client.cancelJob(this.jobId);
    }

    /**
     * Get full job details
     */
    async details(): Promise<Job> {
        const job = await this.client.getJob(this.jobId);
        // Convert proto status to client-friendly format
        return {
            ...job,
            status: this.protoToStatus(job.status as unknown as number)
        };
    }

    private protoToStatus(status: number | string): JobStatus {
        if (typeof status === 'string') {
            const normalized = status.toLowerCase().replace('job_status_', '');
            return normalized as JobStatus;
        }
        switch (status) {
            case 1: return 'pending';
            case 2: return 'running';
            case 3: return 'success';
            case 4: return 'failed'; // deprecated state, `dead` is used instead
            case 5: return 'dead';
            case 6: return 'cancelled';
            default: return 'pending';
        }
    }
}
