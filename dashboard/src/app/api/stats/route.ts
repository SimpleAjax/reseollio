import { NextResponse } from "next/server";
import { getStats } from "@/lib/grpc-client";

export async function GET() {
    try {
        const stats = await getStats();
        return NextResponse.json(stats);
    } catch (error: any) {
        console.error("[API] Error fetching stats:", error);
        return NextResponse.json(
            { error: "Failed to fetch stats", details: error.message },
            { status: 500 }
        );
    }
}
