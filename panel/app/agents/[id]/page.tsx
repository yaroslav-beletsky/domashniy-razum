"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronLeft, Loader2, MoreHorizontal, Save, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { api, postSse } from "@/lib/sseClient";
import { modelIds } from "@/lib/modelNames";
import {
  ANSWER_LIMITS,
  AVATARS,
  BUILTIN_TOOLS,
  PROMPT_VARS,
  limitFromTokens,
  type Agent,
  type AgentMeta,
  type McpServer,
  type McpTool,
} from "@/lib/agentTypes";
import type { StationView } from "@/lib/stationView";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ModelPicker } from "@/components/stations/model-picker";
import { AgentAvatar } from "@/components/agents/agent-card";
import { McpSection } from "@/components/agents/mcp-section";
import { TestPanel } from "@/components/agents/test-panel";

type AgentFull = Agent & { meta: AgentMeta; title: string };

interface Draft {
  name: string;
  avatar: string;
  description: string;
  system_prompt: string;
  model: string;
  fallback_model: string;
  tools_enabled: string[];
  max_tokens: number;
}

const toDraft = (a: AgentFull): Draft => ({
  name: a.meta.name ?? "",
  avatar: a.meta.avatar ?? "",
  description: a.meta.description ?? "",
  system_prompt: a.system_prompt,
  model: a.model,
  fallback_model: a.fallback_model ?? "",
  tools_enabled: [...a.tools_enabled],
  max_tokens: a.max_tokens,
});

const sameDraft = (a: Draft, b: Draft) =>
  a.name === b.name &&
  a.avatar === b.avatar &&
  a.description === b.description &&
  a.system_prompt === b.system_prompt &&
  a.model === b.model &&
  a.fallback_model === b.fallback_model &&
  a.max_tokens === b.max_tokens &&
  a.tools_enabled.length === b.tools_enabled.length &&
  [...a.tools_enabled].sort().join("\n") === [...b.tools_enabled].sort().join("\n");

function Card({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-3 rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h2 className="text-sm font-medium text-zinc-200">{title}</h2>
        {hint && <span className="text-xs text-zinc-500">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

type StationRun = { id: string; name: string; state: "wait" | "run" | "ok" | "err"; text: string };

export default function AgentPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [agent, setAgent] = useState<AgentFull | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string; conflict?: boolean } | null>(null);

  const [models, setModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [tools, setTools] = useState<Record<number, McpTool[]>>({});

  const [stations, setStations] = useState<StationView[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [pickedInit, setPickedInit] = useState(false);
  const [runs, setRuns] = useState<StationRun[]>([]);
  const [applying, setApplying] = useState(false);

  const [tab, setTab] = useState<"settings" | "test">("settings");
  const [delOpen, setDelOpen] = useState(false);
  const [delBusy, setDelBusy] = useState(false);
  const [delErr, setDelErr] = useState<string | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const loadAgent = useCallback(async () => {
    try {
      const j = await api<{ agent: AgentFull }>(`/api/agents/${encodeURIComponent(id)}`);
      setAgent(j.agent);
      setDraft(toDraft(j.agent));
      setLoadErr(null);
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : "не удалось загрузить");
    }
  }, [id]);

  const loadServers = useCallback(async () => {
    try {
      const j = await api<{ servers: McpServer[] }>("/api/mcp");
      setServers(j.servers);
      const entries = await Promise.all(
        j.servers.map(async (s) => {
          try {
            const t = await api<{ tools: McpTool[] }>(`/api/mcp/${s.id}/tools`);
            return [s.id, t.tools] as const;
          } catch {
            return [s.id, [] as McpTool[]] as const;
          }
        }),
      );
      setTools(Object.fromEntries(entries));
    } catch {
      setServers([]);
    }
  }, []);

  const loadStations = useCallback(async () => {
    try {
      const j = await api<{ stations: StationView[] }>("/api/stations");
      setStations(j.stations);
    } catch {
      setStations([]);
    }
  }, []);

  useEffect(() => {
    loadAgent();
    loadServers();
    loadStations();
    fetch("/api/models", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setModels(modelIds(j.models ?? [])))
      .catch(() => setModels([]))
      .finally(() => setModelsLoading(false));
  }, [loadAgent, loadServers, loadStations]);

  // стартовый выбор колонок = те, что уже отвечают через этого агента
  useEffect(() => {
    if (!agent || !stations || pickedInit) return;
    setPicked(new Set(stations.filter((s) => s.agent?.slug === agent.slug).map((s) => s.id)));
    setPickedInit(true);
  }, [agent, stations, pickedInit]);

  const dirty = useMemo(() => Boolean(agent && draft && !sameDraft(draft, toDraft(agent))), [agent, draft]);

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));

  // ---- инструменты ----
  const allNames = useMemo(() => [...BUILTIN_TOOLS.map((t) => t.name), ...Object.values(tools).flat().map((t) => t.name)], [tools]);
  const isOn = (name: string) => Boolean(draft && (draft.tools_enabled.includes("*") || draft.tools_enabled.includes(name)));
  const toggleTools = (names: string[], on: boolean) =>
    setDraft((d) => {
      if (!d) return d;
      const base = new Set(d.tools_enabled.includes("*") ? allNames : d.tools_enabled);
      for (const n of names) {
        if (on) base.add(n);
        else base.delete(n);
      }
      return { ...d, tools_enabled: [...base] };
    });
  const enabledCount = draft ? (draft.tools_enabled.includes("*") ? allNames.length : draft.tools_enabled.length) : 0;

  // ---- сохранение ----
  const save = async () => {
    if (!agent || !draft || saving) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const j = await api<{ agent: AgentFull }>(`/api/agents/${agent.slug}`, {
        method: "PATCH",
        body: {
          version: agent.version,
          meta: { name: draft.name, avatar: draft.avatar, description: draft.description },
          system_prompt: draft.system_prompt,
          model: draft.model,
          fallback_model: draft.fallback_model || null,
          tools_enabled: draft.tools_enabled,
          max_tokens: draft.max_tokens,
        },
      });
      setAgent(j.agent);
      setDraft(toDraft(j.agent));
      setSaveMsg({ ok: true, text: "Сохранено. На колонки — кнопкой «Применить»" });
    } catch (e) {
      const err = e as Error & { conflict?: boolean };
      setSaveMsg({
        ok: false,
        conflict: err.conflict,
        text: err.conflict ? "Агент изменён в другом месте. Перезагрузите, чтобы не затереть чужие правки" : err.message,
      });
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    if (!saveMsg?.ok) return;
    const t = setTimeout(() => setSaveMsg(null), 4000);
    return () => clearTimeout(t);
  }, [saveMsg]);

  // ---- применение на колонки ----
  const apply = async () => {
    if (!agent || !stations || applying) return;
    if (dirty) {
      setSaveMsg({ ok: false, text: "Сначала сохраните правки — на колонки уходит сохранённая версия" });
      return;
    }
    const todo = stations
      .map((s) => {
        const isMine = s.agent?.slug === agent.slug;
        const want = picked.has(s.id);
        return want && !isMine ? { s, op: "connect" as const } : !want && isMine ? { s, op: "disconnect" as const } : null;
      })
      .filter((x): x is { s: StationView; op: "connect" | "disconnect" } => x !== null);
    if (todo.length === 0) return;

    setApplying(true);
    setRuns(todo.map(({ s, op }) => ({ id: s.id, name: s.name, state: "wait", text: op === "connect" ? "в очереди: подключить" : "в очереди: отключить" })));
    const upd = (sid: string, p: Partial<StationRun>) => setRuns((rs) => rs.map((r) => (r.id === sid ? { ...r, ...p } : r)));
    for (const { s, op } of todo) {
      upd(s.id, { state: "run", text: "запуск…" });
      let failed: string | null = null;
      let done = false;
      const res = await postSse(
        `/api/stations/${s.id}/${op === "connect" ? "connect-agents" : "disconnect-agents"}`,
        op === "connect" ? { agent: agent.slug } : {},
        ({ data }) => {
          if (data.type === "step") upd(s.id, { text: `${data.index}/${data.total} ${data.label}` });
          else if (data.type === "done") done = true;
          else if (data.type === "error") failed = String(data.error);
        },
      ).catch((e) => ({ ok: false, status: 0, error: e instanceof Error ? e.message : "соединение прервано" }));
      if (!res.ok) failed = res.error ?? "ошибка";
      if (failed) upd(s.id, { state: "err", text: failed });
      else if (done) upd(s.id, { state: "ok", text: op === "connect" ? "подключена" : "отключена" });
      else upd(s.id, { state: "err", text: "поток закрылся без итога" });
    }
    setApplying(false);
    await Promise.all([loadStations(), loadAgent()]);
  };

  const remove = async () => {
    if (!agent) return;
    setDelBusy(true);
    setDelErr(null);
    try {
      await api(`/api/agents/${agent.slug}`, { method: "DELETE" });
      router.push("/agents");
    } catch (e) {
      setDelErr(e instanceof Error ? e.message : "не удалось удалить");
      setDelBusy(false);
    }
  };

  const insertVar = (v: string) => {
    const el = promptRef.current;
    if (!el || !draft) return;
    const a = el.selectionStart ?? draft.system_prompt.length;
    const b = el.selectionEnd ?? a;
    const next = draft.system_prompt.slice(0, a) + v + draft.system_prompt.slice(b);
    set("system_prompt", next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(a + v.length, a + v.length);
    });
  };

  if (loadErr && !agent) {
    return (
      <div className="mx-auto flex max-w-xl flex-col gap-3">
        <Link href="/agents" className="flex items-center gap-1 text-sm text-zinc-400 hover:text-zinc-200">
          <ChevronLeft className="size-4" /> Агенты
        </Link>
        <p role="alert" className="rounded-lg border border-amber-900/50 bg-amber-950/20 p-4 text-sm text-amber-300">
          {loadErr}
        </p>
      </div>
    );
  }
  if (!agent || !draft) {
    return (
      <div className="mx-auto grid max-w-6xl gap-3 xl:grid-cols-[1fr_24rem]">
        <Skeleton className="h-96 rounded-xl" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }

  const title = draft.name.trim() || agent.slug;
  const limit = limitFromTokens(draft.max_tokens);
  const hasVars = /\{\{\s*\w+\s*\}\}/.test(draft.system_prompt);
  const changes = (stations ?? []).filter((s) => picked.has(s.id) !== (s.agent?.slug === agent.slug)).length;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 pb-24 xl:pb-4">
      <div className="flex items-center gap-1 text-sm">
        <Link href="/agents" className="flex min-h-11 items-center gap-1 text-zinc-400 hover:text-zinc-200 sm:min-h-8">
          <ChevronLeft className="size-4" /> Агенты
        </Link>
        <span className="text-zinc-600">/</span>
        <span className="truncate text-zinc-200">{title}</span>
      </div>

      {/* action bar */}
      <div className="sticky top-0 z-20 -mx-1 flex flex-wrap items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-950/90 px-3 py-2 backdrop-blur">
        <AgentAvatar avatar={draft.avatar} title={title} className="size-9" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-medium text-zinc-100">{title}</h1>
          <p className="font-mono text-[11px] text-zinc-500">
            {agent.slug} · v{agent.version}
            {dirty && <span className="text-amber-400"> · не сохранено</span>}
          </p>
        </div>
        <Button onClick={save} disabled={!dirty || saving} className="h-11 gap-1.5 px-3 sm:h-9">
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Сохранить
        </Button>
        <Button variant="outline" onClick={apply} disabled={applying || changes === 0 || !stations} className="h-11 gap-1.5 px-3 sm:h-9">
          {applying && <Loader2 className="size-4 animate-spin" />} Применить на колонки{changes > 0 && ` (${changes})`}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Ещё" className="size-11 sm:size-9">
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem className="min-h-11 text-red-400 sm:min-h-8" onSelect={() => setDelOpen(true)}>
              <Trash2 className="size-4" /> Удалить агента…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {saveMsg && (
          <p role={saveMsg.ok ? "status" : "alert"} className={cn("flex w-full flex-wrap items-center gap-2 text-xs", saveMsg.ok ? "text-emerald-400" : "text-amber-400")}>
            {saveMsg.ok ? <CheckCircle2 className="size-3.5" /> : <AlertTriangle className="size-3.5" />}
            {saveMsg.text}
            {saveMsg.conflict && (
              <Button variant="outline" size="xs" className="h-8" onClick={() => (setSaveMsg(null), loadAgent())}>
                Перезагрузить
              </Button>
            )}
          </p>
        )}
      </div>

      {/* вкладки для узких экранов */}
      <div role="tablist" className="grid grid-cols-2 gap-1.5 xl:hidden">
        {(["settings", "test"] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn(
              "h-11 rounded-md border text-sm transition-colors",
              tab === t ? "border-zinc-500 bg-zinc-800 text-zinc-50" : "border-zinc-800 text-zinc-400",
            )}
          >
            {t === "settings" ? "Настройки" : "Тест"}
          </button>
        ))}
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className={cn("grid min-w-0 gap-4", tab === "test" && "hidden xl:grid")}>
          <Card title="Персона">
            <div className="grid gap-3 sm:grid-cols-[1fr_1.6fr]">
              <div className="grid gap-1.5">
                <Label htmlFor="ag-name">Имя</Label>
                <Input id="ag-name" value={draft.name} onChange={(e) => set("name", e.target.value)} maxLength={32} placeholder={agent.slug} className="h-11 sm:h-9" autoComplete="off" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="ag-desc">Описание</Label>
                <Input id="ag-desc" value={draft.description} onChange={(e) => set("description", e.target.value)} maxLength={120} placeholder="Для кого и зачем" className="h-11 sm:h-9" autoComplete="off" />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label>Аватар</Label>
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Аватар">
                {AVATARS.map((a) => (
                  <button
                    key={a}
                    type="button"
                    role="radio"
                    aria-checked={draft.avatar === a}
                    aria-label={a}
                    onClick={() => set("avatar", draft.avatar === a ? "" : a)}
                    className={cn(
                      "flex size-11 items-center justify-center rounded-md border text-lg transition-colors sm:size-9",
                      draft.avatar === a ? "border-zinc-400 bg-zinc-800" : "border-zinc-800 hover:border-zinc-600",
                    )}
                  >
                    {a}
                  </button>
                ))}
              </div>
            </div>
          </Card>

          <Card title="Системный промпт" hint="Сервис сам добавляет «отвечай коротко, 2–3 фразы, без markdown»">
            <Textarea
              ref={promptRef}
              value={draft.system_prompt}
              onChange={(e) => set("system_prompt", e.target.value)}
              aria-label="Системный промпт"
              rows={8}
              className="min-h-40 text-sm"
            />
            <div className="flex flex-wrap items-center gap-1.5">
              {PROMPT_VARS.map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => insertVar(v)}
                  className="min-h-11 rounded-full border border-zinc-700 px-2.5 font-mono text-[11px] text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-200 sm:min-h-7"
                >
                  {v}
                </button>
              ))}
              <span className="ml-auto font-mono text-[11px] text-zinc-500">{draft.system_prompt.length} симв.</span>
            </div>
            {hasVars && (
              <p role="status" className="rounded-md border border-zinc-800 bg-zinc-900/40 px-2.5 py-1.5 text-xs text-zinc-400">
                Переменные <span className="font-mono">{"{{time}}"}</span> / <span className="font-mono">{"{{date}}"}</span> подставляются при каждом запросе;{" "}
                <span className="font-mono">{"{{room}}"}</span> / <span className="font-mono">{"{{station_name}}"}</span> — из имени колонки (раздел «Станции»). Если комната не задана, чип аккуратно вырезается из промпта. В тесте справа колонка не выбрана — там подставятся только время и дата.
              </p>
            )}
          </Card>

          <Card title="Модель">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid min-w-0 gap-1.5">
                <Label className="text-xs text-zinc-500">Основная</Label>
                <ModelPicker models={models} value={draft.model} loading={modelsLoading} disabled={modelsLoading} onSelect={(m) => set("model", m)} />
              </div>
              <div className="grid min-w-0 gap-1.5">
                <Label className="text-xs text-zinc-500">Запасная (если основная упала)</Label>
                <div className="flex min-w-0 gap-1.5">
                  <div className="min-w-0 flex-1">
                    <ModelPicker models={models} value={draft.fallback_model || undefined} loading={modelsLoading} disabled={modelsLoading} onSelect={(m) => set("fallback_model", m)} />
                  </div>
                  {draft.fallback_model && (
                    <Button variant="ghost" size="icon" aria-label="Убрать запасную модель" className="size-11 shrink-0 sm:size-9" onClick={() => set("fallback_model", "")}>
                      <X className="size-4" />
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </Card>

          <Card title="Длина ответа" hint="Диалоги принимают ≈1024 символа за ≈4.5 с">
            <div role="radiogroup" aria-label="Длина ответа" className="grid gap-1.5 sm:grid-cols-3">
              {ANSWER_LIMITS.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  role="radio"
                  aria-checked={limit === l.id}
                  onClick={() => set("max_tokens", l.maxTokens)}
                  className={cn(
                    "flex min-h-11 flex-col items-start justify-center rounded-md border px-3 py-1.5 text-left transition-colors",
                    limit === l.id ? "border-zinc-500 bg-zinc-800 text-zinc-50" : "border-zinc-800 text-zinc-400 hover:border-zinc-600",
                  )}
                >
                  <span className="text-sm">{l.label}</span>
                  <span className="font-mono text-[11px] text-zinc-500">
                    {l.hint} · {l.maxTokens} ток.
                  </span>
                </button>
              ))}
            </div>
            {limit === "custom" && <p className="font-mono text-[11px] text-zinc-500">Сейчас нестандартный лимит: {draft.max_tokens} токенов.</p>}
          </Card>

          <McpSection servers={servers} tools={tools} isOn={isOn} enabledCount={enabledCount} onToggle={toggleTools} onReload={loadServers} />

          <Card title="Колонки" hint="Галочка + «Применить на колонки» — подключает или отключает агента (мост перезапустится)">
            {stations === null && <p className="text-xs text-zinc-500">загрузка…</p>}
            {stations?.length === 0 && <p className="text-xs text-zinc-500">Колонок нет.</p>}
            <div className="grid gap-1.5">
              {stations?.map((s) => {
                const mine = s.agent?.slug === agent.slug;
                const other = s.agent && !mine ? s.agent.name : null;
                const off = s.state === "offline";
                return (
                  <label
                    key={s.id}
                    className={cn(
                      "flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-3",
                      picked.has(s.id) ? "border-zinc-600 bg-zinc-900/60" : "border-zinc-800",
                      (off || applying) && "cursor-not-allowed opacity-60",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={picked.has(s.id)}
                      disabled={off || applying}
                      onChange={(e) =>
                        setPicked((p) => {
                          const n = new Set(p);
                          if (e.target.checked) n.add(s.id);
                          else n.delete(s.id);
                          return n;
                        })
                      }
                      className="size-5 shrink-0 accent-emerald-500"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-zinc-200">{s.name}</span>
                      <span className="block truncate font-mono text-[11px] text-zinc-500">
                        {off ? "offline" : mine ? "сейчас на этом агенте" : other ? `сейчас: агент ${other}` : "прямая модель"}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
            {runs.length > 0 && (
              <ul className="grid gap-1" aria-live="polite" aria-label="Ход применения">
                {runs.map((r) => (
                  <li key={r.id} className="flex items-center gap-2 font-mono text-[11px]">
                    {r.state === "run" && <Loader2 className="size-3 animate-spin text-zinc-400" />}
                    {r.state === "ok" && <CheckCircle2 className="size-3.5 text-emerald-400" />}
                    {r.state === "err" && <AlertTriangle className="size-3.5 text-amber-400" />}
                    {r.state === "wait" && <span className="size-3" />}
                    <span className="text-zinc-300">{r.name}</span>
                    <span className={cn("min-w-0 truncate", r.state === "err" ? "text-amber-400" : "text-zinc-500")}>{r.text}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className={cn("xl:sticky xl:top-24", tab === "settings" && "hidden xl:block")}>
          <TestPanel agent={agent.slug} dirty={dirty} className="xl:max-h-[calc(100svh-8rem)]" />
        </div>
      </div>

      <Dialog open={delOpen} onOpenChange={(v) => !delBusy && setDelOpen(v)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Удалить «{title}»?</DialogTitle>
            <DialogDescription>
              Агент и его привязки к колонкам в сервисе будут удалены. Колонки, которые на нём сидят, останутся с model=agent:{agent.slug} и перестанут отвечать — сначала отключите их.
            </DialogDescription>
          </DialogHeader>
          {delErr && (
            <p role="alert" className="text-xs text-amber-400">
              {delErr}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" className="h-11 sm:h-9" onClick={() => setDelOpen(false)} disabled={delBusy}>
              Отмена
            </Button>
            <Button variant="destructive" className="h-11 sm:h-9" onClick={remove} disabled={delBusy}>
              {delBusy && <Loader2 className="size-4 animate-spin" />} Удалить
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
