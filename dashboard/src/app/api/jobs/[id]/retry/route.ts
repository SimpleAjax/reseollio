import { NextRequest, NextResponse } from "next/server";
import { retryJob } from "@/lib/grpc-client";

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params;
        const response = await retryJob(id);

        if (response.success) {
            return NextResponse.json({ success: true, message: "Job reset to pending" });
        } else {
            return NextResponse.json(
                { success: false, message: response.message || "Failed to retry job" },
                { status: 400 }
            );
        }
    } catch (error: any) {
        console.error("[API] Error retrying job:", error);
        return NextResponse.json(
            { error: "Failed to retry job", details: error.message },
            { status: 500 }
        );
    }
}
