"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Bot, Loader2, Plus, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/lib/sseClient";
import { TEMPLATES, type AgentView } from "@/lib/agentTypes";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { AgentCard } from "@/components/agents/agent-card";

interface Listing {
  agents: AgentView[];
  mcp: { total: number; enabled: number; errors: number; reachable: boolean };
  bound: number;
}

function CreateDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [tpl, setTpl] = useState<(typeof TEMPLATES)[number]["id"]>("home");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const t = TEMPLATES.find((x) => x.id === tpl)!;
    setBusy(true);
    setErr(null);
    try {
      const j = await api<{ agent: { slug: string } }>("/api/agents", {
        method: "POST",
        body: { name, system_prompt: t.prompt, avatar: t.avatar, tools_enabled: tpl === "blank" ? [] : ["builtin__datetime"] },
      });
      onOpenChange(false);
      setName("");
      router.push(`/agents/${j.agent.slug}`);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "не удалось создать");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Новый агент</DialogTitle>
          <DialogDescription>Создастся черновик — его можно сразу проверять в тест-панели. На колонки он попадёт после «Применить».</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="ag-name">Имя</Label>
            <Input id="ag-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Домовой" maxLength={32} autoComplete="off" required className="h-11 sm:h-9" />
          </div>
          <div className="grid gap-1.5">
            <Label>Шаблон</Label>
            <div role="radiogroup" aria-label="Шаблон" className="grid gap-1.5">
              {TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={tpl === t.id}
                  onClick={() => setTpl(t.id)}
                  className={cn(
                    "flex min-h-11 items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors",
                    tpl === t.id ? "border-zinc-500 bg-zinc-800 text-zinc-50" : "border-zinc-800 text-zinc-400 hover:border-zinc-600",
                  )}
                >
                  <span aria-hidden className="text-lg">{t.avatar}</span>
                  <span className="flex flex-col">
                    <span className="text-sm">{t.label}</span>
                    <span className="text-xs text-zinc-500">{t.hint}</span>
                  </span>
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
            <Button type="submit" disabled={busy || !name.trim()} className="h-11 sm:h-9">
              {busy && <Loader2 className="size-4 animate-spin" />} Создать
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function AgentsPage() {
  const [data, setData] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api<Listing>("/api/agents"));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "не удалось загрузить");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [load]);

  const n = data?.agents.length ?? 0;
  const plural = (k: number, one: string, few: string, many: string) => (k % 10 === 1 && k % 100 !== 11 ? one : k % 10 >= 2 && k % 10 <= 4 && (k % 100 < 10 || k % 100 >= 20) ? few : many);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-lg font-medium text-zinc-100">Агенты</h1>
        {data && n > 0 && (
          <span className="font-mono text-xs text-zinc-500">
            {n} {plural(n, "агент", "агента", "агентов")} · {data.bound} {plural(data.bound, "колонка", "колонки", "колонок")} привязано · {data.mcp.enabled} MCP активно
            {data.mcp.errors > 0 && <span className="text-amber-400"> · {data.mcp.errors} err</span>}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button className="h-11 gap-1.5 px-3 sm:h-9" onClick={() => setCreateOpen(true)} disabled={!data}>
            <Plus className="size-4" /> <span className="hidden sm:inline">Создать агента</span>
            <span className="sm:hidden">Создать</span>
          </Button>
          <Button variant="outline" className="h-11 gap-1.5 px-3 sm:h-9" onClick={load} disabled={loading}>
            <RefreshCw className={cn("size-4", loading && "animate-spin")} /> <span className="hidden sm:inline">Обновить</span>
          </Button>
        </div>
      </div>

      {error && !data && (
        <p role="alert" className="rounded-lg border border-amber-900/50 bg-amber-950/20 p-4 text-sm text-amber-300">
          Не удалось получить агентов: {error}
        </p>
      )}

      {data && !data.mcp.reachable && (
        <p role="status" className="rounded-lg border border-amber-900/50 bg-amber-950/20 px-3.5 py-2.5 text-xs text-amber-300">
          Список MCP-серверов не получен — сводка по инструментам может быть неточной.
        </p>
      )}

      {!data && !error && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-36 rounded-xl" />
          ))}
        </div>
      )}

      {data && n === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-zinc-700 px-4 py-12 text-center">
          <Bot className="size-8 text-zinc-600" />
          <p className="max-w-sm text-sm text-zinc-400">Нет настроенных агентов. Колонки сейчас отвечают напрямую через базовую модель.</p>
          <Button className="h-11 sm:h-9" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" /> Создать первого агента
          </Button>
        </div>
      )}

      {data && n > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {data.agents.map((a) => (
            <AgentCard key={a.id} a={a} />
          ))}
        </div>
      )}

      <CreateDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
