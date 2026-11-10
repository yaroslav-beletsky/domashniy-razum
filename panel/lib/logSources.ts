// Источники живых логов для /api/logs/stream (SSE).
// Каждый источник умеет: стартовый хвост + подписку на новые строки.
// Отсутствие источника/файла — штатный «offline», без исключений наружу.
import fs from "node:fs";
import path from "node:path";
import { adbShellStream, firstDevice } from "./adb";
import { agentFetch } from "./agentApi";
import { config } from "./config";
import { sshLogFollow, sshLogTail } from "./logSsh";
import { bridgeLogTail } from "./station";
import { appendLog, tailLogs, type LogLine } from "./logs";

export type LogLevel = LogLine["level"];

export interface LiveSource {
  id: string;
  label: string;
  online: () => Promise<{ ok: boolean; detail?: string }>;
  tail: () => Promise<string[]>;
  subscribe: (onLine: (line: string) => void) => Promise<() => void> | (() => void);
}

// ---------------------------------------------------------------------------
// маскирование секретов: токены, ключи, base64-болванки, Authorization
const SECRET_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._\-]{8,}/gi,
  /sk-[A-Za-z0-9_\-]{6,}/g,
  /\b(?:api[_-]?key|token|secret|password)(["'\s:=]+)[A-Za-z0-9._\-\/+=]{8,}/gi,
  /\beyJ[A-Za-z0-9._\-]{10,}/g, // JWT
];

export function maskSecrets(line: string): string {
  let out = line;
  for (const re of SECRET_PATTERNS) out = out.replace(re, (m) => m.slice(0, 12) + "…[masked]");
  return out;
}

// ---------------------------------------------------------------------------
function stripAnsi(s: string): string {
  return s.replace(/\[[0-9;]*m/g, "");
}

/** Подписка на обновления локального файла через fs.watch (read-only mount). */
function watchFileLines(file: string, onLine: (line: string) => void): () => void {
  let lastSize = 0;
  try {
    lastSize = fs.statSync(file).size;
  } catch {
    lastSize = 0;
  }
  const readNew = () => {
    try {
      const st = fs.statSync(file);
      if (st.size < lastSize) lastSize = 0; // ротация
      if (st.size === lastSize) return;
      const fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(st.size - lastSize);
      fs.readSync(fd, buf, 0, buf.length, lastSize);
      fs.closeSync(fd);
      lastSize = st.size;
      for (const line of buf.toString("utf8").split("\n")) {
        if (line.trim()) onLine(stripAnsi(line));
      }
    } catch {
      /* файл исчез/ротирован — молчим до следующего тика */
    }
  };
  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(file, () => readNew());
  } catch {
    /* нет файла — опросим ниже */
  }
  const poller = setInterval(readNew, 2000);
  return () => {
    watcher?.close();
    clearInterval(poller);
  };
}

/** Поиск самого свежего *.log (или заданного имени) в каталоге. */
function newestLogFile(dir: string, fixed?: string): string | null {
  try {
    if (fixed) {
      const p = path.join(dir, fixed);
      return fs.existsSync(p) ? p : null;
    }
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".log"))
      .map((f) => {
        try {
          return { f, m: fs.statSync(path.join(dir, f)).mtimeMs };
        } catch {
          return { f, m: 0 };
        }
      })
      .sort((a, b) => b.m - a.m);
    return files.length ? path.join(dir, files[0].f) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Стенд lite-kit (eQuasar Server) на .23: тот же ssh-транспорт, что и belch-voice,
// только путь к логу другой. follow стартует с -n 0: хвост уже отдан через tail().
// Если SSH недоступен (например на локальном хосте без ключа) — fallback на локальный
// файл /logs/lite-kit/server.log (монтируется docker-compose'ом).
const STAND_LOG_LOCAL = "/logs/lite-kit/server.log";

function standLogLocalTail(n: number): string[] {
  try {
    if (!fs.existsSync(STAND_LOG_LOCAL)) return [];
    const all = fs.readFileSync(STAND_LOG_LOCAL, "utf8").split("\n").filter((l) => l.trim());
    return all.slice(-n);
  } catch {
    return [];
  }
}

const standSource: LiveSource = {
  id: "stand",
  label: "Стенд · lite-kit (.23)",
  online: async () => {
    const lines = await sshLogTail(1, config.standLogSshPath);
    if (lines.length) return { ok: true, detail: `ssh:${config.voiceLogSshTarget} ${config.standLogSshPath}` };
    const local = standLogLocalTail(1);
    if (local.length) return { ok: true, detail: STAND_LOG_LOCAL };
    return { ok: false, detail: `ssh недоступен и ${STAND_LOG_LOCAL} не найден` };
  },
  tail: async () => {
    const lines = await sshLogTail(100, config.standLogSshPath);
    if (lines.length) return lines;
    return standLogLocalTail(100);
  },
  subscribe: (onLine) => {
    // SSH + локальный fallback параллельно — строки пойдут из любого живого источника.
    const stopSsh = sshLogFollow(onLine, { file: config.standLogSshPath, from: 0 }).stop;
    const stopLocal = watchFileLines(STAND_LOG_LOCAL, onLine);
    return () => { stopSsh(); stopLocal(); };
  },
};

// ---------------------------------------------------------------------------
// Агент: лента audit-событий agent-service (agent.run / proxy / tool.call / llm.*)
// через готовый GET /admin/audit — опрос раз в 2 с, без новых зависимостей и маунтов.
// Строки отдаём как JSON {"time","level","msg",…} — клиентский парсер покажет их событиями.
interface AuditRow {
  id: number;
  ts: number;
  station_id: number | null;
  agent_id: number | null;
  event: string;
  meta: string | null;
}

function auditLevel(event: string): LogLevel {
  if (/error$/.test(event)) return "error";
  if (/fallback|empty|give_up/.test(event)) return "warn";
  return "info";
}

function auditLine(r: AuditRow): string {
  let meta: Record<string, unknown> = {};
  try {
    meta = r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : {};
  } catch {
    /* битый meta показываем как есть */
  }
  const o: Record<string, unknown> = { time: new Date(r.ts).toISOString(), level: auditLevel(r.event), msg: r.event, ...meta };
  if (r.station_id !== null && r.station_id !== undefined) o.station = r.station_id;
  return JSON.stringify(o);
}

async function fetchAudit(limit: number): Promise<AuditRow[] | null> {
  const res = await agentFetch<AuditRow[]>(`/audit?limit=${limit}`, { timeoutMs: 6000 });
  return res.ok && Array.isArray(res.data) ? res.data : null;
}

/** Курсор аудита: tail() ставит последний отданный id, подписка дальше отдаёт только свежее. */
let agentLastAuditId = 0;

const agentSource: LiveSource = {
  id: "agent",
  label: "Агент · agent-service (audit)",
  online: async () => {
    const rows = await fetchAudit(1);
    return rows ? { ok: true, detail: `${config.agentServiceUrl}/admin/audit` } : { ok: false, detail: "agent-service недоступен или токен не задан" };
  },
  tail: async () => {
    const rows = await fetchAudit(100);
    if (!rows) return [];
    rows.sort((a, b) => a.id - b.id);
    agentLastAuditId = rows.length ? rows[rows.length - 1].id : agentLastAuditId;
    return rows.map(auditLine);
  },
  subscribe: (onLine) => {
    const timer = setInterval(async () => {
      const rows = await fetchAudit(100);
      if (!rows) return;
      const fresh = rows.filter((r) => r.id > agentLastAuditId).sort((a, b) => a.id - b.id);
      for (const r of rows) if (r.id > agentLastAuditId) agentLastAuditId = r.id;
      for (const r of fresh) onLine(auditLine(r));
    }, 2000);
    return () => clearInterval(timer);
  },
};

// belch-voice: лог живёт на другом Mac (.23) — читаем по ssh (tail / tail -f),
// read-only. Локальный каталог (если смонтирован) — запасной вариант.
const belchSource: LiveSource = {
  id: "belch-voice",
  label: "belch-voice (STT/TTS)",
  online: async () => {
    const lines = await sshLogTail(1);
    if (lines.length) return { ok: true, detail: `ssh:${config.voiceLogSshTarget}` };
    const f = newestLogFile(config.belchLogDir);
    if (f) return { ok: true, detail: f };
    return { ok: false, detail: `ssh недоступен и ${config.belchLogDir} пуст` };
  },
  tail: async () => {
    const lines = await sshLogTail(100);
    if (lines.length) return lines;
    const f = newestLogFile(config.belchLogDir);
    if (!f) return [];
    try {
      const all = fs.readFileSync(f, "utf8").split("\n").filter((l) => l.trim());
      return all.slice(-100);
    } catch {
      return [];
    }
  },
  subscribe: async (onLine) => {
    const stops: Array<() => void> = [sshLogFollow(onLine).stop];
    const f = newestLogFile(config.belchLogDir);
    if (f) stops.push(watchFileLines(f, onLine));
    return () => stops.forEach((s) => s());
  },
};

// quasar-bridge: живёт на станции; локальный mirror-файл (если смонтирован)
// плюс докидываем adb tail. Если файла нет — тянем только adb-хвост по опросу.
function makeQuasarSource(device: string): LiveSource {
  const primary = device === firstDevice();
  return {
  id: "quasar-bridge",
  label: "quasar-bridge (мост колонки)",
  online: async () => {
    const local = primary ? newestLogFile(config.quasarDataDir, "service.log") : null;
    const tail = await bridgeLogTail(3, device);
    if (local) return { ok: true, detail: local };
    if (tail.length) return { ok: true, detail: "adb:service.log" };
    return { ok: false, detail: "станция offline и mirror не смонтирован" };
  },
  tail: async () => {
    const local = primary ? newestLogFile(config.quasarDataDir, "service.log") : null;
    let lines: string[] = [];
    if (local) {
      try {
        lines = fs.readFileSync(local, "utf8").split("\n").filter((l) => l.trim()).slice(-100);
      } catch {
        lines = [];
      }
    }
    if (lines.length === 0) lines = await bridgeLogTail(100, device);
    return lines;
  },
  subscribe: async (onLine) => {
    const local = primary ? newestLogFile(config.quasarDataDir, "service.log") : null;
    const stops: Array<() => void> = [];
    if (local) stops.push(watchFileLines(local, onLine));
    // Дополнительно — adb streaming tail -f (покрывает случай без mirror-маунта)
    const stream = adbShellStream("tail -n 0 -f /data/opt/quasar-bridge/service.log 2>/dev/null", (l) => {
      if (l.trim()) onLine(stripAnsi(l));
    }, device);
    stops.push(stream.stop);
    return () => stops.forEach((s) => s());
  },
  };
}

// adb-источник: потоковый tail -f лога моста напрямую со станции.
function makeAdbSource(device: string): LiveSource {
  return {
    id: "adb",
    label: "adb · лог станции (service.log, tail -f)",
    online: async () => {
      const t = await bridgeLogTail(1, device);
      return t.length ? { ok: true, detail: "tail -f через adb" } : { ok: false, detail: "станция не отвечает" };
    },
    tail: async () => bridgeLogTail(100, device),
    subscribe: async (onLine) =>
      adbShellStream(
        "tail -n 100 -f /data/opt/quasar-bridge/service.log 2>/dev/null",
        (l) => {
          if (l.trim()) onLine(stripAnsi(l));
        },
        device,
      ).stop,
  };
}

// panel: кольцевой буфер панели (heartbeat), как раньше — через опрос.
const panelSource: LiveSource = {
  id: "panel",
  label: "panel (события панели)",
  online: async () => ({ ok: true, detail: "in-memory" }),
  tail: async () => tailLogs(0, 100).lines.map((l) => `${new Date(l.ts).toISOString()} [${l.level}] ${l.source}: ${l.text}`),
  subscribe: async (onLine) => {
    let last = 0;
    const t = setInterval(() => {
      const { lines, lastSeq } = tailLogs(last, 100);
      last = lastSeq;
      for (const l of lines) onLine(`${new Date(l.ts).toISOString()} [${l.level}] ${l.source}: ${l.text}`);
    }, 1500);
    return () => clearInterval(t);
  },
};

export const LOG_SOURCES: LiveSource[] = [standSource, agentSource, belchSource, makeQuasarSource(firstDevice()), makeAdbSource(firstDevice()), panelSource];

/** device — только из реестра колонок (проверяет вызывающий); без него — основная колонка. */
export function getSource(id: string | null, device?: string): LiveSource | null {
  if (!id) return null;
  if (device && device !== firstDevice()) {
    if (id === "quasar-bridge") return makeQuasarSource(device);
    if (id === "adb") return makeAdbSource(device);
  }
  return LOG_SOURCES.find((s) => s.id === id) ?? null;
}

/** Записать событие в panel-буфер (чтобы подписчики panel-источника увидели). */
export function notePanelLog(level: LogLevel, text: string): void {
  appendLog(level, "panel", text);
}