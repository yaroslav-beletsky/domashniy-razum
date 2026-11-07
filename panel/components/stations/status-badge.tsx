"use client";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { MODE_INFO, normalizeMode, type PanelMode } from "@/lib/modes";

export type StationState = "healthy" | "bridge-down" | "offline" | "applying";

const MAP: Record<StationState, { text: string; dot: string; cls: string }> = {
  healthy: {
    text: "online",
    dot: "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]",
    cls: "border-emerald-900/60 text-emerald-400",
  },
  "bridge-down": { text: "bridge down", dot: "bg-amber-400 station-pulse", cls: "border-amber-900/60 text-amber-400" },
  applying: { text: "применяем…", dot: "bg-amber-400 station-pulse", cls: "border-amber-900/60 text-amber-400" },
  // оффлайн — не красный: просто «погасший»
  offline: { text: "offline", dot: "bg-zinc-600", cls: "border-zinc-800 text-zinc-500" },
};

export function StatusBadge({ state, className }: { state: StationState; className?: string }) {
  const m = MAP[state];
  return (
    <Badge variant="outline" className={cn("h-5 shrink-0 gap-1.5 px-1.5 font-mono text-[11px] font-normal", m.cls, className)}>
      <span aria-hidden className={cn("inline-block size-1.5 rounded-full", m.dot)} />
      {m.text}
    </Badge>
  );
}

const MODE_CLS: Record<PanelMode, string> = {
  alice: "border-sky-900/70 bg-sky-950/30 text-sky-300",
  hybrid: "border-violet-900/70 bg-violet-950/30 text-violet-300",
  llm: "border-emerald-900/70 bg-emerald-950/30 text-emerald-300",
};

export function ModeBadge({ mode, muted }: { mode?: string; muted?: boolean }) {
  const pm = normalizeMode(mode);
  if (!pm) return null;
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-5 shrink-0 px-1.5 font-mono text-[10px] font-medium tracking-wider",
        muted ? "border-zinc-800 text-zinc-500" : MODE_CLS[pm],
      )}
    >
      {MODE_INFO[pm].badge}
    </Badge>
  );
}
