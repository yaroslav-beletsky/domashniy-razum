// Лента событий панели: кольцевой буфер в памяти (MVP, один инстанс контейнера).
export interface PanelEvent {
  id: number;
  ts: number;
  kind: "system" | "litellm" | "model-test" | "voice" | "security";
  text: string;
}

const MAX_EVENTS = 300;
const events: PanelEvent[] = [];
let seq = 0;

const counters: Record<string, number> = {
  "model-test": 0,
  voice: 0,
  litellm: 0,
};

export function recordEvent(kind: PanelEvent["kind"], text: string): PanelEvent {
  const ev: PanelEvent = { id: ++seq, ts: Date.now(), kind, text };
  events.push(ev);
  if (events.length > MAX_EVENTS) events.shift();
  if (kind in counters) counters[kind] += 1;
  return ev;
}

export function recentEvents(limit = 50): PanelEvent[] {
  return events.slice(-limit).reverse();
}

export function eventCounters(): Record<string, number> {
  return { ...counters, total: seq };
}

// Стартовые события-заглушки: пока шлюз навыка не пишет реальные события.
recordEvent("system", "панель station-llm запущена");
recordEvent("system", "лента событий — заглушка, реальные события появятся с шлюзом навыка");
recordEvent("security", "ключ LiteLLM читается только на сервере, в UI не отдаётся");
