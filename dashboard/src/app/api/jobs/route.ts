import { NextRequest, NextResponse } from "next/server";
import { listJobs, statusToString, stringToStatus, type Job as GrpcJob } from "@/lib/grpc-client";

// Transform gRPC job to API response format
function transformJob(job: GrpcJob) {
    // Parse timestamp - gRPC sends seconds, JS Date needs milliseconds
    // Seconds (10 digits): 1768546100 = Jan 2026
    // Milliseconds (13 digits): 1768546100000 = Jan 2026
    const parseTimestamp = (ts: string | number): number => {
        const num = typeof ts === 'string' ? parseInt(ts, 10) : ts;
        if (!num || isNaN(num)) return Date.now();

        // Check number of digits to determine if seconds or ms
        // If < 100 billion, it's definitely seconds (covers dates until year 5138)
        // If >= 100 billion, it's milliseconds
        if (num < 100000000000) {
            return num * 1000; // Convert seconds to ms
        }
        return num; // Already in ms
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
    };
}

export async function GET(request: NextRequest) {
    try {
        const searchParams = request.nextUrl.searchParams;

        // Parse query params
        const status = searchParams.get("status");
        const search = searchParams.get("search");
        const limit = parseInt(searchParams.get("limit") || "50");
        const offset = parseInt(searchParams.get("offset") || "0");
        const orderBy = searchParams.get("orderBy") || "created_at";
        const ascending = searchParams.get("ascending") === "true";

        // Build request
        const grpcRequest: any = {
            limit,
            offset,
            order_by: orderBy,
            ascending,
        };

        // Add status filter if specified
        if (status && status !== "ALL") {
            const statusNum = stringToStatus(status);
            if (statusNum > 0) {
                grpcRequest.statuses = [statusNum];
            }
        }

        // Add name filter if search specified
        if (search) {
            grpcRequest.names = [search];
        }

        const response = await listJobs(grpcRequest);

        // Transform jobs
        const jobs = response.jobs.map(transformJob);

        return NextResponse.json({
            jobs,
            total: response.total,
            limit,
            offset,
        });
    } catch (error: any) {
        console.error("[API] Error fetching jobs:", error);
        return NextResponse.json(
            { error: "Failed to fetch jobs", details: error.message },
            { status: 500 }
        );
    }
}
