/**
 * Reseolio Client - Main SDK entry point
 */

import { spawn, ChildProcess } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { EventEmitter } from 'node:events';
import { v4 as uuidv4 } from 'uuid';
import { JobHandle } from './job';
import { DurableFunction, DurableOptions } from './durable';
import type { Job, JobOptions, DurableHandler, EnqueueResult } from './types';

export interface ReseolioConfig {
    /** Storage connection string (default: 'sqlite://./reseolio.db') */
    storage?: string;
    /** Address for gRPC server (default: '127.0.0.1:50051') */
    address?: string;
    /** Number of concurrent jobs to process (default: 10) */
    workerConcurrency?: number;
    /** Path to reseolio-core binary (auto-detected if not specified) */
    coreBinaryPath?: string;
    /** Whether to auto-start the core process (default: true) */
    autoStart?: boolean;
}

interface FunctionRegistry {
    [name: string]: {
        handler: DurableHandler<unknown[], unknown>;
        options: DurableOptions;
    };
}

/**
 * The main Reseolio client
 */
export class Reseolio extends EventEmitter {
    private config: Required<ReseolioConfig>;
    private coreProcess: ChildProcess | null = null;
    private grpcClient: any = null;
    private proto: any = null;
    private connected: boolean = false;
    private registry: FunctionRegistry = {};
    private workerId: string;
    private workerStream: any = null;
    private activeJobs: Set<string> = new Set();  // Track jobs being executed

    constructor(config: ReseolioConfig = {}) {
        super();
        // TODO: checkout possibility of worker id conflict
        this.workerId = `worker-${uuidv4().slice(0, 8)}`;

        this.config = {
            storage: config.storage ?? 'sqlite://./reseolio.db',
            address: config.address ?? '127.0.0.1:50051',
            workerConcurrency: config.workerConcurrency ?? 10,
            coreBinaryPath: config.coreBinaryPath ?? this.findCoreBinary(),
            autoStart: config.autoStart ?? true,
        };
    }

    /**
     * Start the Reseolio client and core process
     */
    async start(): Promise<void> {
        // Load proto definition
        await this.loadProto();

        console.debug(`starting client : ${this.workerId}`)

        // Start core process if auto-start is enabled
        if (this.config.autoStart) {
            await this.startCore();
        }

        // Connect to gRPC server
        await this.connect();

        // Start worker loop
        this.startWorkerLoop();

        this.emit('ready');
        console.debug(`client started successfully : ${this.workerId}`)
    }

    /**
     * Stop the client and core process
     */
    async stop(): Promise<void> {
        // Wait for active jobs to finish (with timeout)
        const maxWait = 5000; // 5 seconds
        const startTime = Date.now();
        console.debug(`stopping client : ${this.workerId}`)
        while (this.activeJobs.size > 0 && Date.now() - startTime < maxWait) {
            await new Promise(r => setTimeout(r, 100));
        }

        if (this.activeJobs.size > 0) {
            console.warn(`[Reseolio] ${this.activeJobs.size} jobs still active during shutdown`);
        }

        // Grace period to allow any in-flight messages to be delivered
        // This prevents "connection reset" errors when jobs are sent but not yet received
        await new Promise(r => setTimeout(r, 500));

        // Stop worker stream
        if (this.workerStream) {
            this.workerStream.cancel();
            this.workerStream = null;
        }

        // Close gRPC connection
        if (this.grpcClient) {
            grpc.closeClient(this.grpcClient);
            this.grpcClient = null;
        }

        // Stop core process
        if (this.coreProcess) {
            this.coreProcess.kill('SIGTERM');
            this.coreProcess = null;
        }

        this.connected = false;
        this.emit('stopped');
        console.debug(`stopped client successfully : ${this.workerId}`)
    }

    /**
     * Create a namespaced function name
     * 
     * @example
     * const name = reseolio.namespace('payments', 'billing', 'calculate');
     * // Returns: 'payments:billing:calculate'
     */
    namespace(...parts: string[]): string {
        if (parts.length === 0) {
            throw new Error('[Reseolio] namespace() requires at least one part');
        }

        // Validate each part
        for (const part of parts) {
            if (!part || typeof part !== 'string') {
                throw new Error('[Reseolio] All namespace parts must be non-empty strings');
            }
            if (part.includes(':') || part.includes('/')) {
                throw new Error(`[Reseolio] Namespace part '${part}' cannot contain ':' or '/'`);
            }
        }

        return parts.join(':');
    }

    /**
     * Create a durable function wrapper
     * 
     * Function names should be namespaced to avoid collisions across teams/modules.
     * Use the namespace() helper or follow the pattern: 'module:service:function'
     * 
     * @example
     * const sendEmail = reseolio.durable(
     *     reseolio.namespace('notifications', 'email', 'send'),
     *     async (to, subject, body) => { ... }
     * );
     */
    durable<TArgs extends unknown[], TResult>(
        name: string,
        handler: DurableHandler<TArgs, TResult>,
        options: DurableOptions = {}
    ): DurableFunction<TArgs, TResult> {
        // Validate name is not empty
        if (!name || typeof name !== 'string') {
            throw new Error('[Reseolio] Function name must be a non-empty string');
        }

        // Check for namespace (should contain ':' or '/')
        if (!name.includes(':') && !name.includes('/')) {
            console.warn(
                `[Reseolio] Function '${name}' is not namespaced. This may cause name collisions.\n` +
                `  Recommended: reseolio.namespace('module', 'service', '${name}')\n` +
                `  Or use pattern: 'module:service:${name}'`
            );
        }

        // Detect collisions
        if (this.registry[name]) {
            const existing = this.registry[name];
            throw new Error(
                `[Reseolio] Function '${name}' is already registered.\n` +
                `  Existing handler: ${existing.handler.toString().slice(0, 80)}...\n` +
                `  New handler: ${handler.toString().slice(0, 80)}...\n` +
                `  Use a unique namespaced name or check for duplicate registrations.`
            );
        }

        // Register the handler
        this.registry[name] = {
            handler: handler as DurableHandler<unknown[], unknown>,
            options,
        };

        // Return wrapped function that enqueues jobs
        // Last parameter can optionally be JobOptions for per-execution config
        const durableFunc = async (...args: [...TArgs, JobOptions?]): Promise<JobHandle<TResult>> => {
            // Check if last argument is JobOptions (has known option keys)
            const lastArg = args[args.length - 1];
            let executionArgs: unknown[];
            let executionOptions: JobOptions;

            if (
                lastArg &&
                typeof lastArg === 'object' &&
                !Array.isArray(lastArg) &&
                (
                    'idempotencyKey' in lastArg ||
                    'maxAttempts' in lastArg ||
                    'backoff' in lastArg ||
                    'initialDelayMs' in lastArg ||
                    'maxDelayMs' in lastArg ||
                    'timeoutMs' in lastArg ||
                    'jitter' in lastArg
                )
            ) {
                // Last arg is options, exclude it from handler args
                executionArgs = args.slice(0, -1);
                // Merge default options with per-execution options
                executionOptions = { ...options, ...(lastArg as JobOptions) };
            } else {
                // No options provided, use all args
                executionArgs = args;
                executionOptions = options;
            }

            const jobId = await this.enqueue(name, executionArgs, executionOptions);
            return new JobHandle<TResult>(jobId, this);
        };

        // Add metadata
        (durableFunc as DurableFunction<TArgs, TResult>).functionName = name;
        (durableFunc as DurableFunction<TArgs, TResult>).options = options;

        return durableFunc as DurableFunction<TArgs, TResult>;
    }

    /**
     * Enqueue a job for execution
     */
    async enqueue(
        name: string,
        args: unknown[],
        options: JobOptions = {}
    ): Promise<string> {
        if (!this.connected) {
            throw new Error('Reseolio client is not connected');
        }

        const request = {
            name,
            args: Buffer.from(JSON.stringify(args)),
            options: {
                maxAttempts: options.maxAttempts ?? 3,
                backoff: options.backoff ?? 'exponential',
                initialDelayMs: options.initialDelayMs ?? 1000,
                maxDelayMs: options.maxDelayMs ?? 60000,
                timeoutMs: options.timeoutMs ?? 30000,
                jitter: options.jitter ?? 0.1,
            },
            idempotencyKey: options.idempotencyKey ?? '',
        };

        return new Promise((resolve, reject) => {
            this.grpcClient.EnqueueJob(request, (err: Error | null, response: EnqueueResult) => {
                if (err) {
                    reject(err);
                } else {
                    if (response.deduplicated) {
                        this.emit('deduplicated', response.jobId);
                    }
                    resolve(response.jobId);
                }
            });
        });
    }

    /**
     * Get job status
     */
    async getJob(jobId: string): Promise<Job> {
        if (!this.connected) {
            throw new Error('Reseolio client is not connected');
        }

        return new Promise((resolve, reject) => {
            this.grpcClient.GetJob({ jobId }, (err: Error | null, job: Job) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(job);
                }
            });
        });
    }

    /**
     * Cancel a pending job
     */
    async cancelJob(jobId: string): Promise<boolean> {
        if (!this.connected) {
            throw new Error('Reseolio client is not connected');
        }

        return new Promise((resolve, reject) => {
            this.grpcClient.CancelJob({ jobId }, (err: Error | null, response: any) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(response.success);
                }
            });
        });
    }

    // === Private Methods ===

    private findCoreBinary(): string {
        // Look for binary in common locations
        const __dirname = dirname(fileURLToPath(import.meta.url));
        const locations = [
            join(__dirname, '..', '..', '..', 'core', 'target', 'release', 'reseolio'),
            join(__dirname, '..', '..', '..', 'core', 'target', 'debug', 'reseolio'),
            join(__dirname, '..', 'bin', 'reseolio'),
            'reseolio', // Try PATH
        ];

        // For Windows, add .exe extension
        if (process.platform === 'win32') {
            return locations.map(l => l.endsWith('.exe') ? l : `${l}.exe`)[0];
        }

        return locations[0];
    }

    private async loadProto(): Promise<void> {
        const __dirname = dirname(fileURLToPath(import.meta.url));
        const protoPath = join(__dirname, '..', '..', '..', 'proto', 'reseolio.proto');

        const packageDefinition = await protoLoader.load(protoPath, {
            keepCase: false,  // ← FIXED: Convert to camelCase!
            longs: String,
            enums: String,
            defaults: true,
            oneofs: true,
        });

        this.proto = grpc.loadPackageDefinition(packageDefinition).reseolio;
    }

    private async startCore(): Promise<void> {
        return new Promise((resolve, reject) => {
            const env = {
                ...process.env,
                RESEOLIO_DB: this.config.storage.replace('sqlite://', ''),
                RESEOLIO_ADDR: this.config.address,
            };

            this.coreProcess = spawn(this.config.coreBinaryPath, [], {
                env,
                stdio: ['ignore', 'pipe', 'pipe'],
            });

            this.coreProcess.stdout?.on('data', (data) => {
                this.emit('core:stdout', data.toString());
            });

            this.coreProcess.stderr?.on('data', (data) => {
                this.emit('core:stderr', data.toString());
            });

            this.coreProcess.on('error', (err) => {
                this.emit('core:error', err);
                reject(err);
            });

            this.coreProcess.on('exit', (code) => {
                this.emit('core:exit', code);
                if (!this.connected) {
                    reject(new Error(`Core process exited with code ${code}`));
                }
            });

            // Wait for server to be ready (simple delay for now)
            setTimeout(resolve, 500);
        });
    }

    private async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.grpcClient = new this.proto.Reseolio(
                this.config.address,
                grpc.credentials.createInsecure()
            );

            // Wait for connection
            const deadline = Date.now() + 5000;
            this.grpcClient.waitForReady(deadline, (err: Error | null) => {
                if (err) {
                    reject(err);
                } else {
                    this.connected = true;
                    resolve();
                }
            });
        });
    }

    private startWorkerLoop(): void {
        const call = this.grpcClient.PollJobs();
        this.workerStream = call;

        // Send initial poll request
        call.write({
            workerId: this.workerId,
            names: Object.keys(this.registry),
            concurrency: this.config.workerConcurrency,
        });

        // Handle incoming jobs (fire-and-forget to avoid blocking)
        call.on('data', (job: Job) => {
            // Don't await here - execute jobs concurrently!
            this.executeJob(job).catch((err) => {
                this.emit('worker:error', err);
            });
        });

        call.on('error', (err: Error) => {
            if ((err as any).code !== grpc.status.CANCELLED) {
                this.emit('worker:error', err);
                // Reconnect after delay
                setTimeout(() => this.startWorkerLoop(), 1000);
            }
        });

        call.on('end', () => {
            this.emit('worker:end');
        });
    }

    private async executeJob(job: Job): Promise<void> {
        // Track this job as active
        this.activeJobs.add(job.id);

        const registration = this.registry[job.name];

        if (!registration) {
            // Unknown job, acknowledge with error
            await this.ackJob(job.id, {
                success: false,
                error: `Unknown function: ${job.name}`,
                shouldRetry: false,
            });
            this.activeJobs.delete(job.id);
            return;
        }

        this.emit('job:start', job);

        try {
            // Parse arguments
            const args = JSON.parse(Buffer.from(job.args).toString());

            // Execute with timeout
            const timeoutMs = registration.options.timeoutMs ?? 30000;
            const result = await Promise.race([
                registration.handler(...(Array.isArray(args) ? args : [args])),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Job timeout')), timeoutMs)
                ),
            ]);

            // Acknowledge success
            await this.ackJob(job.id, {
                success: true,
                returnValue: Buffer.from(JSON.stringify(result)),
            });

            this.emit('job:success', job, result);
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);

            // Acknowledge failure
            await this.ackJob(job.id, {
                success: false,
                error,
                shouldRetry: true, // Let the server decide based on attempt count
            });

            this.emit('job:error', job, error);
        } finally {
            // Remove from active jobs
            this.activeJobs.delete(job.id);
        }
    }

    private async ackJob(
        jobId: string,
        result: { success: boolean; returnValue?: Buffer; error?: string; shouldRetry?: boolean }
    ): Promise<void> {
        // console.debug(`[DEBUG] ackJob called: jobId=${jobId}, success=${result.success}, error=${result.error}`);
        return new Promise((resolve, reject) => {
            this.grpcClient.AckJob(
                { jobId, result },
                (err: Error | null) => {
                    if (err) {
                        // console.debug(`[DEBUG] ackJob error: jobId=${jobId}, err=${err.message}`);
                        reject(err);
                    } else {
                        // console.debug(`[DEBUG] ackJob success: jobId=${jobId}`);
                        resolve();
                    }
                }
            );
        });
    }
}
