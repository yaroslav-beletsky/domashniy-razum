// Управление quasar-bridge на колонке через adb.
// Факты о мосте (проверено на станции):
//  - runtime.env содержит QUASAR_MODE / QUASAR_LLM_MODEL в двойных кавычках (shell-экранирование);
//  - config.json тоже содержит "mode"; SIGHUP перечитывает только маршрутизацию (routing_reloaded);
//  => смена режима/модели: правим runtime.env (+ mode в config.json) и делаем control.sh restart.
// Секреты (QUASAR_LLM_API_KEY и т.п.) наружу не отдаём и не трогаем.
import fs from "node:fs";
import { adbExec, adbPull, adbPush, firstDevice } from "./adb";
import { rememberStatus } from "./stationsStore";
import { derivePanelMode, normalizeMode, ROUTING_HYBRID, ROUTING_LLM, type PanelMode, type RoutingLike } from "./modes";

export interface BridgeInfo {
  device: string;
  reachable: boolean;
  running: boolean;
  healthy: boolean;
  pid?: number;
  bridgeVersion?: string;
  firmware?: string;
  ip?: string;
  /** режим панели: alice | hybrid | llm (выводится из mode моста и routing) */
  mode?: PanelMode;
  /** сырой режим моста: observe | hybrid */
  bridgeMode?: string;
  model?: string;
  error?: string;
}

const STATE = "/data/opt/quasar-bridge";
const APP = `${STATE}/app`;

function unquote(v: string): string {
  const t = v.trim();
  return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).replace(/\\([\\`"$])/g, "$1") : t;
}

function shellQuote(v: string): string {
  return `"${v.replace(/[\\`"$]/g, "\\$&")}"`;
}

function envValue(text: string, key: string): string | undefined {
  // берём последнее присваивание (оно и побеждает при source)
  const re = new RegExp(`^${key}=(.*)$`, "gm");
  let last: string | undefined;
  for (let m = re.exec(text); m; m = re.exec(text)) last = m[1];
  return last === undefined ? undefined : unquote(last);
}

const statusCache = new Map<string, { at: number; p: Promise<BridgeInfo> }>();

/** Полный статус колонки (кэш 3 с, чтобы список и деталь не долбили adb). Не бросает исключений. */
export function stationStatus(device = firstDevice(), fresh = false): Promise<BridgeInfo> {
  const hit = statusCache.get(device);
  if (!fresh && hit && Date.now() - hit.at < 3000) return hit.p;
  const p = readStationStatus(device).then((info) => {
    if (info.reachable) rememberStatus(device, info);
    return info;
  });
  statusCache.set(device, { at: Date.now(), p });
  return p;
}

async function readStationStatus(device: string): Promise<BridgeInfo> {
  const base: BridgeInfo = { device, reachable: false, running: false, healthy: false };
  if (!device) return { ...base, error: "ADB_DEVICES не задан" };

  const ping = await adbExec(["-s", device, "shell", "echo ok"], 10000);
  if (!ping.ok || !ping.stdout.includes("ok")) {
    return { ...base, error: `станция недоступна по adb (${device})` };
  }
  base.reachable = true;

  const [st, ver, fw, cfg, env, ip] = await Promise.all([
    adbExec(["-s", device, "shell", `sh ${APP}/control.sh status`], 10000),
    adbExec(["-s", device, "shell", `cat ${APP}/VERSION 2>/dev/null`], 8000),
    adbExec(["-s", device, "shell", "cat /system/vendor/quasar/VERSION 2>/dev/null"], 8000),
    adbExec(["-s", device, "shell", `cat ${STATE}/config.json 2>/dev/null`], 8000),
    adbExec(["-s", device, "shell", `grep -E '^QUASAR_(MODE|LLM_MODEL)=' ${STATE}/runtime.env 2>/dev/null`], 8000),
    adbExec(["-s", device, "shell", "ip -4 addr show wlan0 2>/dev/null | grep inet | head -1"], 8000),
  ]);

  if (st.ok) {
    const m = st.stdout.match(/Bridge healthy \(PID (\d+)\)/);
    base.running = true;
    base.healthy = true;
    if (m) base.pid = Number(m[1]);
  }
  if (ver.ok && ver.stdout.trim()) base.bridgeVersion = ver.stdout.trim().slice(0, 40);
  if (fw.ok && fw.stdout.trim()) base.firmware = fw.stdout.trim().slice(0, 40);

  const envText = env.ok ? env.stdout : "";
  const envMode = envValue(envText, "QUASAR_MODE");
  const envModel = envValue(envText, "QUASAR_LLM_MODEL");
  if (envModel) base.model = envModel.slice(0, 120);
  let cfgJson: { mode?: string; routing?: RoutingLike } | undefined;
  if (cfg.ok && cfg.stdout.trim().startsWith("{")) {
    try {
      cfgJson = JSON.parse(cfg.stdout);
    } catch {
      /* конфиг не JSON */
    }
  }
  // runtime.env перекрывает config.json (как и в самом мосте)
  const bridgeMode = envMode ?? (typeof cfgJson?.mode === "string" ? cfgJson.mode : undefined);
  if (bridgeMode) {
    base.bridgeMode = bridgeMode;
    base.mode = derivePanelMode(bridgeMode, cfgJson?.routing);
  }
  if (ip.ok) {
    const m = ip.stdout.match(/inet (\d+\.\d+\.\d+\.\d+)/);
    if (m) base.ip = m[1];
  }
  return base;
}

/** Меняет/добавляет ключ в runtime.env (в самом конце файла — последнее присваивание побеждает). */
async function patchRuntimeEnv(device: string, key: string, value: string): Promise<{ ok: boolean; error?: string }> {
  const tmp = await adbPull(`${STATE}/runtime.env`, device);
  if (!tmp) return { ok: false, error: "не удалось прочитать runtime.env" };
  try {
    let text = fs.readFileSync(tmp, "utf8");
    const re = new RegExp(`^${key}=.*$`, "gm");
    const line = `${key}=${shellQuote(value)}`;
    if (re.test(text)) text = text.replace(new RegExp(`^${key}=.*$`, "gm"), line);
    else text = text.replace(/\n?$/, "\n") + line + "\n";
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    const pushed = await adbPush(tmp, `${STATE}/runtime.env`, device);
    if (!pushed) return { ok: false, error: "adb push runtime.env не удался" };
    await adbExec(["-s", device, "shell", `chmod 600 ${STATE}/runtime.env`], 8000);
    return { ok: true };
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

/** Правит config.json через JSON-merge: остальные ключи сохраняются как есть. */
async function patchConfig(
  device: string,
  mutate: (cfg: Record<string, unknown>) => void,
): Promise<{ ok: boolean; error?: string }> {
  const tmp = await adbPull(`${STATE}/config.json`, device);
  if (!tmp) return { ok: false, error: "не удалось прочитать config.json" };
  try {
    const cfg = JSON.parse(fs.readFileSync(tmp, "utf8")) as Record<string, unknown>;
    mutate(cfg);
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
    const pushed = await adbPush(tmp, `${STATE}/config.json`, device);
    if (!pushed) return { ok: false, error: "adb push config.json не удался" };
    await adbExec(["-s", device, "shell", `chmod 600 ${STATE}/config.json`], 8000);
    return { ok: true };
  } catch {
    return { ok: false, error: "config.json не является валидным JSON" };
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

/** Что записать в мост для режима панели. routing=undefined — блок не трогаем («Алиса»). */
// listenAfterReply=false: после ответа нашей модели микрофон не переоткрывается. Иначе следующий «хвост» уходит
// Яндексу напрямую (route=yandex, sent=true, без native_route_decision) в обход routing/default_route=llm.
// Ответы самого Яндекса это не затрагивает (у них своё поведение). Для «Алиса» ключ не трогаем.
function bridgeSettings(mode: PanelMode): {
  bridgeMode: "observe" | "hybrid";
  routing?: typeof ROUTING_LLM;
  listenAfterReply?: boolean;
} {
  if (mode === "alice") return { bridgeMode: "observe" };
  if (mode === "hybrid") return { bridgeMode: "hybrid", routing: ROUTING_HYBRID, listenAfterReply: false };
  return { bridgeMode: "hybrid", routing: ROUTING_LLM, listenAfterReply: false };
}

async function restartBridge(device: string): Promise<{ ok: boolean; error?: string }> {
  const r = await adbExec(["-s", device, "shell", `sh ${APP}/control.sh restart 2>&1`], 45000);
  const out = (r.stdout + r.stderr).trim();
  if (!r.ok || /did not become ready|fail|usage|in progress|configuration rejected|"level":"ERROR"/i.test(out)) {
    return { ok: false, error: `restart не удался: ${out.slice(-160)}` };
  }
  return { ok: true };
}

export interface ApplyStep {
  id: "write" | "check" | "restart" | "wait";
  label: string;
  index: number; // 1..total
  total: number;
}

const STEP_LABELS: Record<ApplyStep["id"], string> = {
  write: "Записываем настройки",
  check: "Проверяем конфигурацию",
  restart: "Перезапускаем мост",
  wait: "Ждём, пока мост оживёт",
};
const STEP_ORDER: ApplyStep["id"][] = ["write", "check", "restart", "wait"];

const applying = new Set<string>();

export function isApplying(device: string): boolean {
  return applying.has(device);
}

async function waitHealthy(device: string, timeoutMs: number, notPid?: number): Promise<number | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const st = await adbExec(["-s", device, "shell", `sh ${APP}/control.sh status 2>&1`], 10000);
    const m = st.ok ? st.stdout.match(/Bridge healthy \(PID (\d+)\)/) : null;
    if (m && Number(m[1]) !== notPid) return Number(m[1]);
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

/**
 * Смена режима и/или модели одной операцией: runtime.env (+ config.json) → check → restart → ждём healthy.
 * Одна операция на колонку одновременно. Прогресс — через onStep.
 */
export async function applyBridgeChange(
  device: string,
  change: { mode?: string; model?: string },
  onStep?: (s: ApplyStep) => void,
): Promise<{ ok: boolean; error?: string; pid?: number }> {
  const { mode, model } = change;
  if (mode === undefined && model === undefined) return { ok: false, error: "нечего менять" };
  const panelMode = mode === undefined ? undefined : normalizeMode(mode);
  if (mode !== undefined && !panelMode) return { ok: false, error: "mode должен быть alice|hybrid|llm" };
  if (model !== undefined && !/^[\w./:@+~-]{1,120}$/.test(model)) return { ok: false, error: "недопустимое имя модели" };
  if (applying.has(device)) return { ok: false, error: "операция уже выполняется" };

  applying.add(device);
  const step = (id: ApplyStep["id"]) =>
    onStep?.({ id, label: STEP_LABELS[id], index: STEP_ORDER.indexOf(id) + 1, total: STEP_ORDER.length });
  try {
    // снимок файлов: при отказе возвращаем как было (мост не должен остаться с невалидным конфигом)
    const snap = {
      env: await adbPull(`${STATE}/runtime.env`, device),
      cfg: await adbPull(`${STATE}/config.json`, device),
    };
    const rollback = async () => {
      if (snap.env) await adbPush(snap.env, `${STATE}/runtime.env`, device);
      if (snap.cfg) await adbPush(snap.cfg, `${STATE}/config.json`, device);
      await adbExec(["-s", device, "shell", `chmod 600 ${STATE}/runtime.env ${STATE}/config.json`], 8000);
    };
    const dropSnap = () => {
      for (const f of [snap.env, snap.cfg]) {
        if (f)
          try {
            fs.unlinkSync(f);
          } catch {
            /* ignore */
          }
      }
    };
    const fail = async (error: string) => {
      await rollback();
      dropSnap();
      return { ok: false as const, error };
    };

    const before = await adbExec(["-s", device, "shell", `sh ${APP}/control.sh status 2>&1`], 10000);
    const oldPid = Number(before.stdout.match(/PID (\d+)/)?.[1]) || undefined;

    step("write");
    if (panelMode !== undefined) {
      const st = bridgeSettings(panelMode);
      const a = await patchRuntimeEnv(device, "QUASAR_MODE", st.bridgeMode);
      if (!a.ok) return fail(a.error ?? "не удалось записать runtime.env");
      const b = await patchConfig(device, (cfg) => {
        cfg.mode = st.bridgeMode;
        if (st.listenAfterReply !== undefined) cfg.listen_after_reply = st.listenAfterReply;
        if (st.routing) {
          const prev = (cfg.routing && typeof cfg.routing === "object" ? cfg.routing : {}) as Record<string, unknown>;
          // сохраняем чужие поля routing (refusal и т.п.) и поля classifier (prompt, timeout_ms), подменяем наши
          const next = structuredClone(st.routing);
          const prevCls = (prev.classifier && typeof prev.classifier === "object" ? prev.classifier : {}) as Record<string, unknown>;
          cfg.routing = { ...prev, ...next, classifier: { ...prevCls, ...next.classifier } };
        }
      });
      if (!b.ok) return fail(b.error ?? "не удалось записать config.json");
    }
    if (model !== undefined) {
      const a = await patchRuntimeEnv(device, "QUASAR_LLM_MODEL", model);
      if (!a.ok) return fail(a.error ?? "не удалось записать runtime.env");
    }

    step("check");
    const chk = await adbExec(["-s", device, "shell", `sh ${APP}/control.sh check 2>&1`], 15000);
    const chkOut = (chk.stdout + chk.stderr).trim();
    if (!chk.ok || !/configuration is valid/i.test(chkOut)) {
      const reason = chkOut.match(/"error":"([^"]+)"/)?.[1] ?? chkOut.slice(-140);
      return fail(`конфигурация отклонена: ${reason}. Настройки возвращены`);
    }

    step("restart");
    const r = await restartBridge(device);
    if (!r.ok) return fail(r.error ?? "restart не удался");

    step("wait");
    const pid = await waitHealthy(device, 30000, oldPid);
    if (pid === null) return fail("мост не стал healthy с новым PID за 30 с (настройки возвращены, перезапустите мост)");
    dropSnap();
    return { ok: true, pid };
  } finally {
    applying.delete(device);
    statusCache.delete(device);
  }
}

/** Смена режима колонки (alice|hybrid|llm). */
export async function setBridgeMode(
  mode: PanelMode,
  device = firstDevice(),
): Promise<{ ok: boolean; error?: string }> {
  return applyBridgeChange(device, { mode });
}

/** Смена модели. */
export async function setBridgeModel(model: string, device = firstDevice()): Promise<{ ok: boolean; error?: string }> {
  return applyBridgeChange(device, { model });
}

/** Последние строки лога моста. */
export async function bridgeLogTail(lines = 100, device = firstDevice()): Promise<string[]> {
  const n = Math.min(Math.max(lines, 1), 300);
  const r = await adbExec(["-s", device, "shell", `tail -n ${n} ${STATE}/service.log 2>/dev/null`], 10000);
  if (!r.ok) return [];
  return r.stdout.split("\n").filter((l) => l.trim().length > 0);
}
