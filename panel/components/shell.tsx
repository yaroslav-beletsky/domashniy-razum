"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Activity, AudioLines, Boxes, Gauge, KeyRound, Lock, ScrollText, Speaker } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

const NAV = [
  { href: "/", label: "Пульт", icon: Gauge },
  { href: "/models", label: "Модели", icon: Boxes },
  { href: "/voice", label: "Голос", icon: AudioLines },
  { href: "/stations", label: "Станции", icon: Speaker },
  { href: "/logs", label: "Логи", icon: ScrollText },
];

interface Status {
  litellm: { online: boolean; ms: number; modelCount: number; baseUrlHost: string; error?: string };
  keyConfigured: boolean;
  voice: { online: boolean; ms?: number; error?: string };
  station: { device: string; online: boolean };
}

function Dot({ ok }: { ok: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        ok ? "bg-emerald-400" : "bg-red-400",
        ok && "shadow-[0_0_6px_rgba(52,211,153,0.8)]",
      )}
    />
  );
}

function Chip({ ok, okText, badText, pending }: { ok: boolean | null; okText: string; badText: string; pending: string }) {
  return (
    <Badge variant="outline" className="h-6 gap-1.5 px-2 font-mono text-[11px] font-normal sm:h-5 sm:px-1.5">
      <Dot ok={Boolean(ok)} />
      {ok === null ? pending : ok ? okText : badText}
    </Badge>
  );
}

function StatusChips() {
  const [st, setSt] = useState<Status | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/status", { cache: "no-store" });
        if (r.ok && alive) setSt(await r.json());
      } catch {
        /* панель не падает без статуса */
      }
    };
    load();
    const t = setInterval(load, 10000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto sm:gap-2">
      <Chip
        ok={st === null ? null : st.litellm.online}
        okText={`LiteLLM ${st?.litellm.ms ?? 0} мс`}
        badText="LiteLLM offline"
        pending="LiteLLM …"
      />
      <Chip
        ok={st === null ? null : st.voice?.online}
        okText={`голос ${st?.voice?.ms ?? 0} мс`}
        badText="голос offline"
        pending="голос …"
      />
      <Chip
        ok={st === null ? null : st.station?.online}
        okText="станция ok"
        badText="станция offline"
        pending="станция …"
      />
      <Badge
        variant="outline"
        className={cn(
          "h-6 gap-1.5 px-2 font-mono text-[11px] font-normal sm:h-5 sm:px-1.5",
          st === null ? "" : st.keyConfigured ? "text-emerald-400" : "text-red-400",
        )}
      >
        {st?.keyConfigured ? <Lock className="size-3" /> : <KeyRound className="size-3" />}
        <span className="hidden sm:inline">{st === null ? "ключ …" : st.keyConfigured ? "ключ задан ✓" : "ключ не задан"}</span>
      </Badge>
    </div>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="flex min-h-svh flex-col md:flex-row">
      {/* Десктоп: сайдбар-рейл. Мобайл: нижняя навигация (оба рендерим, CSS прячет). */}
      <aside className="sticky top-0 z-20 hidden w-14 shrink-0 flex-col border-r bg-zinc-950/60 md:flex">
        <Link href="/" className="flex h-12 items-center justify-center border-b" title="station-llm · panel">
          <Activity className="size-4 text-zinc-400" />
        </Link>
        <nav className="flex flex-1 flex-col items-center gap-1 py-2">
          {NAV.map((item) => {
            const active = item.href === "/" ? pathname === "/" : pathname === item.href || pathname.startsWith(item.href + "/");
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                title={item.label}
                aria-label={item.label}
                className={cn(
                  "flex size-11 items-center justify-center rounded-md transition-colors md:size-9",
                  active ? "bg-zinc-800 text-zinc-50" : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300",
                )}
              >
                <Icon className="size-4" />
              </Link>
            );
          })}
        </nav>
        <div className="flex h-12 items-center justify-center border-t font-mono text-[10px] text-zinc-600">v0.2</div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-2 border-b bg-background/95 px-3 py-1.5 backdrop-blur sm:px-4">
          <div className="font-mono text-sm tracking-tight text-zinc-300">
            station-llm <span className="text-zinc-600">·</span> панель
          </div>
          <StatusChips />
        </header>
        <main className="min-h-0 flex-1 p-3 pb-24 sm:p-4 md:pb-4">{children}</main>
      </div>

      {/* Мобильная нижняя навигация */}
      <nav className="fixed inset-x-0 bottom-0 z-20 flex h-16 items-stretch border-t bg-zinc-950/95 backdrop-blur md:hidden">
        {NAV.map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname === item.href || pathname.startsWith(item.href + "/");
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-label={item.label}
              className={cn(
                "flex min-w-11 flex-1 flex-col items-center justify-center gap-0.5",
                active ? "text-zinc-50" : "text-zinc-500",
              )}
            >
              <span className={cn("flex size-8 items-center justify-center rounded-md", active && "bg-zinc-800")}>
                <Icon className="size-4" />
              </span>
              <span className="font-mono text-[9px]">{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
