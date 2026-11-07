import { NextRequest, NextResponse } from "next/server";
import { recentEvents } from "@/lib/events";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") ?? 50) || 50, 200);
  return NextResponse.json({ events: recentEvents(limit) });
}
