import { NextRequest, NextResponse } from "next/server";
import { resumeSchedule, scheduleStatusToString, type Schedule as GrpcSchedule } from "@/lib/grpc-client";

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

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params;
        const schedule = await resumeSchedule(id);

        return NextResponse.json({
            success: true,
            schedule: transformSchedule(schedule),
        });
    } catch (error: any) {
        console.error("[API] Error resuming schedule:", error);
        return NextResponse.json(
            { success: false, error: "Failed to resume schedule", details: error.message },
            { status: 500 }
        );
    }
}
