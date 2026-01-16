import { NextRequest, NextResponse } from "next/server";
import { getJob, cancelJob, statusToString } from "@/lib/grpc-client";

// Parse timestamp - handles both seconds and milliseconds
const parseTimestamp = (ts: string | number): number => {
    const num = typeof ts === 'string' ? parseInt(ts, 10) : ts;
    if (!num || isNaN(num)) return Date.now();
    if (num < 100000000000) {
        return num * 1000;
    }
    return num;
};

// Parse optional timestamp (returns null if 0 or invalid)
const parseOptionalTimestamp = (ts: string | number): number | null => {
    const num = typeof ts === 'string' ? parseInt(ts, 10) : ts;
    if (!num || isNaN(num) || num === 0) return null;
    if (num < 100000000000) {
        return num * 1000;
    }
    return num;
};

// Transform gRPC job to API response format
function transformJob(job: any) {
    return {
        id: job.id,
        name: job.name,
        status: statusToString(job.status),
        attempt: job.attempt,
        maxAttempts: job.max_attempts || 3,
        createdAt: parseTimestamp(job.created_at),
        scheduledAt: parseTimestamp(job.scheduled_at),
        startedAt: parseOptionalTimestamp(job.started_at),
        completedAt: parseOptionalTimestamp(job.completed_at),
        error: job.error || null,
        args: job.args ? Buffer.from(job.args).toString("utf-8") : null,
        result: job.result ? Buffer.from(job.result).toString("utf-8") : null,
        idempotencyKey: null, // TODO: Add to proto response
    };
}

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params;
        const job = await getJob(id);
        return NextResponse.json(transformJob(job));
    } catch (error: any) {
        console.error("[API] Error fetching job:", error);

        if (error.code === 5) { // NOT_FOUND
            return NextResponse.json(
                { error: "Job not found" },
                { status: 404 }
            );
        }

        return NextResponse.json(
            { error: "Failed to fetch job", details: error.message },
            { status: 500 }
        );
    }
}

export async function DELETE(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params;
        const response = await cancelJob(id);

        if (response.success) {
            return NextResponse.json({ success: true, message: "Job cancelled" });
        } else {
            return NextResponse.json(
                { success: false, message: response.message || "Failed to cancel job" },
                { status: 400 }
            );
        }
    } catch (error: any) {
        console.error("[API] Error canceling job:", error);
        return NextResponse.json(
            { error: "Failed to cancel job", details: error.message },
            { status: 500 }
        );
    }
}
