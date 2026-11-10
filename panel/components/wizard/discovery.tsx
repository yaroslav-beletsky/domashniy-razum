"use client";

// Обнаружение колонки в сети (шаг «Поиск» мастера). Используется внутри диалога
// «Добавить колонку»: авто-discovery через стенд (recent_clients) + fallback-скан
// подсети + ручной ввод адреса. При входе САМ находит только что сброшенную колонку
// (стучавшуюся на стенд) и подставляет её IP + тип, с авто-переходом «Дальше».
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, CheckCircle2, Loader2, Plus, Radar } from "lucide-react";
import { cn } from "@/lib/utils";
import { api, postSse } from "@/lib/sseClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

export interface WizardMetaLite {
  subnet: string;
}

export interface Candidate {
  ip: string;
  adb: boolean;
  alive: boolean;
  known?: string;
}

/** Отметка шагов подготовки (сброс/Wi-Fi), собранная диалогом добавления. */
export type PrepMarks = { reset?: "done" | "skipped"; wifi?: "done" | "skipped" };

export const KINDS = [
  { v: "unknown", l: "Не знаю" },
  { v: "max", l: "Max" },
  { v: "mini", l: "Mini" },
  { v: "lite", l: "Lite" },
  { v: "station2", l: "Станция 2" },
];

/** PLATFORM → тип колонки (kind) для авто-discovery. */
const PLATFORM_KIND: Record<string, string> = {
  yandexmidi: "station2",
  yandexmini_2: "mini",
  yandexmini: "mini",
  yandexstation: "max",
  yandexstation_2: "max",
  yandexmicro: "lite",
};

function platformToKind(platform: string): string {
  return PLATFORM_KIND[platform] ?? "unknown";
}

function kindLabel(kind: string): string {
  return KINDS.find((k) => k.v === kind)?.l ?? "Не знаю";
}

/** IP, которые НИКОГДА не считаем «новой колонкой» (известные, инфраструктура). */
const EXCLUDE_IPS = new Set([
  "192.168.88.1",    // роутер
  "192.168.88.23",   // стенд
  "192.168.88.35",   // DNS/AdGuard
  "192.168.88.207",  // прод-панель
  "192.168.88.79",   // колонка в реестре (Мини 2)
]);

interface StandClient {
  ip: string;
  ts: number;
  path: string;
  platform: string;
  version: string;
  ua: string;
  mac?: string;
}

interface AutoFound {
  ip: string;
  kind: string;
  label: string;
  age: number;
  mac?: string;
}

/** OUI Yandex-устройств (колонки). Колонка в фазе настройки стучит только /generate_204 —
 *  без platform; MAC из ARP стенда помогает не принять её за случайный браузерный трафик. */
const YANDEX_OUI = "b8:87:6e";

export function Discovery({
  meta,
  onCreated,
  prep,
}: {
  meta: WizardMetaLite;
  onCreated: (key: string) => void;
  prep?: PrepMarks;
}) {
  const [subnet, setSubnet] = useState(meta.subnet);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<string>("");
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("5555");
  const [name, setName] = useState("");
  const [kind, setKind] = useState("unknown");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  // ---------- авто-discovery через стенд ----------
  const [autoDiscovering, setAutoDiscovering] = useState(true);
  const [autoFound, setAutoFound] = useState<AutoFound | null>(null);
  const autoRan = useRef(false);
  const autoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const createDraft = useCallback(
    async (h: string, p: string, k?: string, m?: string) => {
      setBusy(true);
      setErr(null);
      try {
        const j = await api<{ key: string }>("/api/wizard/state", {
          method: "POST",
          body: {
            action: "create",
            host: h,
            port: Number(p) || 5555,
            name,
            kind: k ?? kind,
            mac: m,
            prep,
          },
        });
        onCreated(j.key);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "не удалось создать черновик");
      } finally {
        setBusy(false);
      }
    },
    [name, kind, prep, onCreated],
  );

  const doAutoDiscover = useCallback(async () => {
    if (autoRan.current) return;
    autoRan.current = true;
    setAutoDiscovering(true);

    try {
      // 1. получаем список недавних клиентов стенда
      const sc = await api<{ ok: boolean; clients: StandClient[] }>(
        "/api/wizard/stand-clients",
      );
      if (!sc.ok || !sc.clients?.length) {
        setAutoDiscovering(false);
        return;
      }

      // 2. получаем реестр колонок панели (чтобы исключить уже известные)
      const knownIPs = new Set(EXCLUDE_IPS);
      try {
        const stations = await api<{ stations: { device: string }[] }>(
          "/api/stations",
        );
        if (stations.stations) {
          for (const s of stations.stations) {
            const ip = (s.device ?? "").split(":")[0];
            if (ip) knownIPs.add(ip);
          }
        }
      } catch {
        /* реестр недоступен — используем только EXCLUDE_IPS */
      }

      // 3. фильтруем: исключаем известные, только свежие (≤ 10 мин), с platform
      //    ИЛИ колонка-в-настройке (generate_204 без platform, но MAC Яндекса)
      const now = Date.now() / 1000;
      const looksStation = (c: StandClient) =>
        Boolean(c.platform) || (c.mac ?? "").toLowerCase().startsWith(YANDEX_OUI);
      const fresh = sc.clients.filter(
        (c) =>
          looksStation(c) &&
          !knownIPs.has(c.ip) &&
          now - c.ts < 600, // 10 минут
      );

      // 4. группируем по IP (берём самую свежую запись для каждого)
      const byIP = new Map<string, StandClient>();
      for (const c of fresh) {
        const prev = byIP.get(c.ip);
        if (!prev || c.ts > prev.ts) byIP.set(c.ip, c);
      }

      if (byIP.size === 0) {
        setAutoDiscovering(false);
        return;
      }

      // 5. берём самую свежую (приоритет — с известной platform, иначе самая свежая)
      const sorted = [...byIP.values()].sort(
        (a, b) => Number(Boolean(b.platform)) - Number(Boolean(a.platform)) || b.ts - a.ts,
      );
      const best = sorted[0];
      const k = best.platform ? platformToKind(best.platform) : "unknown";
      const age = Math.round(now - best.ts);

      const found: AutoFound = {
        ip: best.ip,
        kind: k,
        mac: best.mac,
        label: `нашли: ${best.ip}${k !== "unknown" ? ` (${kindLabel(k)})` : ""}, ${
          age < 60 ? "только что" : `${age} с назад`
        }`,
        age,
      };

      // авто-заполняем поля
      setHost(best.ip);
      setKind(k);
      if (best.version) {
        setName(kindLabel(k));
      }

      setAutoFound(found);
      setAutoDiscovering(false);
    } catch {
      setAutoDiscovering(false);
    }
  }, []);

  useEffect(() => {
    doAutoDiscover();
  }, [doAutoDiscover]);

  // авто-создание черновика при находке колонки (отдельный эффект)
  useEffect(() => {
    if (autoFound) {
      autoTimer.current = setTimeout(() => {
        void createDraft(autoFound.ip, "5555", autoFound.kind, autoFound.mac);
      }, 1800);
    }
    return () => {
      if (autoTimer.current) {
        clearTimeout(autoTimer.current);
        autoTimer.current = null;
      }
    };
  }, [autoFound, createDraft]);

  // ---------- скан ----------

  const runScan = async () => {
    setScanning(true);
    setErr(null);
    setCandidates(null);
    setProgress("…");
    abort.current = new AbortController();
    const found: Candidate[] = [];
    const r = await postSse(
      "/api/wizard/scan",
      { subnet },
      (m) => {
        const d = m.data;
        if (d.type === "progress") setProgress(`${d.scanned}/${d.total}`);
        if (d.type === "host")
          found.push({
            ip: String(d.ip),
            adb: true,
            alive: true,
            known: d.known ? String(d.known) : undefined,
          });
        if (d.type === "done" && Array.isArray(d.candidates))
          setCandidates(d.candidates as Candidate[]);
        if (d.type === "error") setErr(String(d.error));
      },
      abort.current.signal,
    );
    if (!r.ok && r.status !== 0) setErr(r.error ?? "ошибка сканирования");
    if (!candidates) setCandidates(found);
    setScanning(false);
  };

  const create = async (h: string, p: string) => {
    await createDraft(h, p);
  };

  return (
    <div className="flex flex-col gap-3">
      {/* --- авто-discovery через стенд --- */}
      {autoDiscovering && !autoFound && (
        <Card className="border-sky-900/40 bg-sky-950/20">
          <CardContent className="flex items-center gap-3 px-4 py-3">
            <Loader2 className="size-4 animate-spin text-sky-400" />
            <span className="text-[13px] text-sky-200">
              ищу только что сброшенную колонку через стенд…
            </span>
          </CardContent>
        </Card>
      )}

      {autoFound && (
        <Card className="border-emerald-900/60 bg-emerald-950/30">
          <CardContent className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <CheckCircle2 className="size-5 text-emerald-400" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-emerald-200">
                  {autoFound.label}
                </div>
                <div className="mt-0.5 font-mono text-[10px] text-emerald-600">
                  тип «{kindLabel(autoFound.kind)}» · порт 5555 · стенд видел
                  запрос
                </div>
              </div>
              <Badge
                variant="outline"
                className="h-5 border-emerald-900 px-1.5 font-mono text-[10px] text-emerald-300"
              >
                авто-поиск
              </Badge>
              <Button
                size="sm"
                className="h-8 gap-1.5"
                disabled={busy}
                onClick={() =>
                  void createDraft(autoFound.ip, "5555", autoFound.kind, autoFound.mac)
                }
              >
                {busy ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <ArrowRight className="size-3.5" />
                )}
                Дальше
              </Button>
            </div>
            {/* отмена авто-перехода */}
            <div className="mt-2 flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px] text-zinc-500"
                onClick={() => {
                  if (autoTimer.current) clearTimeout(autoTimer.current);
                  setAutoFound(null);
                  setAutoDiscovering(false);
                }}
              >
                отмена — буду выбирать вручную
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* --- ручной скан (fallback) --- */}
      <Card className="border-zinc-800/70">
        <CardHeader className="px-4 py-3">
          <CardTitle className="flex items-center gap-2 text-xs font-medium tracking-wide text-zinc-400 uppercase">
            <Radar className="size-3.5" /> Поиск колонок в сети
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-3">
          <p className="mb-2 text-[13px] text-zinc-400">
            {autoFound
              ? "Колонка уже найдена через стенд — ниже можно пересканировать, если адрес не тот."
              : "Найду устройства в сети — колонки с открытым портом 5555 покажу первыми."}
          </p>
          <details className="group mb-3">
            <summary className="cursor-pointer select-none text-[11px] text-zinc-600 transition-colors hover:text-zinc-400">
              Как определяется колонка
            </summary>
            <p className="mt-1 text-[11px] leading-snug text-zinc-500">
              При входе — опрос стенда (стучалась ли колонка только что) + сканирование
              подсети по :5555. Колонка в фазе настройки стучит только /generate_204 —
              её узнаём по MAC из ARP стенда. «Похоже на колонку» — эвристика по открытым
              портам.
            </p>
          </details>
          <div className="flex flex-wrap items-end gap-2">
            <div className="grid gap-1.5">
              <Label htmlFor="wiz-subnet">Подсеть</Label>
              <Input
                id="wiz-subnet"
                value={subnet}
                onChange={(e) => setSubnet(e.target.value)}
                className="h-11 w-36 font-mono sm:h-9"
              />
            </div>
            <Button
              onClick={runScan}
              disabled={scanning}
              className="h-11 gap-1.5 sm:h-9"
            >
              {scanning ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Radar className="size-4" />
              )}
              {scanning ? `скан ${progress}` : "Сканировать заново"}
            </Button>
            {scanning && (
              <Button
                variant="ghost"
                className="h-11 sm:h-9"
                onClick={() => abort.current?.abort()}
              >
                Стоп
              </Button>
            )}
          </div>

          {candidates !== null && (
            <div className="mt-3 flex flex-col gap-1.5">
              {candidates.length === 0 && (
                <div className="font-mono text-xs text-zinc-500">
                  ничего не найдено — колонка выключена или не в сети
                </div>
              )}
              {candidates.map((c) => (
                <div
                  key={c.ip}
                  className="flex flex-wrap items-center gap-2 rounded-md border border-zinc-800 px-3 py-2"
                >
                  <span className="font-mono text-sm text-zinc-200">
                    {c.ip}
                  </span>
                  {c.adb ? (
                    <Badge
                      variant="outline"
                      className="h-5 gap-1 border-emerald-900 px-1.5 font-mono text-[10px] text-emerald-300"
                    >
                      :5555 открыт — похоже на колонку
                    </Badge>
                  ) : (
                    <Badge
                      variant="outline"
                      className="h-5 gap-1 border-zinc-800 px-1.5 font-mono text-[10px] text-zinc-500"
                    >
                      в сети, :5555 закрыт
                    </Badge>
                  )}
                  {c.known && (
                    <Badge
                      variant="outline"
                      className="h-5 gap-1 border-sky-900 px-1.5 font-mono text-[10px] text-sky-300"
                    >
                      в реестре: {c.known}
                    </Badge>
                  )}
                  <Button
                    size="sm"
                    variant="secondary"
                    className="ml-auto h-8"
                    disabled={busy}
                    onClick={() => void create(c.ip, "5555")}
                  >
                    Выб��ать
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* --- ручной ввод (fallback) --- */}
      <Card className="border-zinc-800/70">
        <CardHeader className="px-4 py-3">
          <CardTitle className="text-xs font-medium tracking-wide text-zinc-400 uppercase">
            Или введите адрес вручную
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-3">
          <div className="grid grid-cols-[1fr_5.5rem] gap-2">
            <div className="grid gap-1.5">
              <Label htmlFor="wiz-host">IP-адрес колонки</Label>
              <Input
                id="wiz-host"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="192.168.88.80"
                inputMode="decimal"
                className="h-11 font-mono sm:h-9"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="wiz-port">Порт</Label>
              <Input
                id="wiz-port"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                inputMode="numeric"
                className="h-11 font-mono sm:h-9"
              />
            </div>
          </div>
          <div className="mt-2 grid gap-1.5">
            <Label htmlFor="wiz-name">Комната (необязательно)</Label>
            <Input
              id="wiz-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={40}
              placeholder="Гостиная"
              className="h-11 sm:h-9"
            />
          </div>
          <div className="mt-2 grid gap-1.5">
            <Label>Тип</Label>
            <div
              role="radiogroup"
              aria-label="Тип колонки"
              className="grid grid-cols-3 gap-1.5 sm:grid-cols-5"
            >
              {KINDS.map((k) => (
                <button
                  key={k.v}
                  type="button"
                  role="radio"
                  aria-checked={kind === k.v}
                  onClick={() => setKind(k.v)}
                  className={cn(
                    "h-11 rounded-md border px-1 text-xs transition-colors sm:h-9",
                    kind === k.v
                      ? "border-zinc-500 bg-zinc-800 text-zinc-50"
                      : "border-zinc-800 text-zinc-400 hover:border-zinc-600",
                  )}
                >
                  {k.l}
                </button>
              ))}
            </div>
          </div>
          {err && (
            <p role="alert" className="mt-2 text-xs text-amber-400">
              {err}
            </p>
          )}
          <div className="mt-3 flex justify-end">
            <Button
              className="h-11 gap-1.5 sm:h-9"
              disabled={busy || !host.trim()}
              onClick={() => void create(host.trim(), port)}
            >
              {busy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Plus className="size-4" />
              )}{" "}
              Продолжить
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
