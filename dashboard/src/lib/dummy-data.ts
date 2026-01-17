export type JobStatus = "PENDING" | "RUNNING" | "SUCCESS" | "DEAD" | "CANCELLED";

export interface Job {
    id: string;
    name: string;
    status: JobStatus;
    attempt: number;
    maxAttempts: number;
    createdAt: Date;
    scheduledAt?: Date;
    startedAt?: Date;
    completedAt?: Date;
    duration?: number;
    error?: string;
    idempotencyKey?: string;
}

export interface Stats {
    totalJobs: number;
    pendingCount: number;
    runningCount: number;
    successCount: number;
    deadCount: number;
    cancelledCount: number;
    successRate: number;
    avgDuration: number;
}

// Generate dummy jobs
export const dummyJobs: Job[] = [
    {
        id: "job_1a2b3c4d",
        name: "orders:payment:process",
        status: "SUCCESS",
        attempt: 1,
        maxAttempts: 3,
        createdAt: new Date(Date.now() - 2 * 60 * 1000),
        scheduledAt: new Date(Date.now() - 2 * 60 * 1000),
        startedAt: new Date(Date.now() - 2 * 60 * 1000),
        completedAt: new Date(Date.now() - 1.8 * 60 * 1000),
        duration: 1240,
        idempotencyKey: "pay_abc123",
    },
    {
        id: "job_2e3f4g5h",
        name: "email:send:welcome",
        status: "RUNNING",
        attempt: 2,
        maxAttempts: 5,
        createdAt: new Date(Date.now() - 1 * 60 * 1000),
        scheduledAt: new Date(Date.now() - 1 * 60 * 1000),
        startedAt: new Date(Date.now() - 45 * 1000),
    },
    {
        id: "job_3i4j5k6l",
        name: "reports:generate:monthly",
        status: "PENDING",
        attempt: 0,
        maxAttempts: 3,
        createdAt: new Date(Date.now() - 30 * 1000),
        scheduledAt: new Date(Date.now() + 30 * 60 * 1000),
    },
    {
        id: "job_4m5n6o7p",
        name: "webhook:deliver:stripe",
        status: "DEAD",
        attempt: 5,
        maxAttempts: 5,
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
        scheduledAt: new Date(Date.now() - 60 * 60 * 1000),
        startedAt: new Date(Date.now() - 55 * 60 * 1000),
        completedAt: new Date(Date.now() - 50 * 60 * 1000),
        error: "Connection timeout after 5000ms",
    },
    {
        id: "job_5q6r7s8t",
        name: "notifications:push:send",
        status: "SUCCESS",
        attempt: 1,
        maxAttempts: 3,
        createdAt: new Date(Date.now() - 5 * 60 * 1000),
        scheduledAt: new Date(Date.now() - 5 * 60 * 1000),
        startedAt: new Date(Date.now() - 4.5 * 60 * 1000),
        completedAt: new Date(Date.now() - 4.2 * 60 * 1000),
        duration: 320,
    },
    {
        id: "job_6u7v8w9x",
        name: "data:sync:users",
        status: "CANCELLED",
        attempt: 2,
        maxAttempts: 3,
        createdAt: new Date(Date.now() - 10 * 60 * 1000),
        scheduledAt: new Date(Date.now() - 5 * 60 * 1000),
        startedAt: new Date(Date.now() - 4 * 60 * 1000),
        completedAt: new Date(Date.now() - 3.5 * 60 * 1000),
        error: "Cancelled by user",
    },
    {
        id: "job_7y8z9a0b",
        name: "cache:invalidate:products",
        status: "SUCCESS",
        attempt: 1,
        maxAttempts: 1,
        createdAt: new Date(Date.now() - 15 * 60 * 1000),
        scheduledAt: new Date(Date.now() - 15 * 60 * 1000),
        startedAt: new Date(Date.now() - 14.9 * 60 * 1000),
        completedAt: new Date(Date.now() - 14.8 * 60 * 1000),
        duration: 85,
    },
    {
        id: "job_8c9d0e1f",
        name: "analytics:track:event",
        status: "RUNNING",
        attempt: 1,
        maxAttempts: 3,
        createdAt: new Date(Date.now() - 20 * 1000),
        scheduledAt: new Date(Date.now() - 20 * 1000),
        startedAt: new Date(Date.now() - 15 * 1000),
    },
    {
        id: "job_9g0h1i2j",
        name: "billing:invoice:generate",
        status: "PENDING",
        attempt: 0,
        maxAttempts: 3,
        createdAt: new Date(Date.now() - 2 * 60 * 1000),
        scheduledAt: new Date(Date.now() + 10 * 60 * 1000),
    },
    {
        id: "job_0k1l2m3n",
        name: "image:resize:thumbnail",
        status: "SUCCESS",
        attempt: 1,
        maxAttempts: 3,
        createdAt: new Date(Date.now() - 30 * 60 * 1000),
        scheduledAt: new Date(Date.now() - 30 * 60 * 1000),
        startedAt: new Date(Date.now() - 29.8 * 60 * 1000),
        completedAt: new Date(Date.now() - 29.5 * 60 * 1000),
        duration: 180,
    },
];

export const dummyStats: Stats = {
    totalJobs: 1247,
    pendingCount: 12,
    runningCount: 3,
    successCount: 1195,
    deadCount: 5,
    cancelledCount: 32,
    successRate: 95.8,
    avgDuration: 842,
};
