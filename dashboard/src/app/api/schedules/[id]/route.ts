import { NextRequest, NextResponse } from "next/server";
import {
    getSchedule,
    updateSchedule,
    deleteSchedule,
    scheduleStatusToString,
    type Schedule as GrpcSchedule,
} from "@/lib/grpc-client";

// Transform gRPC schedule to API response format
function transformSchedule(schedule: GrpcSchedule) {
    const parseTimestamp = (ts: string | number): number => {
        const num = typeof ts === "string" ? parseInt(ts, 10) : ts;
        if (!num || isNaN(num)) return Date.now();
        if (num < 100000000000) {
            return num * 1000;
        }
        return num;
    };

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

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params;
        const schedule = await getSchedule(id);

        return NextResponse.json(transformSchedule(schedule));
    } catch (error: any) {
        console.error("[API] Error fetching schedule:", error);
        return NextResponse.json(
            { error: "Failed to fetch schedule", details: error.message },
            { status: 500 }
        );
    }
}

export async function PATCH(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params;
        const body = await request.json();

        const grpcRequest: any = {
            schedule_id: id,
        };

        if (body.cron !== undefined) {
            grpcRequest.cron = body.cron;
        }
        if (body.timezone !== undefined) {
            grpcRequest.timezone = body.timezone;
        }
        if (body.args !== undefined) {
            grpcRequest.args = Buffer.from(JSON.stringify(body.args));
        }

        const schedule = await updateSchedule(grpcRequest);

        return NextResponse.json(transformSchedule(schedule));
    } catch (error: any) {
        console.error("[API] Error updating schedule:", error);
        return NextResponse.json(
            { error: "Failed to update schedule", details: error.message },
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
        const response = await deleteSchedule(id);

        return NextResponse.json({
            success: response.success,
            message: response.message || "Schedule deleted successfully",
        });
    } catch (error: any) {
        console.error("[API] Error deleting schedule:", error);
        return NextResponse.json(
            { error: "Failed to delete schedule", details: error.message },
            { status: 500 }
        );
    }
}
