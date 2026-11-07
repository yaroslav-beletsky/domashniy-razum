import { NextResponse } from "next/server";
import { getStats } from "@/lib/stats";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const hours = Math.min(Math.max(Number(url.searchParams.get("hours") ?? 24) || 24, 1), 24 * 30);
  return NextResponse.json(await getStats(hours));
}
