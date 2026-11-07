"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Bot, Loader2, Unplug } from "lucide-react";
import { api, postSse } from "@/lib/sseClient";
import type { AgentView } from "@/lib/agentTypes";
import type { StationView } from "@/lib/stationView";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

/** Бейдж «Агент: имя ↗». На карточке (внутри Link) — без вложенной ссылки. */
export function AgentBadge({ agent, link }: { agent: { slug: string; name: string }; link?: boolean }) {
  const cls = "inline-flex h-5 max-w-full items-center gap-1 truncate rounded border border-violet-900/60 bg-violet-950/30 px-1.5 font-mono text-[11px] text-violet-300";
  const body = (
    <>
      <Bot className="size-3 shrink-0" aria-hidden />
      <span className="truncate">Агент: {agent.name}</span>
      {link && <span aria-hidden>↗</span>}
    </>
  );
  return link ? (
    <Link href={`/agents/${agent.slug}`} className={`${cls} hover:border-violet-700`}>
      {body}
    </Link>
  ) : (
    <span className={cls}>{body}</span>
  );
}

/** Блок «Агент» на странице станции: подключить к агенту / отключить, с прогрессом. */
export function AgentBind({
  station,
  disabled,
  onBusy,
  onDone,
}: {
  station: StationView;
  disabled: boolean;
  onBusy: (busy: boolean) => void;
  onDone: (msg: string) => void;
}) {
  const [agents, setAgents] = useState<AgentView[] | null>(null);
  const [pick, setPick] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ agents: AgentView[] }>("/api/agents")
      .then((j) => setAgents(j.agents))
      .catch(() => setAgents([]));
  }, []);

  const bound = station.agent;
  const choices = (agents ?? []).filter((a) => a.slug !== bound?.slug);
  const chosen = pick || choices[0]?.slug || "";

  const run = async (op: "connect" | "disconnect") => {
    if (running) return;
    setRunning(true);
    onBusy(true);
    setError(null);
    setProgress("запуск…");
    let failed: string | null = null;
    let done = false;
    const res = await postSse(
      `/api/stations/${station.id}/${op === "connect" ? "connect-agents" : "disconnect-agents"}`,
      op === "connect" ? { agent: chosen } : {},
      ({ data }) => {
        if (data.type === "step") setProgress(`${data.index}/${data.total} ${data.label}`);
        else if (data.type === "done") done = true;
        else if (data.type === "error") failed = String(data.error);
      },
    ).catch((e) => ({ ok: false, status: 0, error: e instanceof Error ? e.message : "соединение прервано" }));
    if (!res.ok) failed = res.error ?? "ошибка";
    if (!failed && !done) failed = "поток закрылся без итога — проверьте состояние колонки";
    setRunning(false);
    onBusy(false);
    setProgress(null);
    if (failed) setError(failed);
    else onDone(op === "connect" ? "Колонка подключена к агенту" : "Колонка отключена от агента");
  };

  const off = disabled || running;

  return (
    <div className="grid min-w-0 gap-1.5 sm:col-span-2">
      <Label className="text-xs text-zinc-500">Агент (agent-service)</Label>
      <div className="flex flex-wrap items-center gap-2">
        {bound ? (
          <>
            <AgentBadge agent={bound} link />
            <Button variant="outline" className="h-11 gap-1.5 px-3 sm:h-9" disabled={off} onClick={() => run("disconnect")}>
              {running ? <Loader2 className="size-4 animate-spin" /> : <Unplug className="size-4" />} Отключить
            </Button>
          </>
        ) : agents === null ? (
          <span className="text-xs text-zinc-500">загрузка агентов…</span>
        ) : choices.length === 0 ? (
          <span className="text-xs text-zinc-500">
            Агентов нет. <Link href="/agents" className="text-zinc-300 underline underline-offset-2">Создать</Link>
          </span>
        ) : (
          <>
            <select
              aria-label="Агент для подключения"
              value={chosen}
              onChange={(e) => setPick(e.target.value)}
              disabled={off}
              className="h-11 min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 text-sm text-zinc-200 sm:h-9 sm:max-w-64"
            >
              {choices.map((a) => (
                <option key={a.slug} value={a.slug}>
                  {a.title}
                </option>
              ))}
            </select>
            <Button className="h-11 gap-1.5 px-3 sm:h-9" disabled={off || !chosen} onClick={() => run("connect")}>
              {running ? <Loader2 className="size-4 animate-spin" /> : <Bot className="size-4" />} Подключить к агенту
            </Button>
          </>
        )}
      </div>
      {bound && choices.length > 0 && (
        <p className="text-xs text-zinc-500">Чтобы сменить агента, выберите другого на его странице или сначала отключите.</p>
      )}
      {progress && (
        <p role="status" className="font-mono text-[11px] text-zinc-400">
          {progress}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-amber-400">
          {error}
        </p>
      )}
    </div>
  );
}
