import { NextRequest, NextResponse } from "next/server";
import { setBridgeModel } from "@/lib/station";
import { recordEvent } from "@/lib/events";
import { appendLog } from "@/lib/logs";

export const dynamic = "force-dynamic";

/** Смена модели: QUASAR_LLM_MODEL в runtime.env + control.sh restart. */
export async function POST(req: NextRequest) {
  let model = "";
  try {
    const body = (await req.json()) as { model?: string };
    model = String(body.model ?? "").trim();
  } catch {
    return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
  }
  if (!model) {
    return NextResponse.json({ ok: false, error: "model не задана" }, { status: 400 });
  }

  const r = await setBridgeModel(model);
  if (!r.ok) {
    recordEvent("system", `станция: смена модели на ${model} не удалась — ${r.error}`);
    appendLog("error", "station", `set model=${model} failed: ${r.error}`);
    return NextResponse.json({ ok: false, error: r.error }, { status: 502 });
  }
  recordEvent("system", `станция: модель → ${model} (restart моста)`);
  appendLog("info", "station", `model set to ${model}, bridge restarted`);
  return NextResponse.json({ ok: true, model });
}
