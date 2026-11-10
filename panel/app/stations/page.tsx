"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import type { StationView } from "@/lib/stationView";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StationCard } from "@/components/stations/station-card";
import { StationOutline } from "@/components/stations/station-svg";

export default function StationsPage() {
  const [stations, setStations] = useState<StationView[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

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
        <h1 className="text-lg font-medium text-zinc-100">Колонки</h1>
        {stations && stations.length > 0 && (
          <span className="font-mono text-xs text-zinc-500">
            {online} в сети · {offline} оффлайн
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button className="h-11 gap-1.5 px-3 sm:h-9" asChild>
            <Link href="/add-station?new=1">
              <Plus className="size-4" /> Добавить колонку
            </Link>
          </Button>
          <Button variant="outline" className="h-11 gap-1.5 px-3 sm:h-9" onClick={load} disabled={loading}>
            <RefreshCw className={cn("size-4", loading && "animate-spin")} /> Обновить
          </Button>
        </div>
      </div>
      <p className="-mt-2 text-xs text-zinc-500">
        Все колонки отвечают одним агентом —{" "}
        <Link href="/agent" className="text-zinc-300 underline underline-offset-2">
          Агент
        </Link>
        . Новую колонку добавляет «+» (мастер настройки), подключение существующей — кнопка «Подключить» на странице
        колонки.
      </p>

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
          <div className="flex flex-col gap-1">
            <p className="text-sm text-zinc-400">Ни одна Станция ещё не подключена</p>
            <p className="text-xs text-zinc-500">Мастер проведёт по шагам: ADB, мост, голос.</p>
          </div>
          <Button className="h-11 gap-1.5 sm:h-9" asChild>
            <Link href="/add-station?new=1">
              <Plus className="size-4" /> Добавить колонку
            </Link>
          </Button>
        </div>
      )}
    </div>
  );
}
