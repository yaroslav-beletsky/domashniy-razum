import { NextRequest, NextResponse } from "next/server";
import { tailLogs } from "@/lib/logs";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const after = Number(req.nextUrl.searchParams.get("after") ?? 0) || 0;
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") ?? 200) || 200, 500);
  return NextResponse.json(tailLogs(after, limit));
}
