"use client";

// Тест моделей LiteLLM (бюджет навыка Диалогов ~4.5 с / ~1024 символа).
// Переехал со старой страницы «Модели» — вкладка «Диагностика» на странице агента.
import { useCallback, useEffect, useState } from "react";
import { FlaskConical, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

interface ModelRow {
  id: string;
  owned_by?: string;
}

interface TestResult {
  ok: boolean;
  ms: number;
  content: string;
  chars: number;
  promptTokens?: number;
  completionTokens?: number;
  overDialogsTimeLimit: boolean;
  error?: string;
}

export function ModelsTestCard() {
  const [models, setModels] = useState<ModelRow[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [prompt, setPrompt] = useState("Ответь одним словом: работает?");
  const [running, setRunning] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, TestResult>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/models", { cache: "no-store" });
      const j = await r.json();
      if (j.ok) {
        setModels(j.models);
        setListError(null);
      } else {
        setModels([]);
        setListError(j.error ?? "ошибка запроса");
      }
    } catch (e) {
      setListError(e instanceof Error ? e.message : "ошибка сети");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const runTest = async (model: string) => {
    setRunning(model);
    try {
      const r = await fetch("/api/models/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt }),
      });
      const j = (await r.json()) as TestResult;
      setResults((prev) => ({ ...prev, [model]: j }));
    } catch (e) {
      setResults((prev) => ({
        ...prev,
        [model]: {
          ok: false,
          ms: 0,
          content: "",
          chars: 0,
          overDialogsTimeLimit: false,
          error: e instanceof Error ? e.message : "ошибка сети",
        },
      }));
    } finally {
      setRunning(null);
    }
  };

  return (
    <Card>
      <CardHeader className="px-4 py-3">
        <CardTitle className="flex items-center justify-between text-xs font-medium tracking-wide text-zinc-400 uppercase">
          <span>Модели LiteLLM</span>
          <Button variant="outline" size="sm" className="h-7 gap-1.5 px-2 text-xs" onClick={load} disabled={loading}>
            <RefreshCw className={cn("size-3", loading && "animate-spin")} /> обновить
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-3">
        <div className="mb-3 flex items-center gap-2">
          <span className="shrink-0 font-mono text-[11px] text-zinc-500">промпт:</span>
          <Input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            className="h-8 font-mono text-xs"
            placeholder="промпт для теста"
          />
        </div>
        {listError && (
          <div className="mb-2 rounded border border-red-900 bg-red-950/40 px-2 py-1.5 font-mono text-xs text-red-400">
            {listError}
          </div>
        )}
        {/* Десктоп: таблица */}
        <div className="hidden max-h-72 overflow-y-auto rounded border border-zinc-800 md:block">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-8 font-mono text-[11px] text-zinc-500">модель</TableHead>
                <TableHead className="h-8 font-mono text-[11px] text-zinc-500">владелец</TableHead>
                <TableHead className="h-8 w-56 font-mono text-[11px] text-zinc-500">тест</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {models.length === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={3} className="py-6 text-center font-mono text-xs text-zinc-600">
                    список пуст
                  </TableCell>
                </TableRow>
              )}
              {models.map((m) => {
                const res = results[m.id];
                return (
                  <TableRow key={m.id}>
                    <TableCell className="py-1.5 font-mono text-xs">{m.id}</TableCell>
                    <TableCell className="py-1.5 font-mono text-[11px] text-zinc-500">{m.owned_by ?? "—"}</TableCell>
                    <TableCell className="py-1.5">
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 gap-1 px-2 font-mono text-[11px]"
                          disabled={running !== null}
                          onClick={() => runTest(m.id)}
                        >
                          <FlaskConical className="size-3" />
                          {running === m.id ? "тест…" : "тест"}
                        </Button>
                        {res && (
                          <span className="flex items-center gap-1.5 font-mono text-[11px]">
                            <span className={res.ok ? "text-emerald-400" : "text-red-400"}>
                              {res.ok ? `${res.ms} мс` : "ошибка"}
                            </span>
                            {res.ok && (
                              <Badge
                                variant="outline"
                                className={cn(
                                  "h-4 px-1 font-mono text-[10px] font-normal",
                                  res.overDialogsTimeLimit ? "border-red-900 text-red-400" : "border-emerald-900 text-emerald-400",
                                )}
                              >
                                {res.overDialogsTimeLimit ? ">4.5с" : "≤4.5с"}
                              </Badge>
                            )}
                          </span>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        {/* Мобайл: карточки, тап-таргеты ≥44px */}
        <div className="flex flex-col gap-2 md:hidden">
          {models.length === 0 && !loading && (
            <div className="py-6 text-center font-mono text-xs text-zinc-600">список пуст</div>
          )}
          {models.map((m) => {
            const res = results[m.id];
            return (
              <div key={m.id} className="rounded border border-zinc-800 p-3">
                <div className="break-all font-mono text-xs text-zinc-200">{m.id}</div>
                <div className="mt-0.5 font-mono text-[11px] text-zinc-500">{m.owned_by ?? "—"}</div>
                <div className="mt-2 flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-11 sm:h-9 gap-1 px-3 font-mono text-[11px]"
                    disabled={running !== null}
                    onClick={() => runTest(m.id)}
                  >
                    <FlaskConical className="size-3" />
                    {running === m.id ? "тест…" : "тест"}
                  </Button>
                  {res && (
                    <span className="flex items-center gap-1.5 font-mono text-[11px]">
                      <span className={res.ok ? "text-emerald-400" : "text-red-400"}>
                        {res.ok ? `${res.ms} мс` : "ошибка"}
                      </span>
                      {res.ok && (
                        <Badge
                          variant="outline"
                          className={cn(
                            "h-4 px-1 font-mono text-[10px] font-normal",
                            res.overDialogsTimeLimit ? "border-red-900 text-red-400" : "border-emerald-900 text-emerald-400",
                          )}
                        >
                          {res.overDialogsTimeLimit ? ">4.5с" : "≤4.5с"}
                        </Badge>
                      )}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-2 font-mono text-[10px] text-zinc-600">
          бейдж — уложился ли ответ в бюджет навыка Яндекс Диалогов (~4.5 с)
        </div>
      </CardContent>
    </Card>
  );
}
