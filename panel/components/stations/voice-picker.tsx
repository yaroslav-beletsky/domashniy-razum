"use client";

// Голос колонки: выбор TTS моста-форка. Мост читает tts.override перед каждым ответом,
// применение мгновенное, рестарт не нужен. Блок виден всегда: загрузка / ошибка / «не установлен»
// — по одной строке, без простыней. Полное объяснение — под «?»-тултип.
import { useCallback, useEffect, useState } from "react";
import { Check, Info, Loader2, RefreshCw, Volume2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

const MALE: Array<{ v: string; l: string }> = [
  { v: "ermil", l: "ermil" },
  { v: "zahar", l: "zahar" },
];
const FEMALE: Array<{ v: string; l: string }> = [
  { v: "oksana", l: "oksana" },
  { v: "jane", l: "jane" },
  { v: "shitova", l: "shitova" },
  { v: "omazh", l: "omazh" },
];
const EMOTIONS: Array<{ v: "" | "good" | "neutral"; l: string }> = [
  { v: "", l: "базовая" },
  { v: "good", l: "радостная" },
  { v: "neutral", l: "нейтральная" },
];
const SELECT_CLS =
  "h-11 min-w-0 rounded-md border border-zinc-700 bg-zinc-950 px-2 text-sm text-zinc-200 focus:border-zinc-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 sm:h-9";

/** «ermil@good» → { pick: "ermil", emo: "good" } */
function splitVoice(v: string | null): { pick: string; emo: "" | "good" | "neutral" } {
  if (!v) return { pick: "default", emo: "" };
  const at = v.indexOf("@");
  const base = at < 0 ? v : v.slice(0, at);
  const emo = at < 0 ? "" : (v.slice(at + 1) as "" | "good" | "neutral");
  const known = [...MALE, ...FEMALE].some((x) => x.v === base);
  return { pick: known ? base : "default", emo: emo === "good" || emo === "neutral" ? emo : "" };
}

const valueOf = (pick: string, emo: string) => (pick === "default" ? "" : emo ? `${pick}@${emo}` : pick);

export function VoicePicker({
  stationId,
  disabled,
  onDone,
}: {
  stationId: string;
  /** Колонка не на связи / идёт применение настроек. */
  disabled?: boolean;
  /** Сообщение для тоста страницы после успешного применения. */
  onDone?: (msg: string) => void;
}) {
  const [state, setState] = useState<{ installed: boolean; voice: string | null } | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [pick, setPick] = useState("default");
  const [emo, setEmo] = useState<"" | "good" | "neutral">("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadErr(null);
    try {
      const r = await fetch(`/api/stations/${stationId}/voice`, { cache: "no-store" });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; installed?: boolean; voice?: string | null; error?: string };
      if (!j.ok) {
        setLoadErr(j.error ?? `ошибка ${r.status}`);
        return;
      }
      setState({ installed: Boolean(j.installed), voice: j.voice ?? null });
      const s = splitVoice(j.voice ?? null);
      setPick(s.pick);
      setEmo(s.emo);
    } catch {
      setLoadErr("нет связи с панелью");
    }
  }, [stationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const apply = async () => {
    if (busy || disabled) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/stations/${stationId}/voice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voice: valueOf(pick, emo) }),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; installed?: boolean; voice?: string | null; error?: string };
      if (!j.ok) {
        if (j.installed === false) setState({ installed: false, voice: null });
        setErr(j.error ?? `ошибка ${r.status}`);
        return;
      }
      setState({ installed: Boolean(j.installed), voice: j.voice ?? null });
      const s = splitVoice(j.voice ?? null);
      setPick(s.pick);
      setEmo(s.emo);
      onDone?.(j.voice ? `Голос: ${j.voice}` : "Голос: штатный (женский)");
    } catch {
      setErr("нет связи с панелью");
    } finally {
      setBusy(false);
    }
  };

  const change = (p: string, e: "" | "good" | "neutral") => {
    setPick(p);
    setEmo(e);
    setErr(null);
  };
  const dirty = Boolean(state?.installed) && valueOf(pick, emo) !== (state?.voice ?? "");

  return (
    <section aria-label="Голос колонки" className="grid gap-2.5 rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
      <div className="flex min-w-0 items-center gap-1.5">
        <h2 className="flex shrink-0 items-center gap-1.5 text-xs font-medium tracking-wide text-zinc-400 uppercase">
          <Volume2 className="size-3.5" /> Голос
        </h2>
        {state && (
          <span className="min-w-0 truncate font-mono text-[11px] text-zinc-500">
            {loadErr ? "" : state.installed ? `· ${state.voice ?? "штатный (женский)"}` : "· мост-форк не установлен"}
          </span>
        )}
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Как работает смена голоса"
                className="ml-auto flex size-11 items-center justify-center text-zinc-600 transition-colors hover:text-zinc-300 sm:size-6"
              >
                <Info className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-72 text-balance">
              Мост читает tts.override перед каждым ответом — смена действует сразу, рестарт не нужен. «Штатный» удаляет файл.
              Эмоцию поддерживают не все голоса.
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {loadErr ? (
        <div className="flex items-center gap-2">
          <p role="alert" className="min-w-0 flex-1 truncate text-xs text-amber-400">
            {loadErr}
          </p>
          <Button type="button" variant="outline" size="icon" aria-label="Повторить" className="size-11 shrink-0 sm:size-8" onClick={() => void load()}>
            <RefreshCw className="size-4" />
          </Button>
        </div>
      ) : !state ? (
        <p className="text-xs text-zinc-600">загрузка…</p>
      ) : !state.installed ? (
        <p className="text-xs leading-snug text-zinc-500">
          Голос штатный (женский). Управление появится, когда на колонке установлен мост-форк (мастер настройки).
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Голос"
              value={pick}
              onChange={(e) => change(e.target.value, emo)}
              disabled={disabled || busy}
              className={cn(SELECT_CLS, "flex-1 basis-40 sm:max-w-56")}
            >
              <option value="default">Штатный (женский)</option>
              <optgroup label="Мужские">
                {MALE.map((v) => (
                  <option key={v.v} value={v.v}>
                    {v.l}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Женские">
                {FEMALE.map((v) => (
                  <option key={v.v} value={v.v}>
                    {v.l}
                  </option>
                ))}
              </optgroup>
            </select>
            <select
              aria-label="Эмоция"
              value={emo}
              onChange={(e) => change(pick, e.target.value as "" | "good" | "neutral")}
              disabled={disabled || busy || pick === "default"}
              className={cn(SELECT_CLS, "flex-1 basis-36 sm:max-w-44", pick === "default" && "text-zinc-500")}
            >
              {EMOTIONS.map((e) => (
                <option key={e.v} value={e.v}>
                  {e.l}
                </option>
              ))}
            </select>
            <Button type="button" className="ml-auto h-11 gap-1.5 px-4 sm:h-9" onClick={() => void apply()} disabled={disabled || busy || !dirty}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} Применить
            </Button>
          </div>
          {err && (
            <p role="alert" className="truncate text-xs text-amber-400">
              {err}
            </p>
          )}
        </>
      )}
    </section>
  );
}
