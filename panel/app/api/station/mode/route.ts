import { NextRequest, NextResponse } from "next/server";
import { setBridgeMode } from "@/lib/station";
import { normalizeMode } from "@/lib/modes";
import { recordEvent } from "@/lib/events";
import { appendLog } from "@/lib/logs";

export const dynamic = "force-dynamic";

/** Переключение режима колонки: alice | hybrid | llm (observe = alice для совместимости). runtime.env + config.json + control.sh restart (~10–15 с). */
export async function POST(req: NextRequest) {
  let mode = "";
  try {
    const body = (await req.json()) as { mode?: string };
    mode = String(body.mode ?? "");
  } catch {
    return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
  }
  const pm = normalizeMode(mode);
  if (!pm) {
    return NextResponse.json({ ok: false, error: "mode должен быть alice|hybrid|llm" }, { status: 400 });
  }

  const r = await setBridgeMode(pm);
  if (!r.ok) {
    recordEvent("system", `станция: смена режима на ${mode} не удалась — ${r.error}`);
    appendLog("error", "station", `set mode=${mode} failed: ${r.error}`);
    return NextResponse.json({ ok: false, error: r.error }, { status: 502 });
  }
  recordEvent("system", `станция: режим моста → ${mode} (restart моста)`);
  appendLog("info", "station", `mode set to ${mode} via restart`);
  return NextResponse.json({ ok: true, mode: pm });
}
