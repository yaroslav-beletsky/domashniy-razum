"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, RefreshCw, Wand2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { StationView } from "@/lib/stationView";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { StationCard } from "@/components/stations/station-card";
import { StationOutline } from "@/components/stations/station-svg";

const KINDS = [
  { v: "unknown", l: "Не знаю" },
  { v: "max", l: "Max" },
  { v: "mini", l: "Mini" },
  { v: "lite", l: "Lite" },
];

function AddDialog({ open, onOpenChange, onAdded }: { open: boolean; onOpenChange: (v: boolean) => void; onAdded: () => void }) {
  const [host, setHost] = useState("");
  const [port, setPort] = useState("5555");
  const [name, setName] = useState("");
  const [kind, setKind] = useState("unknown");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/stations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host, port: Number(port) || 5555, name, kind }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        setErr(j.error ?? `ошибка ${r.status}`);
        return;
      }
      setHost("");
      setName("");
      setKind("unknown");
      onOpenChange(false);
      onAdded();
    } catch {
      setErr("панель недоступна");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Добавить колонку</DialogTitle>
          <DialogDescription>
            Адрес колонки в локальной сети. На ней должен быть включён adb по LAN (tcpip) и стоять мост.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-3">
          <div className="grid grid-cols-[1fr_5.5rem] gap-2">
            <div className="grid gap-1.5">
              <Label htmlFor="st-host">IP-адрес</Label>
              <Input
                id="st-host"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="192.168.88.80"
                inputMode="decimal"
                autoComplete="off"
                required
                className="h-11 font-mono sm:h-9"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="st-port">Порт</Label>
              <Input
                id="st-port"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                inputMode="numeric"
                className="h-11 font-mono sm:h-9"
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="st-name">Комната</Label>
            <Input
              id="st-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Гостиная"
              maxLength={40}
              className="h-11 sm:h-9"
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Тип</Label>
            <div role="radiogroup" aria-label="Тип колонки" className="grid grid-cols-4 gap-1.5">
              {KINDS.map((k) => (
                <button
                  key={k.v}
                  type="button"
                  role="radio"
                  aria-checked={kind === k.v}
                  onClick={() => setKind(k.v)}
                  className={cn(
                    "h-11 rounded-md border text-xs transition-colors sm:h-9",
                    kind === k.v ? "border-zinc-500 bg-zinc-800 text-zinc-50" : "border-zinc-800 text-zinc-400 hover:border-zinc-600",
                  )}
                >
                  {k.l}
                </button>
              ))}
            </div>
          </div>
          {err && (
            <p role="alert" className="text-xs text-amber-400">
              {err}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" className="h-11 sm:h-9" onClick={() => onOpenChange(false)}>
              Отмена
            </Button>
            <Button type="submit" disabled={busy || !host.trim()} className="h-11 sm:h-9">
              {busy && <Loader2 className="size-4 animate-spin" />} Добавить
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function StationsPage() {
  const [stations, setStations] = useState<StationView[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/stations", { cache: "no-store" });
      const j = await r.json();
      if (j.ok) {
        setStations(j.stations);
        setFailed(false);
      } else setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  const online = stations?.filter((s) => s.reachable).length ?? 0;
  const offline = (stations?.length ?? 0) - online;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-lg font-medium text-zinc-100">Станции</h1>
        {stations && stations.length > 0 && (
          <span className="font-mono text-xs text-zinc-500">
            {online} в сети · {offline} оффлайн
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" className="h-11 gap-1.5 px-3 text-zinc-300 sm:h-9" asChild>
            <Link href="/add-station">
              <Wand2 className="size-4" /> <span className="hidden sm:inline">Мастер настройки</span>
            </Link>
          </Button>
          {stations && stations.length > 0 && (
            <Button variant="ghost" className="h-11 gap-1.5 px-3 text-zinc-300 sm:h-9" onClick={() => setAddOpen(true)}>
              <Plus className="size-4" /> <span className="hidden sm:inline">Добавить колонку</span>
            </Button>
          )}
          <Button variant="outline" className="h-11 gap-1.5 px-3 sm:h-9" onClick={load} disabled={loading}>
            <RefreshCw className={cn("size-4", loading && "animate-spin")} /> Обновить
          </Button>
        </div>
      </div>

      {failed && !stations && (
        <p role="alert" className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4 text-sm text-zinc-400">
          Не удалось получить список колонок. Попробуйте «Обновить».
        </p>
      )}

      {stations === null && !failed && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[7.5rem] rounded-xl" />
          ))}
        </div>
      )}

      {stations && stations.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {stations.map((s) => (
            <StationCard key={s.id} s={s} />
          ))}
        </div>
      )}

      {stations && stations.length === 0 && (
        <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed border-zinc-700 px-6 py-14 text-center">
          <StationOutline className="h-[72px] w-14 text-zinc-600" />
          <p className="text-sm text-zinc-400">Ни одна Станция ещё не подключена</p>
          <Button className="h-11 gap-1.5 sm:h-9" onClick={() => setAddOpen(true)}>
            <Plus className="size-4" /> Добавить колонку
          </Button>
        </div>
      )}

      <AddDialog open={addOpen} onOpenChange={setAddOpen} onAdded={load} />
    </div>
  );
}
