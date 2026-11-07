"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import { shortModelName } from "@/lib/modelNames";
import type { AgentView } from "@/lib/agentTypes";

function Pill({ children, tone = "muted", title }: { children: React.ReactNode; tone?: "muted" | "warn"; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-5 max-w-full items-center truncate rounded border px-1.5 font-mono text-[11px]",
        tone === "warn" ? "border-amber-900/60 bg-amber-950/30 text-amber-300" : "border-zinc-800 bg-zinc-900/60 text-zinc-400",
      )}
    >
      <span className="truncate">{children}</span>
    </span>
  );
}

export function AgentAvatar({ avatar, title, className }: { avatar?: string; title: string; className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        "flex size-10 shrink-0 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 font-mono text-sm text-zinc-300",
        className,
      )}
    >
      {avatar || title.slice(0, 2).toUpperCase()}
    </div>
  );
}

export function AgentCard({ a }: { a: AgentView }) {
  const bound = a.rooms.length;
  const extra = bound > 2 ? bound - 2 : 0;
  return (
    <Link
      href={`/agents/${a.slug}`}
      className="group flex min-h-[8.5rem] flex-col justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-950/60 p-4 transition-colors hover:border-zinc-600 focus-visible:border-zinc-500 focus-visible:outline-none"
    >
      <div className="flex items-start gap-3">
        <AgentAvatar avatar={a.meta.avatar} title={a.title} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-medium text-zinc-100">{a.title}</h2>
          <p className="truncate text-xs text-zinc-400">{a.meta.description || <span className="text-zinc-600">без описания</span>}</p>
        </div>
        {bound > 0 ? (
          <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] text-emerald-400">
            <span aria-hidden className="size-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]" />
            {bound} {bound === 1 ? "колонка" : "колонки"}
          </span>
        ) : (
          <span className="shrink-0 rounded border border-zinc-800 px-1.5 font-mono text-[11px] leading-5 text-zinc-500">черновик</span>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        <Pill title={a.model}>{shortModelName(a.model, 24)}</Pill>
        {a.toolCount > 0 ? (
          a.mcpErr > 0 ? (
            <Pill tone="warn">MCP · {a.mcpErr} err</Pill>
          ) : (
            <Pill>MCP · {a.toolCount} инстр.</Pill>
          )
        ) : (
          <Pill>без MCP</Pill>
        )}
        {a.rooms.slice(0, 2).map((r) => (
          <Pill key={r}>{r}</Pill>
        ))}
        {extra > 0 && <Pill>+{extra}</Pill>}
        {bound === 0 && <Pill>не привязан</Pill>}
      </div>
    </Link>
  );
}
