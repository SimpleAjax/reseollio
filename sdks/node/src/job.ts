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
     * Polls until the job is complete (success, dead, or cancelled)
     */
    async result(pollIntervalMs: number = 500): Promise<TResult> {
        while (true) {
            const job = await this.client.getJob(this.jobId);
            const status = this.protoToStatus(job.status as unknown as number);

            if (status === 'success') {
                const result = job.result
                    ? JSON.parse(Buffer.from(job.result).toString())
                    : null;
                return result as TResult;
            }

            if (status === 'dead') {
                throw new Error(`Job failed after max retries: ${job.error}`);
            }

            if (status === 'cancelled') {
                throw new Error('Job was cancelled');
            }

            // Wait before polling again
            await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        }
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
