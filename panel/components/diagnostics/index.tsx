"use client";

// «Диагностика» на странице агента: узкие утилиты, переехавшие с отдельных страниц
// (Пульт/Модели/Голос/Логи). Каждая — дисклоузер, по умолчанию закрыт, чтобы страница
// оставалась про агента; состояние раскрытия не сохраняется — это осознанно.
import { useState, type ReactNode } from "react";
import { Activity, ChevronDown, FlaskConical, Mic, ScrollText, Timer } from "lucide-react";
import { cn } from "@/lib/utils";
import { EventsFeed, StatsCard } from "./stats-events";
import { ModelsTestCard } from "./models-test";
import { VoiceTests } from "./voice-tests";
import { LogsViewer } from "./logs-viewer";

function Section({
  id,
  icon: Icon,
  title,
  hint,
  open,
  onToggle,
  children,
}: {
  id: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  hint: string;
  open: boolean;
  onToggle: (id: string) => void;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/40">
      <button
        type="button"
        onClick={() => onToggle(id)}
        aria-expanded={open}
        aria-controls={`diag-${id}`}
        className="flex min-h-11 w-full items-center gap-2 px-4 py-2.5 text-left sm:min-h-9"
      >
        <ChevronDown className={cn("size-4 shrink-0 text-zinc-500 transition-transform", !open && "-rotate-90")} aria-hidden />
        <Icon className="size-3.5 shrink-0 text-zinc-500" />
        <span className="text-sm font-medium text-zinc-200">{title}</span>
        <span className="ml-auto truncate font-mono text-[11px] text-zinc-600">{hint}</span>
      </button>
      {open && (
        <div id={`diag-${id}`} className="border-t border-zinc-800 p-3 sm:p-4">
          {children}
        </div>
      )}
    </div>
  );
}

export function Diagnostics() {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <section aria-label="Диагностика" className="grid gap-2">
      <h2 className="text-sm font-medium tracking-wide text-zinc-500 uppercase">Диагностика</h2>
      <Section id="stats" icon={Timer} title="Статистика LiteLLM за 24 ч" hint="запросы, ≤4.5 с, p50/p95" open={open.has("stats")} onToggle={toggle}>
        <StatsCard />
      </Section>
      <Section id="models" icon={FlaskConical} title="Модели LiteLLM" hint="список + тест latency" open={open.has("models")} onToggle={toggle}>
        <ModelsTestCard />
      </Section>
      <Section id="voice" icon={Mic} title="Голосовая цепочка" hint="STT / TTS / полный круг" open={open.has("voice")} onToggle={toggle}>
        <VoiceTests />
      </Section>
      <Section id="logs" icon={ScrollText} title="Живые логи" hint="belch-voice / мост / adb / панель" open={open.has("logs")} onToggle={toggle}>
        <LogsViewer />
      </Section>
      <Section id="events" icon={Activity} title="Лента событий" hint="что панель делала последним" open={open.has("events")} onToggle={toggle}>
        <EventsFeed />
      </Section>
    </section>
  );
}
