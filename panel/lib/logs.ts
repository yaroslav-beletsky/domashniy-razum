// Логи-заглушка: кольцевой буфер + «сердцебиение», чтобы tail-вьюер жил между реальными записями.
export interface LogLine {
  seq: number;
  ts: number;
  level: "info" | "warn" | "error" | "debug";
  source: string;
  text: string;
}

const MAX_LINES = 500;
const lines: LogLine[] = [];
let logSeq = 0;
let lastBeat = 0;

export function appendLog(level: LogLine["level"], source: string, text: string): LogLine {
  const line: LogLine = { seq: ++logSeq, ts: Date.now(), level, source, text };
  lines.push(line);
  if (lines.length > MAX_LINES) lines.shift();
  return line;
}

const beats: Array<[LogLine["level"], string, string]> = [
  ["debug", "gateway[stub]", "webhook: GET /health → 200 (имитация)"],
  ["info", "gateway[stub]", "dialog: session started, new=false (имитация)"],
  ["debug", "gateway[stub]", "litellm: route → primary (имитация)"],
  ["info", "gateway[stub]", "tts: chunk 1 sent, 842 bytes (имитация)"],
  ["warn", "gateway[stub]", "dialog: latency budget 4.5s, used 62% (имитация)"],
];

export function tailLogs(after = 0, limit = 200): { lines: LogLine[]; lastSeq: number } {
  // раз в ~4 секунды добавляем строку-сердцебиение, если ничего реального не пишет
  if (Date.now() - lastBeat > 4000) {
    lastBeat = Date.now();
    const b = beats[logSeq % beats.length];
    appendLog(b[0], b[1], b[2]);
  }
  const fresh = lines.filter((l) => l.seq > after).slice(-limit);
  return { lines: fresh, lastSeq: logSeq };
}

// Стартовые строки
appendLog("info", "panel", "инициализация лог-буфера (MVP: заглушка до реального шлюза)");
appendLog("info", "panel", "tail-вьюер активен, опрос раз в 1.5 с");
appendLog("debug", "panel", "уровень debug скрыт по умолчанию в UI");
