// Чтение лога belch-voice с другого Mac (.23) по ssh, read-only: tail + tail -f.
// Аутентификация — выделенный ключ (смонтирован в контейнер), пароль не нужен.
// known_hosts формируем при первом обращении (StrictHostKeyChecking=accept-new).
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config";

const SSH_OPTS = [
  "-i", config.voiceLogSshKey,
  "-o", "BatchMode=yes",
  "-o", "StrictHostKeyChecking=accept-new",
  "-o", "UserKnownHostsFile=/tmp/known_hosts",
  "-o", "ConnectTimeout=6",
  "-o", "LogLevel=ERROR",
];

function ensureKnownHosts() {
  try {
    if (fs.existsSync("/tmp/known_hosts")) return;
    const host = config.voiceLogSshTarget.split("@")[1] ?? "";
    if (!host) return;
    execFile("ssh-keyscan", ["-T", "5", "-t", "ed25519,rsa", host], { timeout: 8000 }, (err, stdout) => {
      if (!err && stdout.trim()) {
        try {
          fs.writeFileSync("/tmp/known_hosts", stdout, { mode: 0o600 });
        } catch {
          /* tmp read-only — accept-new всё равно дозапишет */
        }
      }
    });
  } catch {
    /* best effort */
  }
}

/** Последние N строк лога (по умолчанию — voice-chain). [] при любой ошибке (offline — штатно). */
export function sshLogTail(lines: number, file: string = config.voiceLogSshPath): Promise<string[]> {
  ensureKnownHosts();
  return new Promise((resolve) => {
    execFile(
      "ssh",
      [...SSH_OPTS, config.voiceLogSshTarget, `tail -n ${Math.min(Math.max(lines, 1), 300)} ${file} 2>/dev/null`],
      { timeout: 15000, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve([]);
        resolve(String(stdout ?? "").split("\n").filter((l) => l.trim().length > 0));
      },
    );
  });
}

/** Потоковый tail -f лога: строки через onLine, остановка через stop().
 *  from — сколько последних строк отдать сразу (0 = только новые, если хвост уже взят отдельно). */
export function sshLogFollow(onLine: (line: string) => void, opts: { file?: string; from?: number } = {}): { stop: () => void } {
  ensureKnownHosts();
  const file = opts.file ?? config.voiceLogSshPath;
  const from = opts.from ?? 80;
  const child = spawn(
    "ssh",
    [...SSH_OPTS, config.voiceLogSshTarget, `tail -n ${Math.max(from, 0)} -f ${file} 2>/dev/null`],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let buf = "";
  child.stdout.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line.trim()) onLine(line);
    }
  });
  child.stderr.on("data", () => {});
  child.on("error", () => {});
  return {
    stop: () => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* мёртв */
      }
    },
  };
}

export function sshKeyFingerprintHint(): string {
  try {
    const pub = fs.readFileSync(path.join(path.dirname(config.voiceLogSshKey), "id_ed25519.pub"), "utf8").trim();
    return pub.split(" ")[1] ?? "";
  } catch {
    return "";
  }
}
