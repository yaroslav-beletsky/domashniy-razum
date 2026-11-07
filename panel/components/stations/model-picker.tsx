"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { groupModels, loadRecent, parseModel, type ModelRow } from "@/lib/modelNames";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

interface Props {
  models: string[];
  value?: string;
  onSelect: (id: string) => void;
  disabled?: boolean;
  loading?: boolean;
}

function ProviderBadge({ id, className }: { id: string; className?: string }) {
  const p = parseModel(id);
  return (
    <Badge variant="outline" className={cn("h-5 shrink-0 px-1.5 font-mono text-[10px] font-normal text-zinc-400", className)}>
      {p.vendor ?? p.provider}
    </Badge>
  );
}

function Pill({ children, active, onPick }: { children: React.ReactNode; active?: boolean; onPick: () => void }) {
  return (
    <span
      role="button"
      tabIndex={-1}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onPick();
      }}
      className={cn(
        "inline-flex h-6 shrink-0 cursor-pointer items-center rounded-full border px-2 font-mono text-[10px] transition-colors",
        active
          ? "border-emerald-700 bg-emerald-950/50 text-emerald-300"
          : "border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200",
      )}
    >
      {children}
    </span>
  );
}

function Body({
  models,
  value,
  onPick,
  mobile,
}: {
  models: string[];
  value?: string;
  onPick: (id: string) => void;
  mobile: boolean;
}) {
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => setRecent(loadRecent()), []);

  const groups = useMemo(() => groupModels(models), [models]);
  const known = useMemo(() => new Set(models), [models]);
  const outside = value && !known.has(value) ? value : null;
  const recentIds = recent.filter((r) => r !== value && known.has(r)).slice(0, 4);

  const rowMeta = (row: ModelRow) => [row.primary.provider, row.primary.vendor ?? "", ...row.all.map((m) => m.id)];

  return (
    <Command className="bg-transparent p-0" loop>
      <CommandInput placeholder="Поиск: имя, id, провайдер…" autoFocus={!mobile} />
      <CommandList className={cn("mt-1", mobile ? "max-h-[55svh]" : "max-h-80")}>
        <CommandEmpty>Ничего не найдено</CommandEmpty>

        {outside && (
          <CommandGroup heading="Вне списка LiteLLM">
            <CommandItem value={`outside:${outside}`} keywords={[outside]} onSelect={() => onPick(outside)} className="min-h-11 sm:min-h-8">
              <Badge variant="outline" className="h-5 shrink-0 border-amber-800 px-1.5 text-[10px] font-normal text-amber-400">
                нет в LiteLLM
              </Badge>
              <span className="min-w-0 flex-1 truncate" title={outside}>
                {outside}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-emerald-400">сейчас</span>
            </CommandItem>
          </CommandGroup>
        )}

        {(value && known.has(value)) || recentIds.length > 0 ? (
          <CommandGroup heading="Сейчас и недавние">
            {value && known.has(value) && (
              <CommandItem value={`now:${value}`} keywords={[value, parseModel(value).provider]} onSelect={() => onPick(value)} className="min-h-11 sm:min-h-8">
                <ProviderBadge id={value} />
                <span className="min-w-0 flex-1 truncate" title={value}>
                  {parseModel(value).short}
                </span>
                <span className="flex shrink-0 items-center gap-1 font-mono text-[10px] text-emerald-400">
                  <Check className="size-3" /> сейчас
                </span>
              </CommandItem>
            )}
            {recentIds.map((id) => (
              <CommandItem key={id} value={`recent:${id}`} keywords={[id, parseModel(id).provider]} onSelect={() => onPick(id)} className="min-h-11 sm:min-h-8">
                <ProviderBadge id={id} />
                <span className="min-w-0 flex-1 truncate" title={id}>
                  {parseModel(id).short}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}

        {groups.map((g) => (
          <CommandGroup key={g.key} heading={g.label}>
            {g.rows.map((row) => {
              const active = value ? row.all.some((m) => m.id === value) : false;
              return (
                <CommandItem
                  key={row.key}
                  value={row.key}
                  keywords={rowMeta(row)}
                  onSelect={() => onPick(row.primary.id)}
                  className="min-h-11 flex-wrap gap-y-1 sm:min-h-8"
                >
                  <span className="min-w-0 flex-1 truncate" title={row.all.map((m) => m.id).join("\n")}>
                    {row.name}
                  </span>
                  {row.variants.length > 0 && (
                    <span className="flex shrink-0 items-center gap-1">
                      {row.variants.map((v) => (
                        <Pill key={v.id} active={v.id === value} onPick={() => onPick(v.id)}>
                          {v.variant}
                        </Pill>
                      ))}
                    </span>
                  )}
                  {active && <Check className="size-3.5 shrink-0 text-emerald-400" />}
                </CommandItem>
              );
            })}
          </CommandGroup>
        ))}
      </CommandList>
    </Command>
  );
}

export function ModelPicker({ models, value, onSelect, disabled, loading }: Props) {
  const [open, setOpen] = useState(false);
  const mobile = useMediaQuery("(max-width: 767px)");
  const p = value ? parseModel(value) : null;

  const pick = (id: string) => {
    setOpen(false);
    if (id !== value) onSelect(id);
  };

  const trigger = (
    <Button
      type="button"
      variant="outline"
      disabled={disabled}
      aria-label="Активная модель"
      className="h-11 w-full justify-between gap-2 bg-zinc-950/60 px-3 font-normal sm:h-10 sm:max-w-md"
    >
      <span className="flex min-w-0 items-center gap-2">
        {p ? (
          <>
            <ProviderBadge id={value!} />
            <span className="min-w-0 truncate text-sm" title={value}>
              {p.name}
            </span>
            {p.variant && (
              <Badge variant="outline" className="h-5 shrink-0 px-1.5 font-mono text-[10px] font-normal text-zinc-300">
                {p.variant}
              </Badge>
            )}
          </>
        ) : (
          <span className="text-sm text-zinc-500">{loading ? "загрузка…" : "модель не выбрана"}</span>
        )}
      </span>
      <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
    </Button>
  );

  if (mobile) {
    return (
      <Drawer open={open} onOpenChange={setOpen} shouldScaleBackground={false}>
        <DrawerTrigger asChild>{trigger}</DrawerTrigger>
        <DrawerContent>
          <DrawerHeader className="pb-2 text-left">
            <DrawerTitle>Активная модель</DrawerTitle>
            <DrawerDescription className="sr-only">Выберите модель LiteLLM для колонки</DrawerDescription>
          </DrawerHeader>
          <div className="px-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
            {open && <Body models={models} value={value} onPick={pick} mobile />}
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="start" className="w-[min(28rem,calc(100vw-2rem))] p-1.5">
        {open && <Body models={models} value={value} onPick={pick} mobile={false} />}
      </PopoverContent>
    </Popover>
  );
}
