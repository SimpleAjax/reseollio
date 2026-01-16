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
     * Caches result after first successful retrieval.
     */
    async result(timeoutMs: number = 0, pollingInterval: number = 60000): Promise<TResult> {
        // Return cached result if already resolved
        if (this._resolved) {
            if (this._error) {
                throw new Error(this._error);
            }
            return this._result as TResult;
        }

        return new Promise((resolve, reject) => {
            let isResolved = false;
            let pollTimer: NodeJS.Timeout;
            let timeoutTimer: NodeJS.Timeout;

            // 0. Check for cached result (fix for fast-completing jobs)
            const cached = this.client.tryGetResult<TResult>(this.jobId);
            if (cached) {
                this._resolved = true;
                if (cached.error) {
                    this._error = cached.error.message || String(cached.error);
                    reject(cached.error);
                } else {
                    this._result = cached.result as TResult;
                    resolve(cached.result as TResult);
                }
                return;
            }

            const cleanup = () => {
                isResolved = true;
                this.client.off(`job:success:${this.jobId}`, successHandler);
                this.client.off(`job:failed:${this.jobId}`, failedHandler);
                clearTimeout(pollTimer);
                clearTimeout(timeoutTimer);
            };

            const successHandler = (result: any) => {
                // console.log('Job Suceeded with id', this.jobId);
                if (isResolved) return;
                cleanup();
                this._resolved = true;
                this._result = result as TResult;
                resolve(result as TResult);
            };

            const failedHandler = (error: any) => {
                if (isResolved) return;
                cleanup();
                this._resolved = true;
                this._error = `Job failed: ${error?.message || error}`;
                reject(new Error(this._error));
            };

            // 1. Subscribe to push notifications (PRIMARY mechanism)
            this.client.on(`job:success:${this.jobId}`, successHandler);
            this.client.on(`job:failed:${this.jobId}`, failedHandler);

            // 2. Fallback polling (SECONDARY - only for missed push events)
            const check = async () => {
                if (isResolved) return;
                try {
                    const job = await this.client.getJob(this.jobId);
                    const status = this.protoToStatus(job.status as unknown as number);

                    if (status === 'success') {
                        if (!isResolved) {
                            cleanup();
                            const result = job.result
                                ? JSON.parse(Buffer.from(job.result).toString())
                                : null;
                            this._resolved = true;
                            this._result = result as TResult;
                            resolve(result as TResult);
                        }
                        return;
                    }

                    if (status === 'dead' || status === 'cancelled') {
                        if (!isResolved) {
                            cleanup();
                            const msg = status === 'dead' ? `Job failed: ${job.error}` : 'Job was cancelled';
                            this._resolved = true;
                            this._error = msg;
                            reject(new Error(msg));
                        }
                        return;
                    }

                    // Job still pending/running - schedule next poll
                    if (!isResolved) {
                        pollTimer = setTimeout(check, pollingInterval);
                    }

                } catch (err) {
                    // Ignore transient errors and retry
                    if (!isResolved) {
                        pollTimer = setTimeout(check, pollingInterval);
                    }
                }
            };

            // Start first poll AFTER the interval (give push notification time to arrive)
            pollTimer = setTimeout(check, pollingInterval);

            // 3. Optional hard timeout
            if (timeoutMs > 0) {
                timeoutTimer = setTimeout(() => {
                    if (!isResolved) {
                        cleanup();
                        reject(new Error(`Job timed out after ${timeoutMs}ms`));
                    }
                }, timeoutMs);
            }
        });
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
