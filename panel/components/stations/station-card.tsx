"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import { shortModelName } from "@/lib/modelNames";
import type { StationView } from "@/lib/stationView";
import { ModeBadge, StatusBadge } from "./status-badge";
import { StationSvg, ringTone } from "./station-svg";

export function StationCard({ s }: { s: StationView }) {
  const offline = s.state === "offline";
  const model = offline ? s.last?.model : s.model;
  const mode = offline ? s.last?.mode : s.mode;
  const ip = s.ip ?? s.device.split(":")[0];

  return (
    <Link
      href={`/stations/${s.id}`}
      className={cn(
        "group flex min-h-[7.5rem] gap-4 rounded-xl border border-zinc-800 bg-zinc-950/60 p-4 transition-colors",
        "hover:border-zinc-600 focus-visible:border-zinc-500 focus-visible:outline-none",
        offline && "opacity-65",
      )}
    >
      <StationSvg
        kind={s.kind}
        tone={ringTone(s.state, s.mode)}
        label={`${s.name}: ${s.state}`}
        className="h-[72px] w-14 self-center"
      />

      <div className="flex min-w-0 flex-1 flex-col justify-between gap-2">
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="min-w-0 truncate text-[15px] font-medium text-zinc-100">{s.name}</h2>
            <StatusBadge state={s.state} />
          </div>

          <div className="flex min-w-0 items-center gap-2 text-sm">
            {offline ? (
              <span className="min-w-0 truncate text-zinc-500" title={model}>
                {model ? <>была: {shortModelName(model)}</> : "нет данных"}
              </span>
            ) : (
              <>
                <ModeBadge mode={mode} />
                <span className="min-w-0 truncate text-zinc-300" title={model}>
                  {shortModelName(model)}
                </span>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between font-mono text-[11px] text-zinc-500">
          <span>{ip}</span>
          <span aria-hidden className="transition-transform group-hover:translate-x-0.5">
            →
          </span>
        </div>
      </div>
    </Link>
  );
}
