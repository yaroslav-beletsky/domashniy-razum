import { NextResponse } from "next/server";
import { stationStatus } from "@/lib/station";
import { listModels } from "@/lib/litellm";

export const dynamic = "force-dynamic";

export async function GET() {
  const [station, models] = await Promise.all([stationStatus(), listModels(6000)]);
  return NextResponse.json({
    station,
    models: models.ok ? models.models.map((m) => m.id) : [],
    modelsError: models.ok ? undefined : models.error,
  });
}
