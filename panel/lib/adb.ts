// Тонкая обёртка над adb (android-tools внутри контейнера).
// Ключи авторизации (adbkey) монтируются в $HOME/.android; adb-сервер стартует сам
// (порт 5037), перед командами делаем `adb connect` (кэш, чтобы не дёргать каждый раз).
import { execFile, spawn } from "node:child_process";
import { config } from "./config";

export interface AdbResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  ms: number;
}

export function firstDevice(): string {
  return config.adbDevices[0] ?? "";
}

function adbEnv(): NodeJS.ProcessEnv {
  return { ...process.env, HOME: config.adbHome, ANDROID_SDK_HOME: config.adbHome };
}

function run(args: string[], timeoutMs: number): Promise<AdbResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = execFile(
      config.adbPath,
      args,
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: adbEnv() },
      (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), ms: Date.now() - started });
      },
    );
    child.on("error", (e) => resolve({ ok: false, stdout: "", stderr: e.message, ms: Date.now() - started }));
  });
}

const lastConnect: Record<string, number> = {};

/** adb connect с кэшем 20 с. Для устройств-эмуляторов (без ':') не нужен. */
export async function adbEnsureConnected(device = firstDevice(), force = false): Promise<void> {
  if (!device.includes(":")) return;
  if (!force && Date.now() - (lastConnect[device] ?? 0) < 20000) return;
  await run(["connect", device], 8000);
  lastConnect[device] = Date.now();
}

/** Выполнить adb-команду. Если в args есть "-s <device>", сначала гарантируем connect. */
export async function adbExec(args: string[], timeoutMs = config.adbTimeoutMs): Promise<AdbResult> {
  const si = args.indexOf("-s");
  const device = si >= 0 ? args[si + 1] : undefined;
  if (device) await adbEnsureConnected(device);
  let r = await run(args, timeoutMs);
  // «device offline / not found» → один повторный connect
  if (!r.ok && device && /offline|not found|no devices|closed/i.test(r.stderr + r.stdout)) {
    await adbEnsureConnected(device, true);
    r = await run(args, timeoutMs);
  }
  return r;
}

/** Быстрая проверка связи со станцией. */
export async function adbWarmup(device = firstDevice()): Promise<boolean> {
  if (!device) return false;
  const r = await adbExec(["-s", device, "shell", "echo", "ok"], 10000);
  return r.ok && r.stdout.trim() === "ok";
}

/** adb push локального файла на устройство. */
export async function adbPush(localPath: string, remotePath: string, device = firstDevice()): Promise<boolean> {
  const r = await adbExec(["-s", device, "push", localPath, remotePath], 20000);
  return r.ok;
}

/** adb pull в локальный временный файл. null при ошибке. */
export async function adbPull(remotePath: string, device = firstDevice()): Promise<string | null> {
  const tmp = `/tmp/adb-pull-${process.pid}-${Date.now()}`;
  const r = await adbExec(["-s", device, "pull", remotePath, tmp], 20000);
  return r.ok ? tmp : null;
}

/** Потоковый adb shell (spawn) для SSE: строки через onLine, остановка через stop(). */
export function adbShellStream(
  shellCmd: string,
  onLine: (line: string) => void,
  device = firstDevice(),
): { stop: () => void } {
  let child: ReturnType<typeof spawn> | null = null;
  let stopped = false;
  void adbEnsureConnected(device).then(() => {
    if (stopped) return;
    child = spawn(config.adbPath, ["-s", device, "shell", shellCmd], {
      env: adbEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line) onLine(line);
      }
    });
    child.stderr?.on("data", () => {});
    child.on("error", () => {});
  });
  return {
    stop: () => {
      stopped = true;
      try {
        child?.kill("SIGKILL");
      } catch {
        /* уже мёртв */
      }
    },
  };
}
