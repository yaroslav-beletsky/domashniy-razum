"use client";

import { CheckCircle2, Circle, Loader2, MinusCircle, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { StepStatus, WizardStepDef } from "@/lib/wizard";

export function StepIcon({ status, active }: { status: StepStatus | "pending"; active: boolean }) {
  const cls = cn("size-4 shrink-0", active && "animate-pulse");
  switch (status) {
    case "done":
      return <CheckCircle2 className={cn(cls, "text-emerald-400")} />;
    case "error":
      return <XCircle className={cn(cls, "text-amber-400")} />;
    case "skipped":
      return <MinusCircle className={cn(cls, "text-zinc-600")} />;
    case "running":
      return <Loader2 className={cn(cls, "animate-spin text-sky-400")} />;
    default:
      return <Circle className={cn(cls, active ? "text-zinc-300" : "text-zinc-700")} />;
  }
}

/** Вертикальный степпер: весь путь ветки A, текущий шаг подсвечен. */
export function WizardStepper({
  steps,
  statuses,
  current,
}: {
  steps: WizardStepDef[];
  statuses: Record<string, { status: StepStatus } | undefined>;
  current: string;
}) {
  const currentIdx = steps.findIndex((s) => s.id === current);
  return (
    <ol className="flex flex-col gap-0.5">
      {steps.map((s, i) => {
        const st = statuses[s.id]?.status ?? "pending";
        const active = i === currentIdx;
        const past = i < currentIdx && (st === "done" || st === "skipped");
        return (
          <li key={s.id} className="flex items-start gap-2 py-1">
            <span className="mt-0.5">
              <StepIcon status={st} active={active} />
            </span>
            <div className="min-w-0">
              <div
                className={cn(
                  "text-[13px] leading-tight",
                  active ? "font-medium text-zinc-100" : past || st === "done" ? "text-zinc-300" : "text-zinc-500",
                )}
              >
                {s.n}. {s.title}
              </div>
              {active && <div className="mt-0.5 font-mono text-[10px] text-zinc-500">≈ {s.estMin} мин</div>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
