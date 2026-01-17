// API types
export type JobStatus = "PENDING" | "RUNNING" | "SUCCESS" | "FAILED" | "DEAD" | "CANCELLED";

export interface Job {
    id: string;
    name: string;
    status: JobStatus;
    attempt: number;
    maxAttempts: number;
    createdAt: number; // Unix ms
    scheduledAt: number;
    startedAt: number | null;
    completedAt: number | null;
    error: string | null;
    args: string | null;
    result: string | null;
    idempotencyKey?: string | null;
}

export interface Stats {
    totalJobs: number;
    pendingCount: number;
    runningCount: number;
    successCount: number;
    failedCount: number;
    deadCount: number;
    successRate: number;
}

export interface JobsResponse {
    jobs: Job[];
    total: number;
    limit: number;
    offset: number;
}

export interface JobsParams {
    status?: JobStatus | "ALL";
    search?: string;
    limit?: number;
    offset?: number;
    orderBy?: string;
    ascending?: boolean;
}

const API_BASE = "/api";

export async function fetchJobs(params: JobsParams = {}): Promise<JobsResponse> {
    const searchParams = new URLSearchParams();

    if (params.status && params.status !== "ALL") {
        searchParams.set("status", params.status);
    }
    if (params.search) {
        searchParams.set("search", params.search);
    }
    if (params.limit) {
        searchParams.set("limit", params.limit.toString());
    }
    if (params.offset) {
        searchParams.set("offset", params.offset.toString());
    }
    if (params.orderBy) {
        searchParams.set("orderBy", params.orderBy);
    }
    if (params.ascending !== undefined) {
        searchParams.set("ascending", params.ascending.toString());
    }

    const response = await fetch(`${API_BASE}/jobs?${searchParams.toString()}`);

    if (!response.ok) {
        throw new Error(`Failed to fetch jobs: ${response.statusText}`);
    }

    return response.json();
}

export async function fetchJob(id: string): Promise<Job> {
    const response = await fetch(`${API_BASE}/jobs/${id}`);

    if (!response.ok) {
        throw new Error(`Failed to fetch job: ${response.statusText}`);
    }

    return response.json();
}

export async function fetchStats(): Promise<Stats> {
    const response = await fetch(`${API_BASE}/stats`);

    if (!response.ok) {
        throw new Error(`Failed to fetch stats: ${response.statusText}`);
    }

    return response.json();
}

export async function cancelJob(id: string): Promise<{ success: boolean; message: string }> {
    const response = await fetch(`${API_BASE}/jobs/${id}`, {
        method: "DELETE",
    });

    return response.json();
}

export async function retryJob(id: string): Promise<{ success: boolean; message: string }> {
    const response = await fetch(`${API_BASE}/jobs/${id}/retry`, {
        method: "POST",
    });

    return response.json();
}

// ==================== SCHEDULE TYPES ====================

export type ScheduleStatus = "ACTIVE" | "PAUSED" | "DELETED";

export interface Schedule {
    id: string;
    name: string;
    handlerName: string;
    cron: string;
    timezone: string;
    status: ScheduleStatus;
    totalRuns: number;
    createdAt: number; // Unix ms
    nextRunAt: number | null;
    lastRunAt: number | null;
}

export interface SchedulesResponse {
    schedules: Schedule[];
    total: number;
    limit: number;
    offset: number;
}

export interface SchedulesParams {
    status?: ScheduleStatus | "ALL";
    handlerName?: string;
    limit?: number;
    offset?: number;
}

// ==================== SCHEDULE API FUNCTIONS ====================

export async function fetchSchedules(params: SchedulesParams = {}): Promise<SchedulesResponse> {
    const searchParams = new URLSearchParams();

    if (params.status && params.status !== "ALL") {
        searchParams.set("status", params.status);
    }
    if (params.handlerName) {
        searchParams.set("handlerName", params.handlerName);
    }
    if (params.limit) {
        searchParams.set("limit", params.limit.toString());
    }
    if (params.offset) {
        searchParams.set("offset", params.offset.toString());
    }

    const response = await fetch(`${API_BASE}/schedules?${searchParams.toString()}`);

    if (!response.ok) {
        throw new Error(`Failed to fetch schedules: ${response.statusText}`);
    }

    return response.json();
}

export async function fetchSchedule(id: string): Promise<Schedule> {
    const response = await fetch(`${API_BASE}/schedules/${id}`);

    if (!response.ok) {
        throw new Error(`Failed to fetch schedule: ${response.statusText}`);
    }

    return response.json();
}

export async function pauseSchedule(id: string): Promise<{ success: boolean; schedule?: Schedule }> {
    const response = await fetch(`${API_BASE}/schedules/${id}/pause`, {
        method: "POST",
    });

    return response.json();
}

export async function resumeSchedule(id: string): Promise<{ success: boolean; schedule?: Schedule }> {
    const response = await fetch(`${API_BASE}/schedules/${id}/resume`, {
        method: "POST",
    });

    return response.json();
}

export async function deleteSchedule(id: string): Promise<{ success: boolean; message: string }> {
    const response = await fetch(`${API_BASE}/schedules/${id}`, {
        method: "DELETE",
    });

    return response.json();
}
