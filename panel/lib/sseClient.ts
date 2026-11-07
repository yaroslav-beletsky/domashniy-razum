// POST + разбор SSE в браузере. Понимает и `event: x\ndata: {…}` (agent-service), и только `data: {…}` (панель).
export interface SseMessage {
  event?: string;
  data: Record<string, unknown>;
}

export async function postSse(
  url: string,
  body: unknown,
  onMessage: (m: SseMessage) => void,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; error?: string }> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!r.ok || !r.body) {
    const j = await r.json().catch(() => ({}));
    return { ok: false, status: r.status, error: (j as { error?: string }).error ?? `ошибка ${r.status}` };
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event: string | undefined;
      let data = "";
      for (const l of chunk.split("\n")) {
        if (l.startsWith("event: ")) event = l.slice(7).trim();
        else if (l.startsWith("data: ")) data += l.slice(6);
      }
      if (!data) continue;
      try {
        onMessage({ event, data: JSON.parse(data) });
      } catch {
        /* битый кусок пропускаем */
      }
    }
  }
  return { ok: true, status: r.status };
}

/** Сводка вызова JSON-API панели: {ok:false,error} → бросаем читаемую ошибку. */
export async function api<T = Record<string, unknown>>(
  url: string,
  init?: { method?: string; body?: unknown },
): Promise<T & { ok: true }> {
  const r = await fetch(url, {
    method: init?.method ?? "GET",
    headers: init?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; conflict?: boolean };
  if (!r.ok || j.ok === false) {
    const err = new Error(j.error ?? `ошибка ${r.status}`) as Error & { status?: number; conflict?: boolean };
    err.status = r.status;
    err.conflict = j.conflict;
    throw err;
  }
  return j as T & { ok: true };
}
