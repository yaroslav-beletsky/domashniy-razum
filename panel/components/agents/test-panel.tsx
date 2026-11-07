"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, Send, Square, Wrench, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { postSse } from "@/lib/sseClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const PRESETS = ["Сколько сейчас времени?", "Какое сегодня число?", "Расскажи коротко, что ты умеешь", "Включи свет в гостиной"];
/** Лимит ответа навыка Диалогов ~4.5 с: всё, что дольше, на колонке рискует не дойти. */
const SLOW_MS = 4500;

interface ToolRow {
  name: string;
  ms: number;
  ok: boolean;
}

interface Run {
  prompt: string;
  text: string;
  tools: ToolRow[];
  rounds: number;
  fallback?: { from: string; to: string };
  done?: { ms_total: number; rounds: number; fallback_used: boolean; finish?: string; chars: number };
  error?: string;
  running: boolean;
}

const sec = (ms: number) => `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} с`;

export function TestPanel({ agent, dirty, className }: { agent: string; dirty: boolean; className?: string }) {
  const [prompt, setPrompt] = useState("");
  const [runs, setRuns] = useState<Run[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const running = runs.at(-1)?.running ?? false;

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [runs]);

  const patchLast = (fn: (r: Run) => Run) => setRuns((rs) => rs.map((r, i) => (i === rs.length - 1 ? fn(r) : r)));

  const send = async (text: string) => {
    const p = text.trim();
    if (!p || running) return;
    setPrompt("");
    setRuns((rs) => [...rs, { prompt: p, text: "", tools: [], rounds: 0, running: true }].slice(-8));
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await postSse(
        `/api/agents/${encodeURIComponent(agent)}/test`,
        { prompt: p },
        ({ event, data }) => {
          if (event === "round") patchLast((r) => ({ ...r, rounds: Number(data.n) || r.rounds + 1 }));
          else if (event === "tool_call")
            patchLast((r) => ({ ...r, tools: [...r.tools, { name: String(data.name), ms: Number(data.ms) || 0, ok: data.ok !== false }] }));
          else if (event === "delta") patchLast((r) => ({ ...r, text: r.text + String(data.text ?? "") }));
          else if (event === "fallback") patchLast((r) => ({ ...r, fallback: { from: String(data.from), to: String(data.to) } }));
          else if (event === "done") patchLast((r) => ({ ...r, running: false, done: data as unknown as Run["done"] }));
          else if (event === "error") patchLast((r) => ({ ...r, running: false, error: String(data.message ?? "ошибка") }));
        },
        ac.signal,
      );
      if (!res.ok) patchLast((r) => ({ ...r, running: false, error: res.error }));
      else patchLast((r) => (r.running ? { ...r, running: false, error: r.done ? undefined : "поток закрылся без итога" } : r));
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === "AbortError";
      patchLast((r) => ({ ...r, running: false, error: aborted ? "остановлено" : "соединение прервано" }));
    }
  };

  return (
    <section aria-label="Тест агента" className={cn("flex min-h-0 flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-950/60 p-4", className)}>
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-medium text-zinc-200">Тест</h2>
        <span className="font-mono text-[11px] text-zinc-500">как с колонки, без контекста комнаты</span>
      </div>

      {dirty && (
        <p role="status" className="rounded-md border border-amber-900/50 bg-amber-950/20 px-2.5 py-1.5 text-xs text-amber-300">
          Есть несохранённые правки — тест идёт по сохранённой версии. Нажмите «Сохранить».
        </p>
      )}

      <div className="flex min-h-40 flex-1 flex-col gap-3 overflow-y-auto" aria-live="polite">
        {runs.length === 0 && (
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => send(p)}
                className="min-h-11 rounded-full border border-zinc-700 px-3 text-xs text-zinc-300 transition-colors hover:border-zinc-500 sm:min-h-8"
              >
                {p}
              </button>
            ))}
          </div>
        )}

        {runs.map((r, i) => (
          <div key={i} className="grid gap-1.5">
            <p className="ml-auto max-w-[90%] rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100">{r.prompt}</p>

            {r.tools.length > 0 && (
              <ul className="grid gap-1" aria-label="Вызовы инструментов">
                {r.tools.map((t, k) => (
                  <li
                    key={k}
                    className={cn(
                      "flex items-center gap-2 rounded border px-2 py-1 font-mono text-[11px]",
                      t.ok ? "border-zinc-800 text-zinc-400" : "border-red-900/60 text-red-300",
                    )}
                  >
                    <Wrench className="size-3 shrink-0" aria-hidden />
                    <span className="min-w-0 flex-1 truncate" title={t.name}>
                      {t.name}
                    </span>
                    <span className={cn("shrink-0", t.ms > SLOW_MS && "text-amber-400")}>{sec(t.ms)}</span>
                    {t.ok ? <CheckCircle2 className="size-3.5 shrink-0 text-emerald-400" aria-label="успех" /> : <XCircle className="size-3.5 shrink-0 text-red-400" aria-label="ошибка" />}
                  </li>
                ))}
              </ul>
            )}

            {r.fallback && (
              <p className="font-mono text-[11px] text-amber-400">
                запасная модель: {r.fallback.from} → {r.fallback.to}
              </p>
            )}

            {r.text && <p className="whitespace-pre-wrap rounded-lg border border-zinc-800 px-3 py-1.5 text-sm text-zinc-200">{r.text}</p>}
            {r.running && (
              <p className="flex items-center gap-1.5 font-mono text-[11px] text-zinc-500">
                <Loader2 className="size-3 animate-spin" /> {r.rounds ? `раунд ${r.rounds}…` : "думаю…"}
              </p>
            )}
            {r.error && (
              <p role="alert" className="text-xs text-amber-400">
                {r.error}
              </p>
            )}
            {r.done && (
              <p className="flex flex-wrap gap-x-3 font-mono text-[11px] text-zinc-500">
                <span className={cn(r.done.ms_total > SLOW_MS && "text-amber-400")} title="Лимит навыка Диалогов ~4.5 с">
                  {sec(r.done.ms_total)}
                </span>
                <span>раундов: {r.done.rounds}</span>
                <span>{r.done.chars} симв.</span>
                {r.done.chars > 950 && <span className="text-amber-400">длиннее лимита Диалогов</span>}
                {r.done.fallback_used && <span className="text-amber-400">fallback</span>}
                {r.done.finish && <span>{r.done.finish}</span>}
              </p>
            )}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(prompt);
        }}
        className="flex gap-2"
      >
        <Input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Скажите что-нибудь агенту…"
          aria-label="Запрос к агенту"
          maxLength={2000}
          autoComplete="off"
          className="h-11 sm:h-9"
        />
        {running ? (
          <Button type="button" variant="outline" aria-label="Остановить" className="size-11 shrink-0 p-0 sm:size-9" onClick={() => abortRef.current?.abort()}>
            <Square className="size-4" />
          </Button>
        ) : (
          <Button type="submit" aria-label="Отправить" disabled={!prompt.trim()} className="size-11 shrink-0 p-0 sm:size-9">
            <Send className="size-4" />
          </Button>
        )}
      </form>
    </section>
  );
}
