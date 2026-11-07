// Live-логи по SSE: GET /api/logs/stream?source=belch-voice|quasar-bridge|adb|panel
// - нет source / неизвестный id → одно событие offline и закрытие (панель не падает);
//  - маскируем секреты; heartbeat каждые 15 с; клиент держит автореконнект.
import { getSource, maskSecrets, type LogLevel } from "@/lib/logSources";
import { idToDevice } from "@/lib/stationsStore";

export const dynamic = "force-dynamic";

const enc = new TextEncoder();

function sseEvent(payload: unknown): Uint8Array {
  return enc.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

function guessLevel(line: string): LogLevel {
  if (/\b(error|fatal|panic|failed|failure)\b/i.test(line)) return "error";
  if (/\b(warn|warning)\b/i.test(line)) return "warn";
  if (/\b(debug|trace)\b/i.test(line)) return "debug";
  return "info";
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const sourceId = url.searchParams.get("source");
  const stationId = url.searchParams.get("station");
  const device = stationId ? idToDevice(stationId) : null;
  const source = stationId && !device ? null : getSource(sourceId, device ?? undefined);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let seq = 0;
      const send = (obj: unknown) => {
        try {
          controller.enqueue(sseEvent(obj));
        } catch {
          /* закрыт */
        }
      };

      if (!source) {
        send({
          type: "offline",
          ts: Date.now(),
          detail: stationId && !device ? `неизвестная колонка: ${stationId}` : sourceId ? `неизвестный источник: ${sourceId}` : "источник не выбран",
        });
        try {
          controller.close();
        } catch {
          /* ignore */
        }
        return;
      }

      const heartbeat = setInterval(() => send({ type: "heartbeat", ts: Date.now() }), 15000);
      const stopHooks: Array<() => void> = [];
      const cleanup = () => {
        clearInterval(heartbeat);
        for (const s of stopHooks) {
          try {
            s();
          } catch {
            /* ignore */
          }
        }
      };
      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      });

      // статус источника
      const st = await source.online();
      send({ type: "status", ts: Date.now(), source: source.id, online: st.ok, detail: st.detail });

      // стартовый хвост
      const tail = await source.tail();
      for (const line of tail.slice(-100)) {
        send({ type: "line", ts: Date.now(), source: source.id, seq: ++seq, level: guessLevel(line), text: maskSecrets(line) });
      }
      if (!st.ok) {
        send({ type: "note", ts: Date.now(), text: `источник offline: ${st.detail ?? ""} — автореконнект активен` });
      }

      // live-подписка
      try {
        const maybeStop = await source.subscribe((raw) => {
          const line = maskSecrets(raw);
          send({ type: "line", ts: Date.now(), source: source.id, seq: ++seq, level: guessLevel(line), text: line });
        });
        stopHooks.push(typeof maybeStop === "function" ? maybeStop : () => {});
      } catch {
        send({ type: "note", ts: Date.now(), text: "подписка не удалась — автореконнект активен" });
      }
    },
    cancel() {
      /* abort-обработчик выше всё чистит */
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
