// Общие хелперы route-handlers раздела «Агенты».
import { NextResponse } from "next/server";
import type { AgentCall } from "./agentApi";
import type { BindStepId } from "./station";

/** Ответ панели из результата agent-service: {ok:true,…data} или {ok:false,error} с исходным кодом. */
export function respond<T>(r: AgentCall<T>, map?: (d: T) => Record<string, unknown>) {
  if (!r.ok) {
    const conflict = r.status === 409 ? { conflict: true, version: (r.data as { error?: { version?: number } } | undefined)?.error?.version } : {};
    return NextResponse.json({ ok: false, error: r.error, ...conflict }, { status: r.status >= 400 ? r.status : 502 });
  }
  return NextResponse.json({ ok: true, ...(map ? map(r.data as T) : { data: r.data }) });
}

export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const j = await req.json();
    return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const badJson = () => NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
export const notFound = (what = "не найдено") => NextResponse.json({ ok: false, error: what }, { status: 404 });

export const BIND_LABELS: Record<BindStepId, string> = {
  key: "Готовим ключ колонки",
  write: "Записываем настройки",
  check: "Проверяем конфигурацию",
  restart: "Перезапускаем мост",
  wait: "Ждём, пока мост оживёт",
};
export function sse(run: (send: (o: unknown) => void) => Promise<void>) {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (o: unknown) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
        } catch {
          /* клиент ушёл — операция всё равно доедет */
        }
      };
      await run(send);
      try {
        controller.close();
      } catch {
        /* ignore */
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
  });
}

