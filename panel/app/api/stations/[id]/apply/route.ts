// Смена режима/модели с прогрессом. POST { mode?: "alice"|"hybrid"|"llm", model? } → SSE:
//   {type:"step", id, label, index, total} … {type:"done", pid, mode, model} | {type:"error", error}
// Операция идёт на сервере независимо от клиента: обрыв соединения её не прерывает.
import { NextRequest, NextResponse } from "next/server";
import { applyBridgeChange } from "@/lib/station";
import { normalizeMode } from "@/lib/modes";
import { idToDevice } from "@/lib/stationsStore";
import { recordEvent } from "@/lib/events";
import { appendLog } from "@/lib/logs";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const device = idToDevice(id);
  if (!device) return NextResponse.json({ ok: false, error: "колонка не найдена" }, { status: 404 });

  let body: { mode?: string; model?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
  }
  const rawMode = body.mode === undefined ? undefined : String(body.mode);
  const mode = rawMode === undefined ? undefined : normalizeMode(rawMode);
  const model = body.model === undefined ? undefined : String(body.model).trim();
  if (rawMode === undefined && model === undefined) {
    return NextResponse.json({ ok: false, error: "нужен mode или model" }, { status: 400 });
  }
  if (rawMode !== undefined && !mode) {
    return NextResponse.json({ ok: false, error: "mode должен быть alice|hybrid|llm" }, { status: 400 });
  }
  if (model !== undefined && !/^[\w./:@+~-]{1,120}$/.test(model)) {
    return NextResponse.json({ ok: false, error: "недопустимое имя модели" }, { status: 400 });
  }

  const enc = new TextEncoder();
  const what = [mode && `режим → ${mode}`, model && `модель → ${model}`].filter(Boolean).join(", ");

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (o: unknown) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
        } catch {
          /* клиент ушёл — операция всё равно доедет */
        }
      };
      appendLog("info", "station", `${device}: ${what} — старт`);
      const r = await applyBridgeChange(device, { mode, model }, (s) => send({ type: "step", ...s }));
      if (r.ok) {
        recordEvent("system", `станция ${device}: ${what}, мост healthy (PID ${r.pid})`);
        appendLog("info", "station", `${device}: ${what} — готово, PID ${r.pid}`);
        send({ type: "done", pid: r.pid, mode, model });
      } else {
        recordEvent("system", `станция ${device}: ${what} не удалось — ${r.error}`);
        appendLog("error", "station", `${device}: ${what} — ${r.error}`);
        send({ type: "error", error: r.error });
      }
      try {
        controller.close();
      } catch {
        /* ignore */
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
