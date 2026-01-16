import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import path from "path";

// Load proto file
const PROTO_PATH = path.join(process.cwd(), "..", "proto", "reseolio.proto");

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
});

const protoDescriptor = grpc.loadPackageDefinition(packageDefinition) as any;
const reseolio = protoDescriptor.reseolio;

// Job Status enum
export enum JobStatus {
    UNSPECIFIED = 0,
    PENDING = 1,
    RUNNING = 2,
    SUCCESS = 3,
    FAILED = 4,
    DEAD = 5,
    CANCELLED = 6,
}

// Map proto status to string (handles both number and proto string format)
export function statusToString(status: number | string): string {
    // Handle string format from proto-loader with enums: String
    if (typeof status === "string") {
        if (status.includes("PENDING")) return "PENDING";
        if (status.includes("RUNNING")) return "RUNNING";
        if (status.includes("SUCCESS")) return "SUCCESS";
        if (status.includes("FAILED")) return "FAILED";
        if (status.includes("DEAD")) return "DEAD";
        if (status.includes("CANCELLED")) return "CANCELLED";
        return "PENDING"; // Default fallback
    }

    // Handle number format
    switch (status) {
        case 1: return "PENDING";
        case 2: return "RUNNING";
        case 3: return "SUCCESS";
        case 4: return "FAILED";
        case 5: return "DEAD";
        case 6: return "CANCELLED";
        default: return "PENDING";
    }
}

// Map string status to proto number
export function stringToStatus(status: string): number {
    switch (status.toUpperCase()) {
        case "PENDING": return 1;
        case "RUNNING": return 2;
        case "SUCCESS": return 3;
        case "FAILED": return 4;
        case "DEAD": return 5;
        case "CANCELLED": return 6;
        default: return 0;
    }
}

// Types matching our frontend
export interface Job {
    id: string;
    name: string;
    args: Buffer;
    attempt: number;
    deadline_ms: string;
    status: number | string;
    error: string;
    result: Buffer;
    created_at: string;
    scheduled_at: string;
    started_at: string;
    completed_at: string;
    max_attempts: number;
}

export interface ListJobsRequest {
    statuses?: number[];
    names?: string[];
    limit?: number;
    offset?: number;
    order_by?: string;
    ascending?: boolean;
}

export interface ListJobsResponse {
    jobs: Job[];
    total: number;
}

export interface GetJobRequest {
    job_id: string;
}

export interface CancelRequest {
    job_id: string;
}

export interface CancelResponse {
    success: boolean;
    message: string;
}

// Singleton client
let client: any = null;

function getClient() {
    if (!client) {
        const serverUrl = process.env.RESEOLIO_SERVER_URL || "localhost:50051";
        client = new reseolio.Reseolio(
            serverUrl,
            grpc.credentials.createInsecure()
        );
    }
    return client;
}

// Promisified gRPC methods
export function listJobs(request: ListJobsRequest): Promise<ListJobsResponse> {
    return new Promise((resolve, reject) => {
        getClient().ListJobs(request, (error: any, response: ListJobsResponse) => {
            if (error) {
                console.error("[gRPC] ListJobs error:", error);
                reject(error);
            } else {
                resolve(response);
            }
        });
    });
}

export function getJob(jobId: string): Promise<Job> {
    return new Promise((resolve, reject) => {
        getClient().GetJob({ job_id: jobId }, (error: any, response: Job) => {
            if (error) {
                console.error("[gRPC] GetJob error:", error);
                reject(error);
            } else {
                resolve(response);
            }
        });
    });
}

export function cancelJob(jobId: string): Promise<CancelResponse> {
    return new Promise((resolve, reject) => {
        getClient().CancelJob({ job_id: jobId }, (error: any, response: CancelResponse) => {
            if (error) {
                console.error("[gRPC] CancelJob error:", error);
                reject(error);
            } else {
                resolve(response);
            }
        });
    });
}

export interface RetryResponse {
    success: boolean;
    message: string;
}

export function retryJob(jobId: string): Promise<RetryResponse> {
    return new Promise((resolve, reject) => {
        getClient().RetryJob({ job_id: jobId }, (error: any, response: RetryResponse) => {
            if (error) {
                console.error("[gRPC] RetryJob error:", error);
                reject(error);
            } else {
                resolve(response);
            }
        });
    });
}

// Calculate stats from jobs list
export interface Stats {
    totalJobs: number;
    pendingCount: number;
    runningCount: number;
    successCount: number;
    failedCount: number;
    deadCount: number;
    successRate: number;
}

export async function getStats(): Promise<Stats> {
    // Fetch counts for each status
    const [pending, running, success, failed, dead] = await Promise.all([
        listJobs({ statuses: [JobStatus.PENDING], limit: 1 }),
        listJobs({ statuses: [JobStatus.RUNNING], limit: 1 }),
        listJobs({ statuses: [JobStatus.SUCCESS], limit: 1 }),
        listJobs({ statuses: [JobStatus.FAILED], limit: 1 }),
        listJobs({ statuses: [JobStatus.DEAD], limit: 1 }),
    ]);

    const totalJobs = pending.total + running.total + success.total + failed.total + dead.total;
    const completedJobs = success.total + failed.total + dead.total;
    const successRate = completedJobs > 0 ? (success.total / completedJobs) * 100 : 100;

    return {
        totalJobs,
        pendingCount: pending.total,
        runningCount: running.total,
        successCount: success.total,
        failedCount: failed.total,
        deadCount: dead.total,
        successRate: Math.round(successRate * 10) / 10,
    };
}
