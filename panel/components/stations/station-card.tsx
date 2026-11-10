"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { KeyboardEvent } from "react";
import { Terminal } from "lucide-react";
import { cn } from "@/lib/utils";
import { shortModelName } from "@/lib/modelNames";
import type { StationView } from "@/lib/stationView";
import { ModeBadge, StatusBadge } from "./status-badge";
import { StationSvg, ringTone } from "./station-svg";
import { AgentBadge } from "./agent-bind";

export function StationCard({ s }: { s: StationView }) {
  const router = useRouter();
  const offline = s.state === "offline";
  const model = offline ? s.last?.model : s.model;
  const mode = offline ? s.last?.mode : s.mode;
  const ip = s.ip ?? s.device.split(":")[0];
  const href = `/stations/${s.id}`;

  // Карточка целиком — кликабельная, но внутри есть настоящий <Link> на #adb.
  // Поэтому обёртка — div (role=link), а не <a>: иначе получаются вложенные <a>
  // (React: "In HTML, <a> cannot be a descendant of <a>" — ошибка гидратации).
  const open = () => router.push(href);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  };

  return (
    <div
      role="link"
      tabIndex={0}
      onClick={open}
      onKeyDown={onKeyDown}
      className={cn(
        "group flex min-h-[7.5rem] cursor-pointer gap-4 rounded-xl border border-zinc-800 bg-zinc-950/60 p-4 transition-colors",
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
          {s.agent && (
            <div className="flex min-w-0">
              <AgentBadge agent={s.agent} />
            </div>
          )}

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
          <span className="flex items-center gap-1">
            {/* быстрый вход в ADB-консоль колонки (спека: кнопка Terminal на карточке);
                stopPropagation — чтобы не срабатывал переход по всей карточке */}
            <Link
              href={`${href}#adb`}
              aria-label={`ADB-консоль: ${s.name}`}
              onClick={(e) => e.stopPropagation()}
              className="flex size-9 items-center justify-center rounded-lg border border-zinc-800 text-zinc-500 transition-colors hover:border-zinc-600 hover:text-zinc-200"
            >
              <Terminal className="size-4" />
            </Link>
            <span aria-hidden className="transition-transform group-hover:translate-x-0.5">
              →
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}
