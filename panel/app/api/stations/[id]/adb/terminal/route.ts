// GET /api/stations/[id]/adb/terminal — SSE-поток вывода интерактивного adb shell.
// События: data: {"t":"o","d":"<chunk>"} (вывод pty), {"t":"ping"} — keep-alive каждые 15 с.
// Переподключение — штатный автореконнект EventSource; на сервере сессия живёт GRACE_MS после обрыва.
import { NextResponse } from "next/server";
import { terminalAttach } from "@/lib/adbTerminal";
import { idToDevice } from "@/lib/stationsStore";

export const dynamic = "force-dynamic";

const enc = new TextEncoder();

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const device = idToDevice(id);
  if (!device) return NextResponse.json({ ok: false, error: "колонка не найдена" }, { status: 404 });

  // очистку вызывают три пути: abort сигнала, cancel() стрима (клиент отключился —
  // основной), падение enqueue на отменённом стриме. Все идемпотентны через closed.
  let cleanup: () => void = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (obj: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          cleanup();
        }
      };
      const detach = terminalAttach(device, (chunk) => send({ t: "o", d: chunk }));
      const heartbeat = setInterval(() => send({ t: "ping" }), 15000);
      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        detach();
        try {
          controller.close();
        } catch {
          /* уже закрыт */
        }
      };
      req.signal.addEventListener("abort", cleanup);
    },
    cancel() {
      cleanup();
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
