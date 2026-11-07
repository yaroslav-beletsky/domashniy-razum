import { NextResponse } from "next/server";
import { listModels } from "@/lib/litellm";

export const dynamic = "force-dynamic";

export async function GET() {
  const result = await listModels();
  if (!result.ok) {
    return NextResponse.json({ ok: false, models: [], error: result.error }, { status: 502 });
  }
  return NextResponse.json({ ok: true, models: result.models });
}
