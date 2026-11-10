"use client";

// Вход в мастер «Добавить колонку»: компактный диалог, по одному шагу за раз.
// Подготовка (сброс → Wi-Fi) — инструкция + ОДНА кнопка «Готово — уже сделал»;
// второстепенное (критерий, откат, пропуск) — в disclosure. Затем шаг «Поиск»
// со сканером; создание черновика помечает подготовку по ответам владельца.
import { useEffect, useState } from "react";
import { ArrowLeft, CheckCircle2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { WizardStepDef } from "@/lib/wizard";
import { Discovery, type PrepMarks, type WizardMetaLite } from "./discovery";

type Phase = "reset" | "wifi" | "find";

function PrepStep({
  def,
  n,
  primary,
  onDone,
  onSkip,
}: {
  def: WizardStepDef;
  n: 1 | 2;
  primary: string;
  onDone: () => void;
  onSkip: () => void;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Добавить колонку</DialogTitle>
        <DialogDescription className="font-mono text-[11px] uppercase tracking-wide text-zinc-500">
          Подготовка · шаг {n} из 3
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-2">
        <h3 className="text-base font-medium leading-snug text-zinc-100">
          {n}. {def.title}
        </h3>
        <p className="text-[13px] leading-relaxed text-zinc-300">{def.hint}</p>
        <details className="rounded border border-zinc-800 bg-zinc-950/50 px-3 py-1.5">
          <summary className="cursor-pointer select-none text-[11px] text-zinc-500 transition-colors hover:text-zinc-300">
            Критерий готовности, откат, пропуск
          </summary>
          <div className="mt-1.5 flex flex-col gap-1.5 font-mono text-[11px] leading-snug text-zinc-500">
            {def.criteria && <div>критерий: {def.criteria}</div>}
            {def.rollback && <div>откат: {def.rollback}</div>}
            <div>≈ {def.estMin} мин</div>
            {def.skippable && (
              <Button variant="ghost" size="sm" className="mt-1 h-7 w-fit gap-1 px-2 text-[11px] text-zinc-500" onClick={onSkip}>
                Пропустить этот шаг <ArrowLeft className="size-3 rotate-180" />
              </Button>
            )}
          </div>
        </details>
      </div>
      <DialogFooter>
        <Button className="h-11 w-full gap-1.5 sm:h-10 sm:w-auto" onClick={onDone}>
          <CheckCircle2 className="size-4" /> {primary}
        </Button>
      </DialogFooter>
    </>
  );
}

export function AddStationSheet({
  open,
  onOpenChange,
  steps,
  meta,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  steps: WizardStepDef[];
  meta: WizardMetaLite;
  onCreated: (key: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>("reset");
  const [prep, setPrep] = useState<PrepMarks>({});

  useEffect(() => {
    if (open) {
      setPhase("reset");
      setPrep({});
    }
  }, [open]);

  const resetDef = steps.find((s) => s.id === "reset");
  const wifiDef = steps.find((s) => s.id === "bindwifi");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={
          phase === "find"
            ? "max-h-[88vh] gap-3 overflow-y-auto sm:max-w-lg"
            : "sm:max-w-md"
        }
      >
        {phase === "reset" && resetDef && (
          <PrepStep
            def={resetDef}
            n={1}
            primary="Готово — уже сделал"
            onDone={() => {
              setPrep((p) => ({ ...p, reset: "done" }));
              setPhase("wifi");
            }}
            onSkip={() => {
              setPrep((p) => ({ ...p, reset: "skipped" }));
              setPhase("wifi");
            }}
          />
        )}
        {phase === "wifi" && wifiDef && (
          <PrepStep
            def={wifiDef}
            n={2}
            primary="Готово — колонка в сети"
            onDone={() => {
              setPrep((p) => ({ ...p, wifi: "done" }));
              setPhase("find");
            }}
            onSkip={() => {
              setPrep((p) => ({ ...p, wifi: "skipped" }));
              setPhase("find");
            }}
          />
        )}
        {phase === "find" && (
          <>
            <DialogHeader>
              <DialogTitle>Добавить колонку</DialogTitle>
              <DialogDescription className="font-mono text-[11px] uppercase tracking-wide text-zinc-500">
                Шаг 3 из 3 · найдём колонку в сети
              </DialogDescription>
            </DialogHeader>
            <Discovery
              meta={meta}
              prep={prep}
              onCreated={(k) => {
                onOpenChange(false);
                onCreated(k);
              }}
            />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
