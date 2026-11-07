// Единый клиентский парсер сырых лог-строк → человекочитаемое событие (чистая функция).
// Контракт: parseLogLine(raw, fallbackTs) → ParsedLogEvent; никогда не бросает исключений.
// Понимает JSON quasar-bridge ({"time","level","msg",…}) и belch-voice ({"event",…}),
// строки Bridge healthy / control.sh, access-логи вида `IP [date] "GET …"`, Traceback-строки.
// Форматтер вызывается из station-log (страница колонки) и /logs (общий экран).
// Серверную часть SSE не трогаем — маскирование секретов происходит там.

export type LogLevel = "info" | "warn" | "error" | "debug";

/** Группы событий. `stt`/`route`/`llm`/`tts` — «диалог»; `bridge`/`system`/`panel` — «мост/ADB». */
export type LogKind = "stt" | "route" | "llm" | "tts" | "bridge" | "system" | "panel" | "transport" | "other";

export const KIND_LABEL: Record<LogKind, string> = {
  stt: "Речь",
  route: "Маршрут",
  llm: "Ответ",
  tts: "TTS",
  bridge: "Мост",
  system: "Служебное",
  panel: "Панель",
  transport: "Транспорт",
  other: "Событие",
};

/** Категории «диалога» — для фильтра «Диалог» и визуальной связки голосового раунда. */
export const DIALOG_KINDS: LogKind[] = ["stt", "route", "llm", "tts"];

export interface ParsedLogEvent {
  /** ключ строки (для схлопывания повторов): kind|level|title */
  key: string;
  ts: number;
  level: LogLevel;
  kind: LogKind;
  /** короткий человеческий текст (1–2 строки) */
  title: string;
  /** ключевая метрика справа моноширинным («1.88 с», «PID 4821») */
  metric?: string;
  /** исходная строка как пришла (для поиска и раскрытия) */
  raw: string;
  /** распарсенный JSON, если строка была JSON-событием */
  json?: Record<string, unknown>;
  /** номер строки в SSE-потоке (для шапки раскрытия) */
  seq?: number;
  /** true — склеенная строка чужого стектрейса (рядовая разметка не нужна) */
  isStack?: boolean;
  /** id источника SSE (quasar-bridge / belch-voice / adb / panel) */
  source?: string;
}

function parseTime(v: unknown, fallback: number): number {
  if (typeof v !== "string" || !v) return fallback;
  const ms = Date.parse(v);
  // у станции могут сбрасываться часы (1970) — берём время прихода строки
  if (!Number.isFinite(ms) || ms < 946684800000) return fallback;
  return ms;
}

function normalizeLevel(v: unknown, fallback: LogLevel): LogLevel {
  const s = String(v ?? "").toUpperCase();
  if (s === "ERROR" || s === "FATAL" || s === "PANIC") return "error";
  if (s === "WARN" || s === "WARNING") return "warn";
  if (s === "DEBUG" || s === "TRACE") return "debug";
  if (s === "INFO") return "info";
  return fallback;
}

function routeLabel(route: unknown): string {
  const r = String(route ?? "");
  if (r === "llm") return "Ответит модель";
  if (r === "yandex" || r === "native") return "Передано Алисе";
  return r || "?";
}

function routeTag(route: unknown): string {
  const r = String(route ?? "");
  return r === "llm" ? "→ LLM" : r === "yandex" || r === "native" ? "→ Алиса" : "";
}

function modeLabel(mode: unknown): string {
  const m = String(mode ?? "");
  if (m === "observe") return "наблюдение";
  if (m === "hybrid") return "гибрид";
  return m || "?";
}

function secs(ms: unknown): string | undefined {
  return typeof ms === "number" && Number.isFinite(ms) ? `${(ms / 1000).toFixed(2)} с` : undefined;
}

function shortFields(o: Record<string, unknown>, skip = new Set(["time", "level", "msg", "event", "timestamp", "ts"])): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (skip.has(k)) continue;
    if (v === null || v === undefined) continue;
    const s = typeof v === "object" ? `${Array.isArray(v) ? v.length : Object.keys(v as object).length} шт.` : String(v);
    parts.push(`${k}=${s.length > 48 ? s.slice(0, 45) + "…" : s}`);
    if (parts.length >= 3) break;
  }
  return parts.join(" · ");
}

function kindFromMsg(msg: string): LogKind {
  if (msg === "frame") return "transport";
  if (msg === "listening") return "bridge";
  if (/^(asr|stt|native_asr)/i.test(msg) || msg.includes("asr_final") || msg.includes("speech")) return "stt";
  if (msg.includes("route")) return "route";
  if (/^(tts|speak|voice_play)/i.test(msg)) return "tts";
  if (/(llm|chat|completion|prompt)/i.test(msg)) return "llm";
  if (msg.startsWith("speaker_") || /subscription|ping|stat/i.test(msg)) return "system";
  if (/^(config|check|restart|control|startup|shutdown|reload)/i.test(msg)) return "bridge";
  if (msg.startsWith("native_")) return "system";
  return "other";
}

/** Человекочитаемое описание известных событий. Возвращает { title, metric? } или null. */
function describe(msg: string, o: Record<string, unknown>): { title: string; metric?: string } | null {
  // реплика пользователя: показываем текст, а не техническое имя события
  if (/^(stt|asr|native_asr)/i.test(msg) && typeof o.utterance === "string" && o.utterance.trim()) {
    return { title: `«${o.utterance.trim().slice(0, 140)}»` };
  }
  switch (msg) {
    case "listening":
      return { title: `Мост слушает ${o.address ?? "?"} · режим: ${modeLabel(o.mode)}` };
    case "routing_reloaded":
      return { title: "Правила маршрутизации перечитаны", metric: `${o.active_rules ?? o.rules ?? "?"} правил` };
    case "frame":
      return { title: `${o.event ?? "?"} ${o.direction === "client" ? "→" : "←"} облако`, metric: `${o.bytes ?? "?"} Б` };
    case "native_asr_final":
      return { title: `Речь распознана${o.code && o.code !== "OK" ? ` · код ${o.code}` : ""}` };
    case "native_route_decision": {
      const rule = typeof o.rule === "string" && o.rule !== "default_route" ? ` · правило ${o.rule}` : " · по умолчанию (default_route)";
      const via = o.source && o.source !== "default" ? ` · через ${o.source}` : "";
      return { title: `${routeLabel(o.route)}${rule}${via}`, metric: routeTag(o.route) };
    }
    case "native_route":
      return { title: o.route === "llm" ? "Ответила наша модель" : o.route === "yandex" || o.route === "native" ? "Ответила Алиса" : `Ответ по маршруту ${String(o.route ?? "?")}` };
    case "native_tts_ready":
      return { title: `Озвучка готова · ${o.format ?? "audio"}` };
    case "native_request_shape":
      return { title: o.event_type === "voice_input" ? "Поймали голосовой запрос" : `Запрос · тип ${o.event_type ?? "?"}` };
    case "native_cloud_shape": {
      const dirs = Array.isArray(o.directives) ? o.directives.length : 0;
      return { title: `Ответ облака Яндекса · карточек: ${o.cards ?? 0}, директив: ${dirs}` };
    }
    case "native_playback_status":
      return { title: o.error_class && o.error_class !== "none" ? `Воспроизведение · ошибка ${o.error_class}` : "Воспроизведение без ошибок" };
    case "native_player_state":
      return { title: `Плеер: ${o.player_state ?? "?"}` };
    case "speaker_device_subscription_state":
      return { title: `Подписка устройства: ${o.status ?? "?"}` };
    case "speaker_alice_pro_subscription_state":
      return { title: `Алиса Про: ${o.status ?? "?"}` };
    case "llm_response":
    case "llm_reply": {
      const reply = typeof o.reply === "string" && o.reply.trim() ? `«${o.reply.trim().slice(0, 140)}»` : "Ответ модели получен";
      const model = typeof o.model === "string" ? ` · ${o.model.replace(/^claude-|^openai\//, "")}` : "";
      return { title: `${reply}${model}`, metric: secs(o.latency_ms) };
    }
    case "api_ask_error":
    case "ask_error": {
      const exc = typeof o.exception === "string" ? (o.exception.trim().split("\n").filter(Boolean).pop() ?? "") : "";
      return { title: `Ошибка голосовой цепочки${exc ? `: ${exc.slice(0, 140)}` : ""}` };
    }
    default: {
      // tts_* из голосовой цепочки: «Озвучено · 39 симв.», метрика «1.43 с»
      if (/^tts_/i.test(msg) && (o.latency_ms !== undefined || o.text_len !== undefined || o.pcm_bytes !== undefined)) {
        const tail = o.text_len !== undefined ? ` · ${o.text_len} симв.` : o.pcm_bytes !== undefined ? ` · ${o.pcm_bytes} Б аудио` : "";
        return { title: `Озвучено${tail}`, metric: secs(o.latency_ms) };
      }
      if (/^(bridge|control)/i.test(msg)) return { title: msg };
      return null;
    }
  }
}

/** Строка чужого стектрейса (продолжение предыдущей ошибки)? */
export function isStackLine(text: string): boolean {
  const t = text.trimStart();
  return /^(Traceback \(most recent call last\)|File "|at [\w.$]+|\s+[~^]|During handling of|The above exception|\w*(Error|Exception)\b[:.]?)/.test(t);
}

/**
 * Парсит одну сырую строку лога. Чистая функция, не бросает исключений.
 * @param raw   сырая строка (как пришла по SSE)
 * @param fallbackTs время прихода (мс), если в строке нет своего таймстампа
 */
export function parseLogLine(raw: string, fallbackTs: number, levelFallback: LogLevel = "info", seq?: number): ParsedLogEvent {
  const clean = raw.replace(/\r$/, "");
  const trimmed = clean.trim();

  // JSON-событие quasar-bridge / belch-voice (у голосовой цепочки поле называется event)
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const o = JSON.parse(trimmed) as Record<string, unknown>;
      const lvl = normalizeLevel(o.level, levelFallback);
      const ts = parseTime(o.time ?? o.timestamp, fallbackTs);
      const msg = typeof o.msg === "string" ? o.msg : typeof o.event === "string" ? o.event : null;
      if (msg) {
        const kind = kindFromMsg(msg);
        const d = describe(msg, o);
        const title = d?.title ?? (shortFields(o) ? `${msg} · ${shortFields(o)}` : msg);
        return { key: `${kind}|${lvl}|${title}`, ts, level: lvl, kind, title, metric: d?.metric, raw: clean, json: o, seq };
      }
      // неизвестный JSON — не ломаемся: заголовок из доступных ключей + до 3 полей подписью
      const title = typeof o.detail === "string" && o.detail ? o.detail : typeof o.message === "string" && o.message ? o.message : "JSON-событие";
      const sub = shortFields(o);
      return {
        key: `other|${lvl}|${title}|${sub}`,
        ts,
        level: lvl,
        kind: "other",
        title: sub ? `${title} · ${sub}` : title,
        raw: clean,
        json: o,
        seq,
      };
    } catch {
      /* не JSON — покажем как текст */
    }
  }

  // «Bridge healthy (PID 4821)»
  const healthy = /^Bridge healthy \(PID (\d+)\)/.exec(trimmed);
  if (healthy) {
    return { key: `bridge|info|Мост в норме`, ts: fallbackTs, level: "info", kind: "bridge", title: "Мост в норме", metric: `PID ${healthy[1]}`, raw: clean, seq };
  }

  // access-лог nginx/uvicorn: 127.0.0.1 [07/Nov/2026:00:39:02 +0300] "GET /api/health HTTP/1.1" 200 358
  const access = /^[\w.:]+ \[([^\]]+)\] "(\w+) ([^ ]+) [^"]*" (\d{3})\b/.exec(trimmed);
  if (access) {
    const ts = parseTime(access[1].replace(":", "T"), fallbackTs); // 07/Nov/2026:00:39:02 → дата не парсится, fallback
    const ok = access[4][0] === "2" || access[4][0] === "3";
    return {
      key: `system|${ok ? "debug" : "warn"}|${access[2]} ${access[3]}|${access[4]}`,
      ts,
      level: ok ? "debug" : "warn",
      kind: "system",
      title: `Проверка ${access[3]} → ${access[4]}`,
      raw: clean,
      seq,
    };
  }

  // продолжение стектрейса (пришло отдельной строкой без своего таймстампа)
  if (isStackLine(trimmed)) {
    return { key: `stack|${trimmed.slice(0, 120)}`, ts: fallbackTs, level: "error", kind: "other", title: trimmed.slice(0, 160), raw: clean, seq, isStack: true };
  }

  // локальные шаги панели и прочий текст (belch-voice, control.sh)
  const kind = trimmed.startsWith("[панель]") ? "panel" : /quasar-bridge|control\.sh/i.test(trimmed) ? "bridge" : "other";
  return { key: `${kind}|${levelFallback}|${trimmed.slice(0, 120)}`, ts: fallbackTs, level: levelFallback, kind, title: trimmed.slice(0, 300), raw: clean, seq };
}

/** Pretty-JSON (с подсветкой вызывающий рендерит) или исходный текст для раскрытой строки. */
export function prettyRaw(e: ParsedLogEvent): string {
  if (e.json) {
    try {
      return JSON.stringify(e.json, null, 2);
    } catch {
      /* не бывает — распарсили через JSON.parse */
    }
  }
  return e.raw;
}

// ---------------------------------------------------------------------------
// Синтаксическая подсветка pretty-JSON: разбивает строку на токены.
export interface JsonToken {
  text: string;
  cls?: string; // text-zinc-400 | text-emerald-300 | text-amber-300 | text-sky-300 …
}

const JSON_LINE_RE = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

/** Подсвеченный рендер JSON.stringify(obj, null, 2) по строкам (короткие строки рендерятся целиком). */
export function highlightJson(text: string): JsonToken[] {
  const out: JsonToken[] = [];
  let last = 0;
  for (const m of text.matchAll(JSON_LINE_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ text: text.slice(last, idx) });
    const [, str, colon, bool, num] = m;
    if (str !== undefined) {
      out.push(colon ? { text: str, cls: "text-sky-300" } : { text: str, cls: "text-emerald-300" });
    } else if (bool !== undefined) {
      out.push({ text: bool, cls: "text-amber-300" });
    } else if (num !== undefined) {
      out.push({ text: num, cls: "text-amber-300" });
    }
    last = idx + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}
