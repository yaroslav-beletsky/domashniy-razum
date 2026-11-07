// Исполнение автоматических шагов мастера (ветка A) + скан LAN.
// Всё ходит через adb-обёртку lib/adb.ts (adb внутри контейнера, ключи смонтированы).
// Скрипты из station-setup/ пушатся на колонку и запускаются там; вывод — в SSE-журнал.
// Мост ставим из локального форк-бандла (station-setup/quasar-bridge-fork/dist — смена голоса
// TTS); форк-бандла нет — фолбэк на апстрим-релиз GitHub; голос пишется в tts.override.
// Опасных действий здесь нет: factory reset мастер не выполняет никогда (только инструкция).
import fs from "node:fs";
import path from "node:path";
import dns from "node:dns";
import https from "node:https";
import tls from "node:tls";
import crypto from "node:crypto";
import { Socket } from "node:net";
import { adbExec, adbPush } from "./adb";
import { config, litellmApiKey } from "./config";
import { appendLog } from "./logs";
import { getWizardState, setWizardCurrent, setWizardStep, STEP_ORDER, type WizardState, type WizardStepId } from "./wizard";

export type Emit = (o: Record<string, unknown>) => void;

const logLine = (device: string, text: string) => appendLog("info", "station", `мастер ${device}: ${text}`);

// ---------- скан LAN ----------

export interface ScanCandidate {
  ip: string;
  /** порт 5555 открыт — вероятная колонка с сетевым adb */
  adb: boolean;
  /** отвечает на типовые порты, но :5555 закрыт */
  alive: boolean;
  /** уже в реестре панели */
  known?: string;
}

function tcpOpen(ip: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = new Socket();
    let done = false;
    const fin = (v: boolean) => {
      if (done) return;
      done = true;
      try {
        s.destroy();
      } catch {
        /* ignore */
      }
      resolve(v);
    };
    s.setTimeout(timeoutMs, () => fin(false));
    s.once("error", () => fin(false));
    s.once("connect", () => fin(true));
    s.connect(port, ip);
  });
}

/**
 * Скан <subnet>.0/24. Колонка с adb — прежде всего порт :5555; Wi-Fi-колонки и NAT-шлюзы
 * иногда «глотают» SYN-бурсты, поэтому проба :5555 делается с ПОВТОРОМ, а для неответивших
 * адресов есть второй проход. Из docker-контейнера ARP/MAC недоступны (NAT) — только TCP.
 */
export async function scanLan(subnet: string, known: Map<string, string>, emit: Emit): Promise<ScanCandidate[]> {
  const base = subnet.trim().replace(/\.+$/, "");
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(base)) {
    emit({ type: "error", error: "подсеть вида 192.168.88" });
    return [];
  }
  const ips: string[] = [];
  for (let i = 1; i <= 254; i++) ips.push(`${base}.${i}`);
  const out: Map<string, ScanCandidate> = new Map();
  const chunkOf = <T,>(arr: T[], size: number, fn: (x: T) => Promise<void>): Promise<void>[] => {
    const chunks: Promise<void>[] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push((async () => {
        for (const x of arr.slice(i, i + size)) await fn(x);
      })());
    }
    return chunks;
  };
  const push = (ip: string, adb: boolean, alive: boolean) => {
    const c = out.get(ip) ?? { ip, adb: false, alive: false };
    if (adb) c.adb = true;
    if (alive) c.alive = true;
    const k = known.get(ip);
    if (k) c.known = k;
    out.set(ip, c);
  };

  // проход 0: колонки из реестра — их мало, даём щедрый таймаут (NAT/радио бывает «тугим»)
  const knownIps = [...known.keys()];
  if (knownIps.length > 0) {
    emit({ type: "log", level: "info", text: `проход 0: проверяю ${knownIps.length} колонок из реестра (:5555, до 2 с)` });
    for (const ip of knownIps) {
      const adb = (await tcpOpen(ip, 5555, 2000)) || (await tcpOpen(ip, 5555, 2000));
      if (adb) {
        push(ip, true, false);
        emit({ type: "host", ip, known: known.get(ip) ?? null });
      }
    }
  }

  // проход 1: проба :5555 с повтором (колонки), параллельно 32 адреса
  emit({ type: "log", level: "info", text: `проход 1: пробую :5555 (adb) на ${ips.length} адресах…` });
  let scanned = 0;
  await Promise.all(
    chunkOf(ips, 32, async (ip) => {
      let adb = await tcpOpen(ip, 5555, 400);
      if (!adb) adb = await tcpOpen(ip, 5555, 700);
      scanned++;
      if (scanned % 32 === 0) emit({ type: "progress", scanned, total: ips.length });
      if (adb) {
        push(ip, true, false);
        emit({ type: "host", ip, known: known.get(ip) ?? null });
      }
    }),
  );

  // проход 2: «живые» порты для тех, у кого :5555 молчит
  const rest = ips.filter((ip) => !out.has(ip));
  emit({ type: "log", level: "info", text: `проход 2: alive-порты (80/443/22/8080) на ${rest.length} адресах…` });
  await Promise.all(
    chunkOf(rest, 48, async (ip) => {
      let alive = false;
      for (const p of [80, 443, 22, 8080]) {
        if (await tcpOpen(ip, p, 250)) {
          alive = true;
          break;
        }
      }
      if (alive) {
        push(ip, false, true);
        emit({ type: "host", ip, known: known.get(ip) ?? null });
      }
    }),
  );

  // проход 3: второй шанс для полностью молчащих (NAT/радио иногда глотает SYN-бурст)
  const silent = ips.filter((ip) => !out.has(ip));
  if (silent.length > 0) {
    emit({ type: "log", level: "info", text: `проход 3: повторная проба :5555 на ${silent.length} молчащих…` });
    await Promise.all(
      chunkOf(silent, 16, async (ip) => {
        if (await tcpOpen(ip, 5555, 900)) {
          push(ip, true, false);
          emit({ type: "host", ip, known: known.get(ip) ?? null });
        }
      }),
    );
  }

  const candidates = [...out.values()].sort((a, b) => Number(b.adb) - Number(a.adb) || a.ip.localeCompare(b.ip));
  if (!candidates.some((c) => c.adb)) {
    emit({ type: "log", level: "info", text: "колонок с adb не нашлось: если сброс был недавно — колонка ещё поднимается, повторите скан через минуту" });
  }
  for (const [ip, name] of known) {
    if (!out.has(ip)) emit({ type: "log", level: "err", text: `${name} есть в реестре, но не ответила в скане — проверьте питание/сеть колонки` });
  }
  emit({ type: "done", candidates });
  return candidates;
}

// ---------- общие adb-помощники ----------

async function probeAdb(device: string, emit: Emit, quiet = false): Promise<{ ok: boolean; root: boolean; firmware?: string }> {
  if (!quiet) emit({ type: "log", level: "info", text: `подключаюсь по adb: ${device}` });
  const id = await adbExec(["-s", device, "shell", "id"], 12000);
  if (!id.ok || !id.stdout.trim()) {
    if (!quiet) emit({ type: "check", id: "adb", ok: false, text: `adb не отвечает (${device})` });
    return { ok: false, root: false };
  }
  const root = /uid=0\(root\)/.test(id.stdout);
  if (!quiet) emit({ type: "check", id: "adb", ok: true, text: root ? "adb жив, root есть (uid=0)" : "adb жив, root НЕТ" });
  let firmware: string | undefined;
  for (const f of ["/system/vendor/quasar/version_full", "/system/vendor/quasar/VERSION"]) {
    const r = await adbExec(["-s", device, "shell", `cat ${f} 2>/dev/null`], 8000);
    if (r.ok && r.stdout.trim()) {
      firmware = r.stdout.trim().split("\n")[0].slice(0, 60);
      break;
    }
  }
  if (firmware && !quiet) emit({ type: "check", id: "fw", ok: true, text: `прошивка: ${firmware}` });
  return { ok: true, root, firmware };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Ожидание появления колонки по adb (после сброса/OTA/перезагрузки она исчезает на минуты).
 * Возвращает первый успешный probe. emitProgress — сообщения о попытках в SSE-журнал.
 */
async function waitAdb(device: string, emit: Emit, totalMs: number, intervalMs = 7000): Promise<{ ok: boolean; root: boolean; firmware?: string }> {
  const deadline = Date.now() + totalMs;
  let attempt = 0;
  for (;;) {
    attempt++;
    const p = await probeAdb(device, emit, true);
    if (p.ok) return p;
    if (Date.now() >= deadline) return p;
    if (attempt % 3 === 1) {
      const left = Math.round((deadline - Date.now()) / 1000);
      emit({ type: "log", level: "info", text: `adb пока не отвечает (попытка ${attempt}) — жду, осталось ~${left} с…` });
    }
    await sleep(Math.min(intervalMs, Math.max(1000, deadline - Date.now())));
  }
}

/** Перезагрузка колонки и ожидание возврата adb (критерий «поднялось само»). */
async function rebootAndWait(device: string, emit: Emit, totalMs = 120000): Promise<{ ok: boolean; root: boolean; firmware?: string }> {
  emit({ type: "log", level: "info", text: "перезагружаю колонку и жду возврата adb…" });
  const r = await adbExec(["-s", device, "reboot"], 15000);
  if (!r.ok) emit({ type: "log", level: "info", text: "команда reboot не подтвердилась (возможно, связь уже оборвалась) — продолжаю ждать устройство" });
  await sleep(12000); // даём колонке уйти в перезагрузку
  const p = await waitAdb(device, emit, totalMs);
  return p;
}

function getJson(url: string, timeoutMs = 6000, attempts = 2): Promise<{ status: number; body: string } | null> {
  const once = (): Promise<{ status: number; body: string } | null> =>
    new Promise((resolve) => {
      const req = https.get(url, { rejectUnauthorized: false, timeout: timeoutMs }, (res) => {
        let body = "";
        res.on("data", (d: Buffer) => (body += d.toString("utf8")));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("timeout", () => {
        req.destroy();
        resolve(null);
      });
      req.on("error", () => resolve(null));
    });
  // NAT до стенд-хоста из docker-контейнера бывает «тугим» сразу после пересоздания
  // контейнера — один повтор через паузу снимает большинство ложных отказов
  return (async () => {
    let r = await once();
    for (let i = 1; i < attempts && (r === null || r.status === 0); i++) {
      await sleep(3000);
      r = await once();
    }
    return r;
  })();
}

// ---------- шаги ----------

/** DNS-резолв через конкретный сервер (промежуточный резолвер, который получит колонка). */
function resolveVia(server: string, name: string, timeoutMs = 5000): Promise<string[]> {
  return new Promise((resolve) => {
    const res = new dns.Resolver({ timeout: timeoutMs });
    let done = false;
    const fin = (v: string[]) => {
      if (done) return;
      done = true;
      try {
        res.cancel();
      } catch {
        /* ignore */
      }
      resolve(v);
    };
    res.setServers([server]);
    res.resolve4(name, (err, addrs) => fin(err ? [] : addrs));
  });
}

/** Цепочка сертификата стенда: лист должен быть для quasar-домена и достраиваться до eMudhra/AAA.
 *  Подключаемся строго к IP стенда (host), SNI — quasar-домен (servername), как делает колонка. */
function checkStandCert(host: string, servername: string, timeoutMs = 6000): Promise<{ ok: boolean; text: string }> {
  return new Promise((resolve) => {
    const s = tls.connect({ host, port: 443, servername, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const chain: { subject?: { CN?: string }; issuer?: { CN?: string; O?: string } }[] = [];
      const seen = new Set<string>();
      let c: tls.PeerCertificate | undefined = s.getPeerCertificate(true);
      // идём от листа к корню по issuerCertificate, защищаясь от циклов
      while (c && typeof c === "object") {
        const key = `${c.subject?.CN}|${c.issuer?.CN}`;
        if (seen.has(key)) break;
        seen.add(key);
        chain.push(c as { subject?: { CN?: string }; issuer?: { CN?: string; O?: string } });
        const next: tls.PeerCertificate | undefined = (c as { issuerCertificate?: tls.PeerCertificate }).issuerCertificate;
        if (!next || next === c) break;
        c = next;
      }
      s.end();
      const leafCn = chain[0]?.subject?.CN ?? "";
      const issuerCns = chain.map((x) => x.issuer?.CN ?? "").join(" / ");
      const rootOk = /AAA Certificate Services/.test(issuerCns) || /eMudhra/.test(issuerCns);
      if (!leafCn) {
        resolve({ ok: false, text: "сервер не отдал сертификат" });
        return;
      }
      resolve({
        ok: rootOk,
        text: rootOk
          ? `сертификат: ${leafCn} ← eMudhra/AAA-цепочка (доверие колонки из CA-бандла прошивки)`
          : `сертификат ${leafCn} НЕ достраивается до eMudhra/AAA (${issuerCns}) — колонка не примет HTTPS стенда`,
      });
    });
    s.on("error", (e) => resolve({ ok: false, text: `TLS к стенду не поднялся: ${String(e).slice(0, 80)}` }));
    s.on("timeout", () => {
      s.destroy();
      resolve({ ok: false, text: "TLS к стенду не ответил за таймаут" });
    });
  });
}

/**
 * Шаг 2: проверка стенда lite-kit по HTTPS. Проверяется всё, на чём держится пост-сброс путь:
 * конфиг с adbd, DNS-цепочка до стенда (через DHCP-резолвер, который получит колонка),
 * TLS-цепочка и наличие целевой прошивки в check_updates — запросом «как колонка»
 * (device_id+platform, иначе стенд честно отвечает `{"status":"ok"}` без hasUpdate).
 */
export async function runStandCheck(emit: Emit): Promise<{ ok: boolean; error?: string; note?: string }> {
  const base = config.standBaseUrl;
  const standHost = base.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
  const targetDomain = "quasar.yandex.net";
  emit({ type: "log", level: "info", text: `проверяю стенд ${base}` });

  // 1. конфиг активации с adbd
  const sync = await getJson(`${base}/get_sync_info`);
  if (!sync || sync.status !== 200) {
    emit({ type: "check", id: "sync", ok: false, text: `стенд не отвечает на /get_sync_info (${base})` });
    return { ok: false, error: `стенд ${base} не отвечает. На хосте стенда поднимите lite-kit: cd ~/Documents/home/lite-kit && ./start.sh (автозапуск — LaunchDaemon ru.yaroslav.lite-kit)` };
  }
  let syncOk = false;
  try {
    const j = JSON.parse(sync.body) as { config?: { device_config?: { adbd?: { remoteActivation?: boolean } } } };
    syncOk = j.config?.device_config?.adbd?.remoteActivation === true;
  } catch {
    /* не JSON */
  }
  emit({
    type: "check",
    id: "sync",
    ok: syncOk,
    text: syncOk ? "get_sync_info: adbd.remoteActivation=true — колонка получит доступ к железу" : "get_sync_info отвечает, но adbd НЕ включён в конфиге",
  });
  if (!syncOk) return { ok: false, error: "стенд отвечает, но не отдаёт adbd в конфиге — на хосте стенда: touch ~/Documents/home/lite-kit/run/sync_proxy и перезапуск start.sh" };

  // 2. DNS-цепочка: промежуточный DHCP-резолвер должен вести quasar-домены на стенд
  let dnsOk = false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(standHost)) {
    const viaResolver = await resolveVia(config.wizardDnsResolver, targetDomain);
    const onStand = await resolveVia(standHost, targetDomain);
    const viaOk = viaResolver.includes(standHost);
    const standOk = onStand.includes(standHost);
    dnsOk = viaOk && standOk;
    emit({
      type: "check",
      id: "dns",
      ok: dnsOk,
      text: dnsOk
        ? `${targetDomain}: DHCP-резолвер ${config.wizardDnsResolver} → ${standHost}, dnsmasq стенда тоже отвечает`
        : `${targetDomain}: цепочка DNS не сходится (через ${config.wizardDnsResolver}: ${viaResolver.join(", ") || "нет ответа"}; напрямую стенд: ${onStand.join(", ") || "нет ответа"}). Проверьте dnsmasq стенда (./start.sh) и форвард quasar-доменов на промежуточном резолвере`,
    });
  } else {
    emit({ type: "check", id: "dns", ok: false, text: `не могу проверить DNS: адрес стенда ${standHost || "?"} не является IP` });
  }
  if (!dnsOk) return { ok: false, error: "DNS-цепочка не ведёт quasar-домены на стенд — колонка после сброса уйдёт на настоящее облако. На хосте стенда: ./start.sh; на промежуточном резолвере: форвард quasar.yandex.net/.ru и scbh.yandex.net на стенд" };

  // 3. TLS: лист для quasar-домена, достроенный до eMudhra/AAA (к IP стенда, SNI как у колонки)
  const cert = await checkStandCert(standHost, targetDomain);
  emit({ type: "check", id: "tls", ok: cert.ok, text: cert.text });
  if (!cert.ok) return { ok: false, error: `сертификат стенда не выстроен в доверенную цепочку — ${cert.text}` };

  // 4. OTA: probe «как колонка» — без device_id/platform стенд отвечает без hasUpdate
  const probeUrl = `${base}/check_updates?device_id=LP0000000000000WIZARD&platform=${config.wizardPlatform}&version=0.0.0.1`;
  const upd = await getJson(probeUrl);
  let hasUpdate = false;
  let updVersion = "";
  if (upd) {
    try {
      const j = JSON.parse(upd.body) as { hasUpdate?: boolean; version?: string };
      hasUpdate = j.hasUpdate === true;
      updVersion = j.version ?? "";
    } catch {
      /* не JSON */
    }
  }
  const verOk = hasUpdate && updVersion.includes(config.targetFirmware);
  emit({
    type: "check",
    id: "updates",
    ok: verOk,
    text: verOk
      ? `check_updates (platform=${config.wizardPlatform}): hasUpdate=true, версия ${updVersion} — колонка по OTA получит целевую прошивку`
      : hasUpdate
        ? `check_updates отдал hasUpdate=true, но версия «${updVersion || "?"}» ≠ целевой ${config.targetFirmware} — в firmware/ на стенде не тот образ`
        : `check_updates: hasUpdate НЕ true — на стенде стоит run/no_downgrade или нет образа в firmware/${config.wizardPlatform}/`,
  });
  if (!verOk) {
    return {
      ok: false,
      error: hasUpdate
        ? `на стенде не тот образ: ожидается ${config.targetFirmware} в firmware/${config.wizardPlatform}/ — положите zip и проверьте manifest`
        : `откат прошивки выключен: на хосте стенда удалите ~/Documents/home/lite-kit/run/no_downgrade (если есть) и убедитесь, что firmware/${config.wizardPlatform}/ содержит образ ${config.targetFirmware}`,
    };
  }

  logLine(base, `стенд проверен: adbd ✓, DNS ✓, TLS ✓, hasUpdate ✓ (${updVersion || "?"})`);
  return { ok: true };
}

/** Шаг 5: проверка прошивки колонки с ОЖИДАНИЕМ: adb появляется только после OTA и перезагрузки.
 *  Ждём до ~2.5 минут внутри шага; если колонка ещё ставит прошивку — владелец жмёт «Повторить». */
export async function runOtaCheck(device: string, emit: Emit): Promise<{ ok: boolean; error?: string; note?: string }> {
  emit({ type: "log", level: "info", text: "жду появления колонки по adb (после OTA она ставит прошивку и перезагружается, до 2.5 минут)…" });
  const p = await waitAdb(device, emit, 150000);
  if (!p.ok) {
    return { ok: false, error: "колонка так и не поднялась по adb. Она ставит прошивку со стенда (до 10 минут): держите её включённой, подождите пару минут и нажмите «Повторить». Убедитесь, что шаги 3–4 сделаны (сброс, Wi-Fi) и стенд жив" };
  }
  emit({ type: "check", id: "adb", ok: true, text: "adb появился" + (p.root ? ", root есть" : "") });
  if (!p.root) return { ok: false, error: "adb есть, но root нет — это не та сборка/путь, ожидалось adbd от root" };
  const fw = p.firmware ?? "";
  const hit = fw.includes(config.targetFirmware);
  emit({
    type: "check",
    id: "fw-target",
    ok: hit,
    text: hit ? `прошивка совпала с целевой (${config.targetFirmware})` : `прошивка ${fw || "неизвестна"} ≠ целевая ${config.targetFirmware}`,
  });
  if (!hit) return { ok: false, error: `прошивка ${fw || "не прочитана"} — ожидается ${config.targetFirmware}. Если OTA ещё не доехала: подождите пару минут и нажмите «Повторить»; проверьте также hasUpdate на стенде (шаг 2)` };
  return { ok: true };
}

/** Шаг 6: adb connect + root (с коротким ожиданием — сразу после OTA adb может флапать). */
export async function runAdbRoot(device: string, emit: Emit): Promise<{ ok: boolean; error?: string; firmware?: string }> {
  const p = await waitAdb(device, emit, 45000);
  if (!p.ok) return { ok: false, error: "adb не подключился. Проверьте, что колонка в сети, прошивка целевая и стенд поднимал adb (шаги 2–5); затем нажмите «Повторить»" };
  emit({ type: "check", id: "adb", ok: true, text: p.root ? "adb жив, root есть (uid=0)" : "adb жив, root НЕТ" });
  if (!p.root) return { ok: false, error: "adb подключился, но root отсутствует (uid≠0). Ожидается production adbd от root на целевой прошивке" };
  if (p.firmware) emit({ type: "check", id: "fw", ok: true, text: `прошивка: ${p.firmware}` });
  logLine(device, "adb/root подтверждены" + (p.firmware ? `, прошивка ${p.firmware}` : ""));
  return { ok: true, firmware: p.firmware };
}

// ---------- голос моста (форк tts.override) ----------

/** Голоса, которые сервер Яндекса принимает в TtsGenerate.Voice (проверены форком на .79). */
const TTS_VOICES = ["ermil", "zahar", "oksana", "jane", "shitova", "omazh"] as const;

/** Голос из конфига; неизвестное значение → ermil (мужской, проверен на слух). */
function bridgeVoice(): string {
  const v = config.bridgeVoice.trim().toLowerCase();
  return (TTS_VOICES as readonly string[]).includes(v) ? v : "ermil";
}

/**
 * Кладёт /data/opt/quasar-bridge/tts.override со строкой voice=… — его читает форк моста
 * на каждый ответ озвучки, рестарт не нужен. Откат голоса: rm tts.override (вернётся женский
 * голос апстрима). force=false — не перетирать ручную правку, если строка voice= уже есть.
 */
async function writeTtsVoice(device: string, voice: string, emit: Emit, force: boolean): Promise<void> {
  const read = await adbExec(["-s", device, "shell", "cat /data/opt/quasar-bridge/tts.override 2>/dev/null"], 8000);
  const cur = (read.ok ? read.stdout : "").split("\n").find((l) => l.trim().startsWith("voice="))?.trim();
  if (cur && !force) {
    emit({ type: "check", id: "voice", ok: true, text: `голос уже задан в tts.override: ${cur.slice("voice=".length)} — не трогаю ручную правку` });
    return;
  }
  const w = await adbExec(
    ["-s", device, "shell", `printf 'voice=${voice}\\n' > /data/opt/quasar-bridge/tts.override && chmod 600 /data/opt/quasar-bridge/tts.override && cat /data/opt/quasar-bridge/tts.override`],
    10000,
  );
  const ok = w.ok && w.stdout.includes(`voice=${voice}`);
  emit({
    type: "check",
    id: "voice",
    ok,
    text: ok ? `голос «${voice}» записан в tts.override (подхватится на следующем ответе; откат — rm tts.override)` : `не удалось записать tts.override (${(w.stderr || w.stdout).trim().slice(0, 120)})`,
  });
}

/** Если мост уже healthy — голос гарантируем, но ручные правки tts.override не перетираем. */
async function ensureTtsVoice(device: string, emit: Emit): Promise<void> {
  await writeTtsVoice(device, bridgeVoice(), emit, false);
}

/**
 * Переключение uniproxy на мост (control.sh apply): правит quasar.cfg на ws://127.0.0.1:8443/uni.ws
 * с бэкапом endpoint-backup.json. Идемпотентно: если эндпоинт уже переключён — apply не повторяем.
 * Вступает в силу при перезагрузке колонки (шаг 8).
 */
async function ensureBridgeEndpoint(device: string, emit: Emit): Promise<boolean> {
  const cfgCheck = "grep -o '127.0.0.1:8443/uni.ws' /system/vendor/quasar/quasar.cfg 2>/dev/null | wc -l";
  const cnt = Number(((await adbExec(["-s", device, "shell", cfgCheck], 10000)).stdout || "").trim()) || 0;
  if (cnt > 0) {
    emit({ type: "check", id: "endpoint", ok: true, text: "uniproxy уже переключён на мост (127.0.0.1:8443/uni.ws)" });
    return true;
  }
  emit({ type: "log", level: "info", text: "переключаю uniproxy на мост (control.sh apply, оригинал — в endpoint-backup.json)…" });
  const ap = await adbExec(["-s", device, "shell", "sh /data/opt/quasar-bridge/app/control.sh apply 2>&1"], 30000);
  const out = (ap.stdout + ap.stderr).trim();
  const cnt2 = Number(((await adbExec(["-s", device, "shell", cfgCheck], 10000)).stdout || "").trim()) || 0;
  const ok = cnt2 > 0;
  emit({
    type: "check",
    id: "endpoint",
    ok,
    text: ok
      ? "uniproxy → 127.0.0.1:8443/uni.ws (вступит после перезагрузки — шаг 8)"
      : `не удалось переключить uniproxy на мост (${out.slice(-120) || "quasar.cfg не изменился"})`,
  });
  return ok;
}

/**
 * Шаг 7: проверка/установка моста quasar-bridge.
 * Источник — ЛОКАЛЬНЫЙ ФОРК-БАНДЛ со сменой голоса TTS (station-setup/quasar-bridge-fork/dist,
 * смонтирован в контейнер как /opt/station-setup:ro); бандла нет — фолбэк на официальный
 * релиз skrashevich/quasar-bridge (версия в конфиге, отвечает женским голосом).
 * Ручные env-подмены (TARBALL/BINARY) перекрывают форк.
 * Ставим install.sh из пакета: он сам кладёт app/, вешает S96-хук, держит app.previous для отката.
 * Перед install.sh записываем runtime.env (base/key/model из панели — ключ наружу не выводим)
 * и config.json (режим из черновика, listen_after_reply=true).
 * После установки (или если мост уже healthy) кладём tts.override с голосом WIZARD_BRIDGE_VOICE —
 * форк читает его на каждый ответ, рестарт не нужен; откат голоса — rm tts.override.
 * Затем переключаем uniproxy на мост (control.sh apply, идемпотентно) — активируется
 * перезагрузкой на шаге закрепления (шаг 8).
 */
export async function runBridgeCheck(device: string, emit: Emit): Promise<{ ok: boolean; error?: string; pid?: number; installed?: boolean }> {
  const p = await probeAdb(device, emit);
  if (!p.ok) return { ok: false, error: "adb не отвечает" };
  if (!p.root) return { ok: false, error: "root отсутствует — сначала шаг 6" };
  const st = await adbExec(["-s", device, "shell", "sh /data/opt/quasar-bridge/app/control.sh status 2>&1"], 12000);
  const out0 = (st.stdout + st.stderr).trim();
  const m0 = out0.match(/Bridge healthy \(PID (\d+)\)/);
  if (st.ok && m0) {
    emit({ type: "check", id: "bridge", ok: true, text: `мост healthy (PID ${m0[1]})` });
    await ensureTtsVoice(device, emit);
    const epOk = await ensureBridgeEndpoint(device, emit);
    logLine(device, `мост проверен: healthy, PID ${m0[1]}${epOk ? ", endpoint ✓" : ", endpoint НЕ переключён"}`);
    return epOk ? { ok: true, pid: Number(m0[1]) } : { ok: false, error: "мост healthy, но uniproxy не переключён на мост — см. проверку endpoint" };
  }
  emit({ type: "check", id: "bridge", ok: false, text: /no such file|not found/i.test(out0) ? "моста нет на колонке — ставлю форк-бандл" : "мост не healthy — переустанавливаю форк-бандл" });

  // --- источник бандла: env-подмена > локальный форк (голос через tts.override) > релиз GitHub ---
  const ver = config.bridgeVersion;
  const voice = bridgeVoice();
  const arch = (await adbExec(["-s", device, "shell", "uname -m 2>/dev/null"], 8000)).stdout.trim();
  const archKey = arch === "armv7l" || arch === "armv8l" ? "armv7" : "arm64";
  const asset = `quasar-bridge-linux-${archKey}.tar.gz`;
  const base = `https://github.com/skrashevich/quasar-bridge/releases/download/v${ver}`;
  const cacheDir = config.bridgeCacheDir || path.join(config.adbHome, ".android", "bridge-cache", `v${ver}-${archKey}`);
  fs.mkdirSync(cacheDir, { recursive: true });
  let tgzLocal = path.join(cacheDir, asset);
  let shaLocal = path.join(cacheDir, `${asset}.sha256`);
  let srcLabel = `релиз v${ver} (форк-бандл не найден — голос будет женский)`;
  // "env" — ручная подмена TARBALL; "fork" — локальный форк; "upstream" — апстрим с GitHub.
  let sourceKind: "env" | "fork" | "upstream" = "upstream";

  const download = (url: string, dest: string): Promise<boolean> =>
    new Promise((resolve) => {
      const f = fs.createWriteStream(dest);
      https
        .get(url, { timeout: 30000 }, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            f.close();
            fs.rmSync(dest, { force: true });
            resolve(download(new URL(res.headers.location, url).toString(), dest));
            return;
          }
          if (res.statusCode !== 200) {
            f.close();
            fs.rmSync(dest, { force: true });
            resolve(false);
            return;
          }
          res.pipe(f);
          f.on("finish", () => f.close(() => resolve(true)));
        })
        .on("error", () => {
          f.close();
          fs.rmSync(dest, { force: true });
          resolve(false);
        });
    });

  const sha256File = (f: string) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
  let expect: string | undefined;
  if (config.bridgeTarball) {
    // готовый пакет (ручная env-подмена): формат как у релиза (install.sh, control.sh, bin/quasar-bridge, ARCH …)
    if (!fs.existsSync(config.bridgeTarball)) return { ok: false, error: `WIZARD_BRIDGE_TARBALL не найден: ${config.bridgeTarball}` };
    tgzLocal = config.bridgeTarball;
    srcLabel = `свой пакет ${path.basename(tgzLocal)}`;
    sourceKind = "env";
    const side = `${tgzLocal}.sha256`;
    shaLocal = side;
    expect = fs.existsSync(side) ? fs.readFileSync(side, "utf8").trim().split(/\s+/)[0]?.toLowerCase() : sha256File(tgzLocal);
  } else {
    const forkTgz = config.bridgeForkDist ? path.join(config.bridgeForkDist, asset) : "";
    if (forkTgz && fs.existsSync(forkTgz) && fs.statSync(forkTgz).size > 0) {
      // форк station-setup: тот же формат пакета + смена голоса через tts.override
      tgzLocal = forkTgz;
      shaLocal = `${forkTgz}.sha256`;
      srcLabel = `форк quasar-bridge (${path.basename(forkTgz)}, голос через tts.override)`;
      sourceKind = "fork";
      expect = fs.existsSync(shaLocal) ? fs.readFileSync(shaLocal, "utf8").trim().split(/\s+/)[0]?.toLowerCase() : sha256File(tgzLocal);
    } else {
      if (forkTgz) emit({ type: "log", level: "info", text: `форк-бандл не найден (${forkTgz}) — ставлю апстрим-релиз v${ver} с GitHub (голос будет женский)` });
      for (const [name, dest] of [
        [asset, tgzLocal],
        [`${asset}.sha256`, shaLocal],
      ] as const) {
        if (fs.existsSync(dest) && fs.statSync(dest).size > 0) continue;
        emit({ type: "log", level: "info", text: `скачиваю ${name} (v${ver})…` });
        if (!(await download(`${base}/${name}`, dest))) return { ok: false, error: `не удалось скачать ${name} с GitHub (проверьте сеть панели)` };
      }
      expect = fs.readFileSync(shaLocal, "utf8").trim().split(/\s+/)[0]?.toLowerCase();
    }
  }
  const actual = sha256File(tgzLocal);
  if (!expect || expect !== actual) return { ok: false, error: `sha256 пакета не сошёлся (ожидалось ${expect || "?"}, получено ${actual}) — не ставлю битый архив` };
  let binLocal = "";
  if (config.bridgeBinary && sourceKind === "upstream") {
    // подмена одного бинаря имеет смысл только поверх апстрим-пакета: форк так терял бы смену голоса
    if (!fs.existsSync(config.bridgeBinary)) return { ok: false, error: `WIZARD_BRIDGE_BINARY не найден: ${config.bridgeBinary}` };
    binLocal = config.bridgeBinary;
    srcLabel += ` + свой бинарь ${path.basename(binLocal)} (sha256 ${sha256File(binLocal).slice(0, 12)}…)`;
  }
  emit({ type: "check", id: "bridge-sha", ok: true, text: `${srcLabel}: sha256 сошёлся (${archKey})` });
  logLine(device, `бандл моста: ${srcLabel}`);

  // --- настройки моста из черновика ---
  const wz = getWizardState(device);
  const mode = wz?.mode || "hybrid";
  const model = wz?.model || config.bridgeDefaultModel;
  const apiKey = litellmApiKey();
  if (!apiKey) return { ok: false, error: "LITELLM_API_KEY не задан в панели — без ключа мост не сможет ходить в модель" };
  const baseUrl = `${config.litellmBaseUrl}/v1`;
  const runtimeEnv = [
    `QUASAR_MODE="${mode}"`,
    `QUASAR_LLM_BASE_URL="${baseUrl}"`,
    `QUASAR_LLM_API_KEY="${apiKey}"`,
    `QUASAR_LLM_MODEL="${model}"`,
    "",
  ].join("\n");
  const bridgeConfig = JSON.stringify(
    {
      listen: "127.0.0.1:8443",
      upstream: "wss://uniproxy.alice.yandex.net/uni.ws",
      mode,
      listen_after_reply: true,
      tls_cert: "",
      tls_key: "",
      allowed_ips: ["127.0.0.1", "::1"],
    },
    null,
    2,
  );

  // --- закидываем на колонку и ставим ---
  const stage = "/data/opt/.bridge-install";
  const rtLocal = path.join(cacheDir, "runtime.env");
  const cfgLocal = path.join(cacheDir, "config.json");
  fs.writeFileSync(rtLocal, runtimeEnv, { mode: 0o600 });
  fs.writeFileSync(cfgLocal, bridgeConfig, { mode: 0o600 });

  const push = (local: string, remote: string) => adbExec(["-s", device, "push", local, remote], 180000);
  try {
    emit({ type: "log", level: "info", text: "пушу пакет и конфиги на колонку…" });
    const free = await adbExec(["-s", device, "shell", "df -k /data | tail -1"], 10000);
    const freeKb = Number((free.stdout.trim().split(/\s+/)[3] ?? "").replace(/\D/g, "")) || 0;
    if (freeKb && freeKb < 45000) return { ok: false, error: `на /data колонки свободно ${Math.round(freeKb / 1024)} МБ — для установки нужно ≥45 МБ` };
    const prep = await adbExec(["-s", device, "shell", `rm -rf ${stage}; mkdir -p ${stage}/pkg && chmod 700 ${stage}`], 15000);
    if (!prep.ok) return { ok: false, error: "не удалось создать каталог /data/opt/.bridge-install на колонке (место/права)" };
    const pushes: [string, string][] = [
      [tgzLocal, `${stage}/pkg.tar.gz`],
      [rtLocal, `${stage}/runtime.env`],
      [cfgLocal, `${stage}/config.json`],
    ];
    if (binLocal) pushes.push([binLocal, `${stage}/quasar-bridge.bin`]);
    for (const [local, remote] of pushes) {
      const r = await push(local, remote);
      if (!r.ok) {
        await adbExec(["-s", device, "shell", `rm -rf ${stage}`], 10000);
        return { ok: false, error: `adb push ${path.basename(local)} не удался (${(r.stderr || r.stdout).trim().slice(0, 120)})` };
      }
    }
  } finally {
    // runtime.env с ключом на диске панели не храним
    fs.rmSync(rtLocal, { force: true });
  }

  // sha на колонке (busybox), распаковка, подмена бинаря (если задана), install.sh. Стейдж чистим всегда.
  const script = [
    `cd ${stage} || exit 2`,
    `echo "${expect}  pkg.tar.gz" | sha256sum -c - >/dev/null 2>&1 || { echo 'sha256 на колонке не сошёлся'; rm -rf ${stage}; exit 9; }`,
    // busybox tar на колонке без -z → gzip -dc | tar x; архив сразу удаляем (на /data ~65 МБ)
    `gzip -dc pkg.tar.gz | tar -x -C pkg || { echo 'распаковка не удалась'; rm -rf ${stage}; exit 3; }`,
    `rm -f pkg.tar.gz`,
    `test -f pkg/install.sh || { echo 'в пакете нет install.sh'; rm -rf ${stage}; exit 4; }`,
    binLocal ? `cp quasar-bridge.bin pkg/bin/quasar-bridge && chmod 755 pkg/bin/quasar-bridge || { rm -rf ${stage}; exit 5; }` : `true`,
    `mkdir -p /data/opt/quasar-bridge && chmod 700 /data/opt/quasar-bridge`,
    // не затираем существующие config/runtime (install.sh сам кладёт шаблон, если config.json нет)
    `[ -e /data/opt/quasar-bridge/runtime.env ] || cp runtime.env /data/opt/quasar-bridge/runtime.env`,
    `[ -e /data/opt/quasar-bridge/config.json ] || cp config.json /data/opt/quasar-bridge/config.json`,
    `chmod 600 /data/opt/quasar-bridge/runtime.env /data/opt/quasar-bridge/config.json`,
    `sh pkg/install.sh 2>&1; rc=$?`,
    `cd /; rm -rf ${stage}`,
    `exit $rc`,
  ].join("; ");
  const install = await adbExec(["-s", device, "shell", script], 180000);
  const instOut = (install.stdout + install.stderr).trim();
  for (const l of instOut.split("\n").slice(-6)) {
    if (l.trim()) emit({ type: "log", level: install.ok ? "info" : "err", text: l.trim().slice(0, 200) });
  }
  if (!install.ok) return { ok: false, error: `install.sh завершился с ошибкой (см. журнал выше). Колонка не испорчена — старая версия/отсутствие моста сохранены` };

  // --- проверка после установки ---
  const st2 = await adbExec(["-s", device, "shell", "sh /data/opt/quasar-bridge/app/control.sh status 2>&1"], 20000);
  const m2 = (st2.stdout + st2.stderr).match(/Bridge healthy \(PID (\d+)\)/);
  if (!m2) return { ok: false, error: "мост установлен, но не стал healthy за 20 с — смотрите service.log на колонке" };
  const srcNote = sourceKind === "upstream" ? `апстрим v${ver}` : `форк v${ver}`;
  emit({ type: "check", id: "bridge", ok: true, text: `мост ${srcNote} установлен и healthy (PID ${m2[1]}), режим «${mode}», модель «${model}»` });
  await writeTtsVoice(device, voice, emit, true);
  const epOk = await ensureBridgeEndpoint(device, emit);
  logLine(device, `мост ${srcNote} установлен, healthy PID ${m2[1]}, mode=${mode}, model=${model}, voice=${voice}, источник=${sourceKind}${epOk ? ", endpoint ✓" : ", endpoint НЕ переключён"}`);
  if (!epOk) return { ok: false, error: "мост установлен и healthy, но uniproxy не переключён на мост — повторите шаг после исправления (см. проверку endpoint)" };
  return { ok: true, pid: Number(m2[1]), installed: true };
}

/** Шаг 8: три слоя закрепления + S98adbd (скрипты из station-setup/). */
export async function runPersist(device: string, emit: Emit): Promise<{ ok: boolean; error?: string }> {
  const p = await probeAdb(device, emit);
  if (!p.ok) return { ok: false, error: "adb не отвечает" };
  if (!p.root) return { ok: false, error: "нужен root" };

  const dir = config.stationSetupDir;
  const need = ["patch-quasar-cfg-adbd.sh", "S98adbd", "doh-block.sh"];
  for (const f of need) {
    if (!fs.existsSync(path.join(dir, f))) {
      return { ok: false, error: `скрипт ${f} не найден в ${dir} (смонтируйте station-setup в контейнер, /opt/station-setup)` };
    }
  }

  // 1. кладём скрипты в /data/opt
  emit({ type: "log", level: "info", text: "загружаю скрипты закрепления на колонку (/data/opt)" });
  await adbExec(["-s", device, "shell", "mkdir -p /data/opt"], 8000);
  for (const f of need) {
    const ok = await adbPush(path.join(dir, f), `/data/opt/${f}`, device);
    if (!ok) return { ok: false, error: `adb push ${f} не удался` };
    await adbExec(["-s", device, "shell", `chmod 755 /data/opt/${f}`], 8000);
  }

  // 2. слой 2: патч quasar.cfg (deactivate → /bin/true; сам монтирует rw/ro)
  emit({ type: "log", level: "info", text: "слой 2: патчу quasar.cfg (деактивация adb станет пустышкой)" });
  const patch = await adbExec(["-s", device, "shell", "sh /data/opt/patch-quasar-cfg-adbd.sh 2>&1"], 30000);
  const patchOut = (patch.stdout + patch.stderr).trim();
  emit({ type: "log", level: patch.ok ? "info" : "err", text: patchOut.split("\n").slice(-4).join(" | ") || "(без вывода)" });
  await adbExec(["-s", device, "shell", "sh /data/opt/patch-quasar-cfg-adbd.sh status 2>&1"], 15000);
  // quasar.cfg — однострочный JSON: grep -c считал бы СТРОКИ (всегда ≤1) — считаем вхождения.
  const cfgTrue = await adbExec(["-s", device, "shell", "grep -o '/bin/true' /system/vendor/quasar/quasar.cfg 2>/dev/null | wc -l"], 10000);
  const cfgTrueCnt = Number((cfgTrue.stdout || "").trim()) || 0;
  const patchOk = cfgTrueCnt >= 2;
  emit({ type: "check", id: "patch", ok: patchOk, text: patchOk ? `quasar.cfg: deactivate = /bin/true (${cfgTrueCnt} вхождений)` : `патч quasar.cfg не подтвердился (/bin/true вхождений: ${cfgTrueCnt})` });

  // 3. S98adbd в /etc/init.d (нужен rw на /)
  emit({ type: "log", level: "info", text: "ставлю страховочный автозапуск /etc/init.d/S98adbd (блок DoH + подъём adbd)" });
  await adbExec(["-s", device, "shell", "mount -o remount,rw / 2>&1"], 15000);
  const s98 = await adbPush(path.join(dir, "S98adbd"), "/etc/init.d/S98adbd", device);
  await adbExec(["-s", device, "shell", "chmod 755 /etc/init.d/S98adbd; mount -o remount,ro / 2>&1"], 15000);
  emit({ type: "check", id: "s98", ok: s98, text: s98 ? "S98adbd установлен" : "не удалось записать /etc/init.d/S98adbd" });

  // 4. слой 3: блок DoH (iptables) — прямо сейчас, не дожидаясь перезагрузки
  emit({ type: "log", level: "info", text: "слой 3: блокирую обходной DoH (iptables REJECT 1.1.1.1/1.0.0.1/8.8.8.8/8.8.4.4)" });
  const doh = await adbExec(["-s", device, "shell", "sh /data/opt/doh-block.sh 2>&1"], 15000);
  emit({ type: "log", level: doh.ok ? "info" : "err", text: (doh.stdout + doh.stderr).trim().split("\n").slice(-3).join(" | ") || "(без вывода)" });

  // 5. слой 1: неизменяемые маркеры (обе схемы имён: дефис и подчёркивание)
  emit({ type: "log", level: "info", text: "слой 1: маркеры adb + chattr +i" });
  await adbExec(
    ["-s", device, "shell", "touch /data/quasar/activate_adb_quasmodrom /data/quasar/activate_network_adb /data/quasar_activate_adb_quasmodrom /data/quasar_activate_network_adb 2>/dev/null"],
    10000,
  );
  await adbExec(
    ["-s", device, "shell", "chattr +i /data/quasar/activate_adb_quasmodrom /data/quasar/activate_network_adb 2>/dev/null"],
    10000,
  );
  const lsattr = await adbExec(["-s", device, "shell", "lsattr /data/quasar/activate_* /data/quasar_activate_* 2>/dev/null"], 10000);
  const lsLines = (lsattr.stdout || "").split("\n").filter((l) => l.includes("activate"));
  const immutable = lsLines.filter((l) => /^[^ ]*i/.test(l) || l.startsWith("----i") || l.charAt(4) === "i" || /^\S*i\S*\s/.test(l)).length >= 2;
  emit({
    type: "check",
    id: "markers",
    ok: immutable,
    text: immutable ? `маркеры защищены (+i): ${lsLines.length} файлов` : "chattr +i не подтвердился — маркеры снимаемы",
  });

  // 6. сводная проверка DoH — по факту правил (не по формулировкам status)
  const dohStatus = await adbExec(["-s", device, "shell", "sh /data/opt/doh-block.sh status 2>&1"], 10000);
  for (const l of (dohStatus.stdout + dohStatus.stderr).trim().split("\n").slice(-3)) {
    if (l.trim()) emit({ type: "log", level: "info", text: l.trim() });
  }
  const dohCnt = Number(((await adbExec(["-s", device, "shell", "iptables -S OUTPUT 2>/dev/null | grep -c REJECT"], 10000)).stdout || "").trim()) || 0;
  const dohOk = dohCnt >= 4;
  emit({ type: "check", id: "doh", ok: dohOk, text: dohOk ? `DoH-адреса заблокированы (${dohCnt} правил REJECT)` : `блок DoH не подтвердился (правил REJECT: ${dohCnt})` });

  const ok = patchOk && s98 && immutable && dohOk;
  logLine(device, ok ? "закрепление применено (маркеры +i, патч cfg, S98adbd, блок DoH)" : "закрепление применено частично — смотрите проверки");
  if (!ok) return { ok: false, error: "часть слоёв не подтвердилась (см. проверки выше). Повторный запуск безопасен — шаг идемпотентен" };

  // 7. контрольная перезагрузка: adb/root должны подняться САМИ, слои — выжить.
  // Заодно вступает в силу переключение uniproxy на мост (шаг 7: control.sh apply).
  const p2 = await rebootAndWait(device, emit, 120000);
  if (!p2.ok || !p2.root) {
    return {
      ok: false,
      error: "закрепление применено, но после перезагрузки adb/root не поднялся. Проверьте, что колонка в сети (та же точка Wi-Fi), подождите минуту и нажмите «Повторить» — шаг идемпотентен и досмотрит проверки",
    };
  }
  emit({ type: "check", id: "reboot", ok: true, text: "перезагрузка: adb/root поднялись сами" });

  // 8. слои пережили перезагрузку?
  const [ls2, cfg2, doh2] = await Promise.all([
    adbExec(["-s", device, "shell", "lsattr /data/quasar/activate_* /data/quasar_activate_* 2>/dev/null"], 10000),
    adbExec(["-s", device, "shell", "grep -o '/bin/true' /system/vendor/quasar/quasar.cfg 2>/dev/null | wc -l"], 10000),
    adbExec(["-s", device, "shell", "iptables -S OUTPUT 2>/dev/null | grep -c REJECT"], 10000),
  ]);
  const ls2Lines = (ls2.stdout || "").split("\n").filter((l) => l.includes("activate"));
  const imm2 = ls2Lines.filter((l) => l.charAt(4) === "i" || /^\S*i\S*\s/.test(l)).length >= 2;
  const cfg2Cnt = Number((cfg2.stdout || "").trim()) || 0;
  const doh2Cnt = Number((doh2.stdout || "").trim()) || 0;
  const survived = imm2 && cfg2Cnt >= 2 && doh2Cnt >= 4;
  emit({
    type: "check",
    id: "survived",
    ok: survived,
    text: survived
      ? `после перезагрузки всё на месте: маркеры +i (${ls2Lines.length}), deactivate=/bin/true (${cfg2Cnt}), DoH-блок (${doh2Cnt} правил)`
      : `после перезагрузки потеряно: маркеры:${imm2}, cfg:${cfg2Cnt}/2, DoH:${doh2Cnt}/4`,
  });
  const endpointLive = Number(((await adbExec(["-s", device, "shell", "grep -o '127.0.0.1:8443/uni.ws' /system/vendor/quasar/quasar.cfg 2>/dev/null | wc -l"], 10000)).stdout || "").trim()) || 0;
  emit({
    type: "check",
    id: "endpoint-live",
    ok: endpointLive > 0,
    text: endpointLive > 0
      ? "uniproxy направлен на мост — голос пойдёт через quasar-bridge"
      : "uniproxy НЕ переключён на мост — вернитесь к шагу 7",
  });
  if (!survived) return { ok: false, error: "закрепление не пережило перезагрузку — повторите шаг (он идемпотентен)" };
  if (endpointLive === 0) return { ok: false, error: "закрепление живо, но uniproxy не на мосте — повторите шаг 7 (установка/apply моста)" };
  logLine(device, "закрепление подтверждено перезагрузкой (adb сам, маркеры+cfg+DoH на месте, uniproxy на мосте)");
  return { ok: true };
}

/**
 * Шаг 9: статический адрес и DNS — полностью автоматически.
 * Берём ТЕКУЩИЙ работающий адрес/шлюз колонки, DNS — промежуточный резолвер (как на эталоне .79),
 * пишем блок в /etc/dhcpcd.conf (оригинал — в /data/opt/backup/dhcpcd.conf.orig), перезагружаем
 * колонку и проверяем: адрес тот же, resolv.conf → локальный unbound, quasar-домен резолвится в стенд.
 */
export async function runStaticIpCheck(device: string, emit: Emit): Promise<{ ok: boolean; error?: string; note?: string }> {
  const p = await probeAdb(device, emit);
  if (!p.ok) return { ok: false, error: "adb не отвечает" };
  if (!p.root) return { ok: false, error: "нужен root" };
  const standHost = config.standBaseUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");

  const [ipOut, gwOut, dhcpOut] = await Promise.all([
    adbExec(["-s", device, "shell", "ip -4 addr show wlan0 2>/dev/null | grep inet"], 8000),
    adbExec(["-s", device, "shell", "ip route show default 2>/dev/null"], 8000),
    adbExec(["-s", device, "shell", "cat /etc/dhcpcd.conf 2>/dev/null"], 8000),
  ]);
  const ip = (ipOut.stdout || "").match(/inet\s+(\d{1,3}(?:\.\d{1,3}){3})/)?.[1] ?? "";
  const gw = (gwOut.stdout || "").match(/default\s+via\s+(\d{1,3}(?:\.\d{1,3}){3})/)?.[1] ?? "";
  const dhcpText = dhcpOut.stdout || "";
  const staticLine = dhcpText.match(/^\s*static ip_address=(\d{1,3}(?:\.\d{1,3}){3})\/\d+\s*$/m)?.[1] ?? "";
  const dnsLine = dhcpText.match(/^\s*static domain_name_servers=(\S+)\s*$/m)?.[1] ?? "";
  emit({ type: "log", level: "info", text: `wlan0: ${ip || "нет адреса"}, шлюз: ${gw || "не найден"}, dhcpcd.conf: ${staticLine ? `статика ${staticLine}` : "заводской"}` });

  if (!ip || !gw) return { ok: false, error: "не удалось определить текущий адрес/шлюз колонки — без них статику не пишу (риск потерять колонку)" };

  if (staticLine === ip && dnsLine.includes(config.wizardDnsResolver)) {
    emit({ type: "check", id: "static", ok: true, text: `статика уже прописана (${staticLine}, DNS ${dnsLine}) — не трогаю` });
  } else {
    if (staticLine) {
      return { ok: false, error: `в dhcpcd.conf уже статика ${staticLine} ≠ текущего адреса ${ip} — правьте руками или верните бэкап /data/opt/backup/dhcpcd.conf.orig` };
    }
    emit({ type: "log", level: "info", text: "пишу статический адрес в /etc/dhcpcd.conf (оригинал — в /data/opt/backup/dhcpcd.conf.orig)" });
    const prep = await adbExec(
      ["-s", device, "shell", "mkdir -p /data/opt/backup && [ -f /data/opt/backup/dhcpcd.conf.orig ] || cp -p /etc/dhcpcd.conf /data/opt/backup/dhcpcd.conf.orig"],
      10000,
    );
    if (!prep.ok) return { ok: false, error: "не удалось сохранить бэкап dhcpcd.conf в /data/opt/backup" };
    const block = [
      "",
      "# static IP for station-llm wizard",
      "interface wlan0",
      `static ip_address=${ip}/24`,
      `static routers=${gw}`,
      `static domain_name_servers=${config.wizardDnsResolver}`,
      "",
    ].join("\n");
    const write = await adbExec(["-s", device, "shell", `printf '${block}' >> /etc/dhcpcd.conf`], 10000);
    const verify = await adbExec(["-s", device, "shell", "grep -c 'static ip_address' /etc/dhcpcd.conf 2>/dev/null"], 8000);
    const written = write.ok && Number((verify.stdout || "").trim()) > 0;
    emit({
      type: "check",
      id: "static",
      ok: written,
      text: written ? `статика записана: ${ip}/24, шлюз ${gw}, DNS ${config.wizardDnsResolver}` : "запись в /etc/dhcpcd.conf не подтвердилась",
    });
    if (!written) return { ok: false, error: "не удалось записать статику в dhcpcd.conf — колонку не трогаю, смотрите журнал" };
  }

  // перезагрузка: применяем статику и проверяем, что колонка вернулась на тот же адрес
  const p2 = await rebootAndWait(device, emit, 120000);
  if (!p2.ok || !p2.root) {
    return { ok: false, error: "после перезагрузки колонка не поднялась по adb. Проверьте, что она в сети на прежнем адресе (она должна вернуться на свой статический IP), подождите минуту и нажмите «Повторить»" };
  }
  const ip2 = ((await adbExec(["-s", device, "shell", "ip -4 addr show wlan0 2>/dev/null | grep inet"], 8000)).stdout || "").match(/inet\s+(\d{1,3}(?:\.\d{1,3}){3})/)?.[1] ?? "";
  const sameIp = ip2 === ip;
  emit({ type: "check", id: "ip-after", ok: sameIp, text: sameIp ? `после перезагрузки адрес прежний: ${ip2}` : `после перезагрузки адрес изменился: ${ip2 || "?"} (было ${ip}) — adb по старому адресу будет недоступен` });

  const resolv2 = (await adbExec(["-s", device, "shell", "grep '^nameserver' /etc/resolv.conf 2>/dev/null"], 8000)).stdout || "";
  const unbound = /^nameserver\s+127\.0\.0\.1\s*$/m.test(resolv2);
  emit({ type: "check", id: "resolv", ok: unbound, text: unbound ? "resolv.conf → 127.0.0.1 (локальный unbound, дальше — стенд)" : `resolv.conf неожиданный: ${resolv2.split("\n").slice(0, 2).join(" | ").trim() || "пусто"}` });

  // DNS-цепочка глазами самой колонки
  const ns = await adbExec(["-s", device, "shell", `nslookup quasar.yandex.net 2>/dev/null`], 10000);
  let dnsAnswer = (ns.stdout || "").includes(standHost);
  if (!dnsAnswer) {
    const ping = await adbExec(["-s", device, "shell", "ping -c 1 -W 3 quasar.yandex.net 2>/dev/null | head -1"], 10000);
    dnsAnswer = (ping.stdout || "").includes(standHost);
  }
  emit({
    type: "check",
    id: "dns-chain",
    ok: dnsAnswer,
    text: dnsAnswer ? `с колонки quasar.yandex.net резолвится в стенд (${standHost})` : `с колонки quasar.yandex.net резолвится НЕ в стенд — boot-sync уйдёт в облако; проверьте цепочку DNS`,
  });

  const ok = sameIp && unbound && dnsAnswer;
  logLine(device, ok ? `статика применена и проверена (${ip}, DNS через стенд)` : "статика применена с оговорками — смотрите проверки");
  if (!ok) return { ok: false, error: "статика записана, но проверка после перезагрузки не сошлась (см. проверки). Откат: /data/opt/backup/dhcpcd.conf.orig + перезагрузка" };
  return { ok: true };
}

/** Шаг 10: yandex-noupdate.sh + выгрузка бэкапа с колонки на панель. */
export async function runNoupdate(device: string, host: string, emit: Emit): Promise<{ ok: boolean; error?: string }> {
  const p = await waitAdb(device, emit, 30000);
  if (!p.ok) return { ok: false, error: "adb не отвечает — блокировать обновления надо сразу, пока доступ жив. Подождите минуту (колонка могла ещё подниматься) и нажмите «Повторить»" };
  if (!p.root) return { ok: false, error: "нужен root" };

  const dir = config.stationSetupDir;
  if (!fs.existsSync(path.join(dir, "yandex-noupdate.sh"))) {
    return { ok: false, error: `yandex-noupdate.sh не найден в ${dir}` };
  }
  emit({ type: "log", level: "info", text: "загружаю yandex-noupdate.sh на колонку" });
  await adbExec(["-s", device, "shell", "mkdir -p /data/opt"], 8000);
  if (!(await adbPush(path.join(dir, "yandex-noupdate.sh"), "/data/opt/yandex-noupdate.sh", device))) {
    return { ok: false, error: "adb push yandex-noupdate.sh не удался" };
  }
  await adbExec(["-s", device, "shell", "chmod 755 /data/opt/yandex-noupdate.sh"], 8000);

  emit({ type: "log", level: "info", text: "отключаю обновления (подмена ключа OTA + заглушка аплаера)" });
  const apply = await adbExec(["-s", device, "shell", "sh /data/opt/yandex-noupdate.sh 2>&1"], 45000);
  for (const l of (apply.stdout + apply.stderr).trim().split("\n").slice(-8)) {
    if (l.trim()) emit({ type: "log", level: apply.ok ? "info" : "err", text: l.trim() });
  }
  const status = await adbExec(["-s", device, "shell", "sh /data/opt/yandex-noupdate.sh status 2>&1"], 15000);
  const stOut = status.stdout + status.stderr;
  const ok = status.ok && /защищён|active|подмен|заглуш/i.test(stOut);
  emit({ type: "check", id: "noupdate", ok, text: ok ? "обновления заблокированы (status ок)" : "status не подтвердил блокировку" });

  // забираем бэкап оригиналов к себе (сброс /data его сотрёт)
  emit({ type: "log", level: "info", text: "забираю копию /data/opt/backup с колонки" });
  const backupDir = path.join(config.adbHome, ".android", "wizard-backups", host.replace(/[^\w.-]/g, "_"));
  fs.mkdirSync(backupDir, { recursive: true });
  const pull = await adbExec(["-s", device, "pull", "/data/opt/backup", backupDir], 60000);
  const pulled = pull.ok && fs.existsSync(backupDir) && fs.readdirSync(backupDir).length > 0;
  emit({ type: "check", id: "backup", ok: pulled, text: pulled ? `бэкап на панели: ${backupDir}` : "выгрузка бэкапа не удалась (содержимое /data/opt/backup пусто или недоступно)" });

  logLine(device, ok ? "обновления заблокированы, бэкап выгружен" : "noupdate: статус не подтверждён");
  if (!ok) return { ok: false, error: "блокировка обновлений не подтвердилась (см. вывод status). Повторный запуск безопасен" };
  return { ok: true };
}

/** Шаг 13: свежие строки лога моста для ручной проверки маршрута. */
export async function runTestCheck(device: string, emit: Emit): Promise<{ ok: boolean; error?: string; llmLines: number }> {
  const p = await probeAdb(device, emit);
  if (!p.ok) return { ok: false, error: "adb не отвечает", llmLines: 0 };
  const tail = await adbExec(["-s", device, "shell", "tail -n 80 /data/opt/quasar-bridge/service.log 2>/dev/null"], 12000);
  const lines = (tail.stdout || "").split("\n").filter((l) => l.trim());
  let llmLines = 0;
  for (const l of lines) {
    if (/route[=:]?\s*"?llm|agent:|llm_request|chat_completion/i.test(l)) llmLines++;
  }
  for (const l of lines.slice(-12)) emit({ type: "log", level: "info", text: l.slice(0, 240) });
  emit({
    type: "check",
    id: "route",
    ok: llmLines > 0,
    text: llmLines > 0 ? `в свежем логе есть обращения к модели/agent (${llmLines} строк)` : "в последних 80 строках обращений к модели не видно — скажите колонке фразу и повторите",
  });
  return { ok: true, llmLines };
}

/** Автоклассификация точки входа (A.4): что уже есть на колонке → какие шаги считать готовыми. */
export async function runClassify(st: WizardState, emit: Emit): Promise<{ ok: boolean; error?: string }> {
  const device = st.key;
  const done = (step: WizardStepId, note: string) => {
    setWizardStep(device, step, { status: "done", note });
    emit({ type: "check", id: step, ok: true, text: note });
  };
  const skip = (step: WizardStepId, note: string) => {
    setWizardStep(device, step, { status: "skipped", note });
    emit({ type: "check", id: step, ok: true, text: note });
  };
  emit({ type: "log", level: "info", text: `определяю текущее состояние колонки ${device}` });
  const p = await probeAdb(device, emit);
  if (!p.ok) {
    // adb нет — «нулевая» колонка: полный путь от сброса
    skip("ota", "проверка невозможна без adb — прогоним после появления доступа");
    emit({ type: "log", level: "info", text: "колонка «нулевая»: стартую с шага 3 (сброс). Стенд должен быть жив до привязки" });
    finishClassify(device);
    return { ok: true };
  }
  if (!p.root) return { ok: false, error: "adb есть, но root нет — мастер такое состояние не классифицирует (ожидается либо «нулевая», либо root)" };

  done("adbroot", "adb/root уже живы");
  skip("reset", "не нужен: adb уже жив");
  skip("bindwifi", "не нужно: колонка уже в сети");
  if (p.firmware && p.firmware.includes(config.targetFirmware)) done("ota", `прошивка уже целевая (${p.firmware})`);

  const [bridge, markers, cfg, noup, doh] = await Promise.all([
    adbExec(["-s", device, "shell", "sh /data/opt/quasar-bridge/app/control.sh status 2>&1"], 12000),
    adbExec(["-s", device, "shell", "lsattr /data/quasar/activate_* /data/quasar_activate_* 2>/dev/null"], 10000),
    adbExec(["-s", device, "shell", "grep -o '/bin/true' /system/vendor/quasar/quasar.cfg 2>/dev/null | wc -l"], 10000),
    adbExec(["-s", device, "shell", "sh /data/opt/yandex-noupdate.sh status 2>&1"], 15000),
    adbExec(["-s", device, "shell", "iptables -S OUTPUT 2>/dev/null | grep -c REJECT"], 10000),
  ]);
  const bridgeOk = /Bridge healthy \(PID/.test(bridge.stdout);
  if (bridgeOk) done("bridge", "мост уже healthy");
  const markerLines = (markers.stdout || "").split("\n").filter((l) => l.includes("activate"));
  const markersOk = markerLines.filter((l) => l.charAt(4) === "i" || /^-*i/.test(l)).length >= 2;
  const cfgOk = Number((cfg.stdout || "").trim()) >= 2;
  const dohOk = Number((doh.stdout || "").trim()) >= 4;
  if (!dohOk) emit({ type: "check", id: "doh", ok: false, text: "блок DoH не найден — boot-sync может уйти мимо стенда" });
  if (bridgeOk && markersOk && cfgOk) {
    done("persist", `закрепление на месте (маркеры +i, cfg патчен${dohOk ? ", DoH заблокирован" : ", DoH НЕТ"})`);
  } else {
    emit({ type: "check", id: "persist", ok: false, text: `закрепление неполное (маркеры:${markersOk}, cfg:${cfgOk}, doh:${dohOk}) — шаг 8 доделает` });
  }
  if (/защищён|active|подмен|заглуш/i.test(noup.stdout + noup.stderr)) done("noupdate", "обновления уже заблокированы");
  else emit({ type: "check", id: "noupdate", ok: false, text: "блокировки обновлений нет — шаг 10 обязателен (сразу после закрепления)" });

  const dhcpcd = await adbExec(["-s", device, "shell", "grep -c 'static ip_address' /etc/dhcpcd.conf 2>/dev/null"], 8000);
  if (Number((dhcpcd.stdout || "").trim()) > 0) done("staticip", "статический адрес уже прописан");

  emit({ type: "log", level: "ok", text: "классификация готова: выполненные шаги отмечены, продолжайте с первого невыполненного" });
  logLine(device, "автоклассификация выполнена");
  finishClassify(device);
  return { ok: true };
}

/** Текущий указатель = первый шаг после discover без done/skipped. */
export function finishClassify(key: string): void {
  const st = getWizardState(key);
  if (!st) return;
  const next = STEP_ORDER.find((id) => id !== "discover" && !["done", "skipped"].includes(st.steps[id]?.status ?? "pending"));
  if (next) setWizardCurrent(key, next);
}
