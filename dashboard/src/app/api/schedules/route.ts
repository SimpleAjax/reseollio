import { NextRequest, NextResponse } from "next/server";
import {
    listSchedules,
    createSchedule,
    scheduleStatusToString,
    type Schedule as GrpcSchedule,
} from "@/lib/grpc-client";

// Transform gRPC schedule to API response format
function transformSchedule(schedule: GrpcSchedule) {
    // Parse timestamp - gRPC sends seconds, JS Date needs milliseconds
    const parseTimestamp = (ts: string | number): number => {
        const num = typeof ts === "string" ? parseInt(ts, 10) : ts;
        if (!num || isNaN(num)) return Date.now();
        if (num < 100000000000) {
            return num * 1000; // Convert seconds to ms
        }
        return num; // Already in ms
    };

    // Parse optional timestamp (returns null if 0 or invalid)
    const parseOptionalTimestamp = (ts: string | number): number | null => {
        const num = typeof ts === "string" ? parseInt(ts, 10) : ts;
        if (!num || isNaN(num) || num === 0) return null;
        if (num < 100000000000) {
            return num * 1000;
        }
        return num;
    };

    return {
        id: schedule.id,
        name: schedule.name,
        handlerName: schedule.handler_name,
        cron: schedule.cron,
        timezone: schedule.timezone || "UTC",
        status: scheduleStatusToString(schedule.status),
        totalRuns: parseInt(schedule.total_runs?.toString() || "0", 10),
        createdAt: parseTimestamp(schedule.created_at),
        nextRunAt: parseOptionalTimestamp(schedule.next_run_at),
        lastRunAt: parseOptionalTimestamp(schedule.last_run_at),
    };
}

export async function GET(request: NextRequest) {
    try {
        const searchParams = request.nextUrl.searchParams;

        // Parse query params
        const status = searchParams.get("status");
        const handlerName = searchParams.get("handlerName");
        const limit = parseInt(searchParams.get("limit") || "50");
        const offset = parseInt(searchParams.get("offset") || "0");

        // Build request
        const grpcRequest: any = {
            limit,
            offset,
        };

        // Add status filter if specified
        if (status && status !== "ALL") {
            const statusNum = status === "ACTIVE" ? 1 : status === "PAUSED" ? 2 : 0;
            if (statusNum > 0) {
                grpcRequest.statuses = [statusNum];
            }
        }

        // Add handler name filter if specified
        if (handlerName) {
            grpcRequest.handler_names = [handlerName];
        }

        const response = await listSchedules(grpcRequest);

        // Transform schedules
        const schedules = response.schedules.map(transformSchedule);

        return NextResponse.json({
            schedules,
            total: response.total,
            limit,
            offset,
        });
    } catch (error: any) {
        console.error("[API] Error fetching schedules:", error);
        return NextResponse.json(
            { error: "Failed to fetch schedules", details: error.message },
            { status: 500 }
        );
    }
}

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();

        const { name, handlerName, cron, timezone, args } = body;

        if (!name || !handlerName || !cron) {
            return NextResponse.json(
                { error: "Missing required fields: name, handlerName, cron" },
                { status: 400 }
            );
        }

        const grpcRequest: any = {
            name,
            handler_name: handlerName,
            cron,
            timezone: timezone || "UTC",
        };

        if (args) {
            grpcRequest.args = Buffer.from(JSON.stringify(args));
        }

        const schedule = await createSchedule(grpcRequest);

        return NextResponse.json({
            schedule: transformSchedule(schedule),
        });
    } catch (error: any) {
        console.error("[API] Error creating schedule:", error);
        return NextResponse.json(
            { error: "Failed to create schedule", details: error.message },
            { status: 500 }
        );
    }
}
