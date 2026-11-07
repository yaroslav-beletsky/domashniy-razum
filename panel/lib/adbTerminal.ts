// Интерактивные adb shell-сессии для веб-терминала (xterm.js на клиенте).
// Транспорт: SSE (вывод, server→client) + POST (ввод, client→server) — WS в панели нет,
// SSE-инфраструктура уже есть (logs/stream), проще и надёжнее чем тянуть ttyd/gotty.
// Одна долгоживущая сессия на колонку: spawn `adb -s <serial> shell -tt` — adb сам
// поднимает pty на устройстве (промпт, эхо, backspace). -tt обязателен: без него,
// когда stdin — pipe (как из Node), adb не выделяет pty и терминал не работает.
import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { adbEnsureConnected } from "./adb";
import { config } from "./config";

const BACKLOG_MAX = 96 * 1024; // хвост вывода, который получит переподключившийся клиент
const GRACE_MS = 15_000; // SSE закрылся → столько ждём переподключения (мобильный, лифт), потом убиваем процесс

interface TermSession {
  device: string;
  child: ChildProcess | null;
  spawning: Promise<void> | null;
  backlog: string;
  subscribers: Set<(chunk: string) => void>;
  grace: ReturnType<typeof setTimeout> | null;
}

const sessions = new Map<string, TermSession>(); // key: device serial

function adbEnv(): NodeJS.ProcessEnv {
  return { ...process.env, HOME: config.adbHome, ANDROID_SDK_HOME: config.adbHome };
}

function get(device: string): TermSession {
  let s = sessions.get(device);
  if (!s) {
    s = { device, child: null, spawning: null, backlog: "", subscribers: new Set(), grace: null };
    sessions.set(device, s);
  }
  return s;
}

function kill(session: TermSession): void {
  if (session.grace) {
    clearTimeout(session.grace);
    session.grace = null;
  }
  const child = session.child;
  session.child = null;
  if (child) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* уже мёртв */
    }
  }
}

function note(session: TermSession, text: string): void {
  const line = `\r\n\x1b[2m${text}\x1b[0m\r\n`;
  session.backlog = `${(session.backlog + line).slice(-BACKLOG_MAX)}`;
  for (const sub of session.subscribers) {
    try {
      sub(line);
    } catch {
      /* ignore */
    }
  }
}

async function spawnShell(session: TermSession): Promise<void> {
  if (session.spawning) return session.spawning;
  session.spawning = (async () => {
    try {
      await adbEnsureConnected(session.device, true); // после простоя колонка могла отвалиться
    } catch {
      /* connect может упасть — spawn всё равно попробуем, stderr покажет причину */
    }
    if (session.child) return; // кто-то успел спавнить параллельно
    const child = spawn(config.adbPath, ["-s", session.device, "shell", "-tt"], {
      env: adbEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    session.child = child;
    const decOut = new StringDecoder("utf8");
    const decErr = new StringDecoder("utf8");
    const push = (chunk: string) => {
      session.backlog = `${(session.backlog + chunk).slice(-BACKLOG_MAX)}`;
      for (const sub of session.subscribers) {
        try {
          sub(chunk);
        } catch {
          /* ignore */
        }
      }
    };
    child.stdout?.on("data", (d: Buffer) => push(decOut.write(d)));
    // stderr у shell -tt почти пустой (pty забирает вывод устройства), но обрывать связь молча нельзя
    child.stderr?.on("data", (d: Buffer) => {
      const t = decErr.write(d).trim();
      if (t) push(`\r\n\x1b[31m${t.slice(0, 300)}\x1b[0m\r\n`);
    });
    child.on("error", (e) => {
      if (session.child === child) session.child = null;
      note(session, `adb не запущен: ${e.message.slice(0, 160)}`);
    });
    child.on("close", (code, signal) => {
      if (session.child !== child) return; // убили осознанно (kill()) — тишина
      session.child = null;
      note(session, signal ? "сессия прервана — подключаемся заново…" : `shell завершён (code ${code ?? "?"}) — подключаемся заново…`);
    });
  })();
  try {
    await session.spawning;
  } finally {
    session.spawning = null;
  }
}

/** Подписаться на вывод: живой поток + хвост backlog. Возвращает отписку. */
export function terminalAttach(device: string, onChunk: (chunk: string) => void): () => void {
  const session = get(device);
  if (session.grace) {
    clearTimeout(session.grace); // переподключились в пределах льготного окна — та же сессия
    session.grace = null;
  }
  session.subscribers.add(onChunk);
  const backlog = session.backlog;
  if (backlog) onChunk(backlog);
  void spawnShell(session);
  return () => {
    session.subscribers.delete(onChunk);
    if (session.subscribers.size === 0 && !session.grace) {
      // все ушли: даём GRACE_MS на переподключение (мобильный браузер рвёт SSE при блокировке экрана),
      // потом прибиваем adb — свежее открытие терминала начнёт чистую сессию
      session.grace = setTimeout(() => {
        session.grace = null;
        session.backlog = "";
        kill(session);
        sessions.delete(device);
      }, GRACE_MS);
    }
  };
}

/** Отправить ввод (нажатия/вставка) в shell. Если процесс умер — поднимем новый. */
export async function terminalWrite(device: string, data: string): Promise<boolean> {
  const session = get(device);
  if (session.grace) {
    clearTimeout(session.grace);
    session.grace = null;
  }
  if (!session.child) await spawnShell(session);
  const child = session.child;
  if (!child?.stdin?.writable) return false;
  let written = false;
  try {
    child.stdin.write(data);
    written = true;
  } catch {
    /* stdin умер — считаем ввод потерянным, клиент увидит новый промпт после респавна */
  }
  // ввод без SSE-зрителя («слепая печать» при умершем SSE): не держим процесс вечно,
  // армируем тот же grace — при возобновлении просмотра сессия поднимется заново
  if (session.subscribers.size === 0 && !session.grace) {
    session.grace = setTimeout(() => {
      session.grace = null;
      session.backlog = "";
      kill(session);
      sessions.delete(device);
    }, GRACE_MS);
  }
  return written;
}
