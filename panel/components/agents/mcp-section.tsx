"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Plus, RefreshCw, Settings2, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/lib/sseClient";
import { BUILTIN_TOOLS, isActionTool, type McpServer, type McpTool } from "@/lib/agentTypes";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const STATUS: Record<string, { text: string; dot: string }> = {
  ok: { text: "online", dot: "bg-emerald-400" },
  unknown: { text: "не проверен", dot: "bg-zinc-500" },
  error: { text: "ошибка", dot: "bg-red-400" },
  circuit_open: { text: "недоступен", dot: "bg-red-400" },
};

function Dot({ status }: { status: string }) {
  const s = STATUS[status] ?? STATUS.unknown;
  return <span aria-hidden className={cn("inline-block size-1.5 shrink-0 rounded-full", s.dot)} />;
}

function Check({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      className="size-5 shrink-0 cursor-pointer accent-emerald-500 disabled:cursor-not-allowed"
    />
  );
}

/** Строка «сервер»: аккордеон со списком tools и тумблерами. */
function ServerRow({
  name,
  transport,
  status,
  tools,
  isOn,
  onToggle,
  onRefresh,
  onManage,
  refreshing,
  muted,
  note,
}: {
  name: string;
  transport: string;
  status: string;
  tools: McpTool[];
  isOn: (toolName: string) => boolean;
  onToggle: (names: string[], on: boolean) => void;
  onRefresh?: () => void;
  onManage?: () => void;
  refreshing?: boolean;
  muted?: boolean;
  note?: string;
}) {
  const [open, setOpen] = useState(false);
  const on = tools.filter((t) => isOn(t.name)).length;
  const names = tools.map((t) => t.name);
  const st = STATUS[status] ?? STATUS.unknown;
  return (
    <div className={cn("rounded-lg border border-zinc-800", muted && "opacity-60")}>
      <div className="flex min-h-11 items-center gap-2 px-2.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left"
        >
          {open ? <ChevronDown className="size-4 shrink-0 text-zinc-500" /> : <ChevronRight className="size-4 shrink-0 text-zinc-500" />}
          <Dot status={status} />
          <span className="min-w-0 truncate text-sm text-zinc-200">{name}</span>
          <span className="shrink-0 rounded border border-zinc-800 px-1 font-mono text-[10px] text-zinc-500">{transport}</span>
          <span className="hidden shrink-0 font-mono text-[11px] text-zinc-500 sm:inline">{note ?? st.text}</span>
          <span className="ml-auto shrink-0 font-mono text-[11px] text-zinc-400">
            {on} / {tools.length}
          </span>
        </button>
        {onRefresh && (
          <Button variant="ghost" size="icon" aria-label={`Перечитать ${name}`} className="size-11 sm:size-8" onClick={onRefresh} disabled={refreshing}>
            <RefreshCw className={cn("size-4", refreshing && "animate-spin")} />
          </Button>
        )}
        {onManage && (
          <Button variant="ghost" size="icon" aria-label={`Настроить ${name}`} className="size-11 sm:size-8" onClick={onManage}>
            <Settings2 className="size-4" />
          </Button>
        )}
        <Check
          checked={tools.length > 0 && on === tools.length}
          onChange={(v) => onToggle(names, v)}
          label={`Все инструменты ${name} для этого агента`}
          disabled={tools.length === 0}
        />
      </div>
      {open && (
        <div className="grid gap-0.5 border-t border-zinc-800 px-2.5 py-2">
          {tools.length === 0 && <p className="py-1 text-xs text-zinc-500">Инструменты не загружены{status !== "ok" ? ` (статус: ${st.text})` : ""}. Нажмите ↻.</p>}
          {tools.map((t) => (
            <label key={t.name} className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded px-1 hover:bg-zinc-900/60 sm:min-h-8">
              <Check checked={isOn(t.name)} onChange={(v) => onToggle([t.name], v)} label={t.tool} />
              <span className="min-w-0 flex-1">
                <span className="font-mono text-xs text-zinc-200">{t.tool}</span>
                {t.description && <span className="ml-2 text-xs text-zinc-500">{t.description.slice(0, 90)}</span>}
              </span>
              {isActionTool(t.tool) && (
                <span className="shrink-0 rounded border border-amber-900/60 px-1 font-mono text-[10px] text-amber-400" title="Похоже на действие, а не чтение">
                  действие
                </span>
              )}
            </label>
          ))}
          {tools.length > 0 && (
            <div className="flex gap-1 pt-1">
              <Button variant="ghost" size="xs" className="h-8" onClick={() => onToggle(names, true)}>
                Все
              </Button>
              <Button variant="ghost" size="xs" className="h-8" onClick={() => onToggle(names, false)}>
                Сбросить
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface SecretRow {
  name: string;
  value: string;
}

/** Диалог «+ Подключить MCP»: имя, транспорт, url/cmd, секреты (значения только на сервер), проверка tools/list. */
function AddDialog({ open, onOpenChange, onAdded }: { open: boolean; onOpenChange: (v: boolean) => void; onAdded: () => void }) {
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"http" | "sse" | "stdio">("http");
  const [url, setUrl] = useState("");
  const [cmd, setCmd] = useState("");
  const [secrets, setSecrets] = useState<SecretRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const j = await api<{ check: { ok: boolean; tools?: number; error?: string } }>("/api/mcp", {
        method: "POST",
        body: { name, transport, url: transport === "stdio" ? null : url, cmd: transport === "stdio" ? cmd : null, secrets },
      });
      if (j.check.ok) {
        setMsg({ ok: true, text: `Найдено инструментов: ${j.check.tools ?? 0} ✓` });
        onAdded();
        setTimeout(() => {
          onOpenChange(false);
          setMsg(null);
          setName("");
          setUrl("");
          setCmd("");
          setSecrets([]);
        }, 900);
      } else {
        // сервер сохранён, но не ответил: оставляем диалог открытым с причиной, список обновится
        setMsg({ ok: false, text: `Сохранён, но проверка не прошла: ${j.check.error ?? "нет ответа"}. Исправьте через ⚙ в списке.` });
        onAdded();
      }
    } catch (e2) {
      setMsg({ ok: false, text: e2 instanceof Error ? e2.message : "не удалось сохранить" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Подключить MCP-сервер</DialogTitle>
          <DialogDescription>Сервер сохранится и сразу ответит на tools/list. Секреты уходят только на сервер панели и назад не читаются.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="mcp-name">Имя (латиница, станет префиксом инструментов)</Label>
            <Input id="mcp-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="home-assistant" className="h-11 font-mono sm:h-9" required autoComplete="off" />
          </div>
          <div className="grid gap-1.5">
            <Label>Транспорт</Label>
            <div role="radiogroup" aria-label="Транспорт" className="grid grid-cols-3 gap-1.5">
              {(["http", "sse", "stdio"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={transport === t}
                  onClick={() => setTransport(t)}
                  className={cn(
                    "h-11 rounded-md border font-mono text-xs transition-colors sm:h-9",
                    transport === t ? "border-zinc-500 bg-zinc-800 text-zinc-50" : "border-zinc-800 text-zinc-400 hover:border-zinc-600",
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
          {transport === "stdio" ? (
            <div className="grid gap-1.5">
              <Label htmlFor="mcp-cmd">Команда (JSON: образ из MCP_STDIO_ALLOW и аргументы)</Label>
              <Input id="mcp-cmd" value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder='{"image":"…","args":[]}' className="h-11 font-mono text-xs sm:h-9" autoComplete="off" />
            </div>
          ) : (
            <div className="grid gap-1.5">
              <Label htmlFor="mcp-url">URL</Label>
              <Input id="mcp-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://192.168.88.207:8123/mcp" className="h-11 font-mono text-xs sm:h-9" inputMode="url" autoComplete="off" required />
            </div>
          )}
          <div className="grid gap-1.5">
            <Label>Секреты {transport === "stdio" ? "(переменные окружения)" : "(HTTP-заголовки, например Authorization)"}</Label>
            {secrets.map((s, i) => (
              <div key={i} className="grid grid-cols-[1fr_1.4fr_auto] gap-1.5">
                <Input aria-label="Имя секрета" value={s.name} onChange={(e) => setSecrets(secrets.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder={transport === "stdio" ? "API_KEY" : "Authorization"} className="h-11 font-mono text-xs sm:h-9" autoComplete="off" />
                <Input aria-label="Значение секрета" type="password" value={s.value} onChange={(e) => setSecrets(secrets.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} placeholder="значение" className="h-11 font-mono text-xs sm:h-9" autoComplete="new-password" />
                <Button type="button" variant="ghost" size="icon" aria-label="Убрать секрет" className="size-11 sm:size-9" onClick={() => setSecrets(secrets.filter((_, j) => j !== i))}>
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
            <Button type="button" variant="ghost" className="h-11 justify-start px-2 text-zinc-400 sm:h-8" onClick={() => setSecrets([...secrets, { name: "", value: "" }])}>
              <Plus className="size-4" /> Добавить секрет
            </Button>
          </div>
          {msg && (
            <p role={msg.ok ? "status" : "alert"} className={cn("text-xs", msg.ok ? "text-emerald-400" : "text-amber-400")}>
              {msg.text}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" className="h-11 sm:h-9" onClick={() => onOpenChange(false)}>
              Закрыть
            </Button>
            <Button type="submit" disabled={busy || !name.trim()} className="h-11 sm:h-9">
              {busy && <Loader2 className="size-4 animate-spin" />} Проверить и сохранить
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Настройка сервера: какие секреты заданы, замена значений, удаление. Значения не показываются никогда. */
function ManageDialog({ server, onClose, onChanged }: { server: McpServer | null; onClose: () => void; onChanged: () => void }) {
  const [names, setNames] = useState<Array<{ name: string; set: boolean }> | null>(null);
  const [loadedFor, setLoadedFor] = useState<number | null>(null);
  const [edit, setEdit] = useState<SecretRow>({ name: "", value: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);

  // загрузка при открытии (без эффекта: состояние привязано к id сервера)
  if (server && loadedFor !== server.id) {
    setLoadedFor(server.id);
    setNames(null);
    setErr(null);
    setConfirmDel(false);
    setEdit({ name: "", value: "" });
    api<{ secrets: Array<{ name: string; set: boolean }> }>(`/api/mcp/${server.id}/secrets`)
      .then((j) => setNames(j.secrets))
      .catch((e) => setErr(e instanceof Error ? e.message : "не удалось получить секреты"));
  }

  const save = async () => {
    if (!server || !edit.name.trim() || !edit.value) return;
    setBusy(true);
    setErr(null);
    try {
      const j = await api<{ secrets: Array<{ name: string; set: boolean }> }>(`/api/mcp/${server.id}/secrets`, {
        method: "PUT",
        body: { secrets: [{ name: edit.name.trim(), value: edit.value }] },
      });
      setNames(j.secrets);
      setEdit({ name: "", value: "" });
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "не удалось сохранить");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!server) return;
    setBusy(true);
    try {
      await api(`/api/mcp/${server.id}`, { method: "DELETE" });
      onChanged();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "не удалось удалить");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={server !== null} onOpenChange={(v) => !v && (setLoadedFor(null), onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{server?.name}</DialogTitle>
          <DialogDescription className="font-mono text-xs break-all">
            {server?.transport} · {server?.url ?? server?.cmd ?? "—"}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Секреты</Label>
            {names === null && !err && <p className="text-xs text-zinc-500">загрузка…</p>}
            {names?.length === 0 && <p className="text-xs text-zinc-500">Секреты не заданы.</p>}
            {names?.map((n) => (
              <div key={n.name} className="flex min-h-9 items-center justify-between rounded border border-zinc-800 px-2.5 font-mono text-xs">
                <span className="text-zinc-300">{n.name}</span>
                <span className={n.set ? "text-emerald-400" : "text-amber-400"}>{n.set ? "ключ задан ✓" : "не задан"}</span>
              </div>
            ))}
          </div>
          <div className="grid gap-1.5">
            <Label>Задать или заменить</Label>
            <div className="grid grid-cols-[1fr_1.4fr] gap-1.5">
              <Input aria-label="Имя секрета" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="Authorization" className="h-11 font-mono text-xs sm:h-9" autoComplete="off" />
              <Input aria-label="Новое значение" type="password" value={edit.value} onChange={(e) => setEdit({ ...edit, value: e.target.value })} placeholder="новое значение" className="h-11 font-mono text-xs sm:h-9" autoComplete="new-password" />
            </div>
            <Button className="h-11 sm:h-9" onClick={save} disabled={busy || !edit.name.trim() || !edit.value}>
              {busy && <Loader2 className="size-4 animate-spin" />} Сохранить секрет
            </Button>
          </div>
          {err && (
            <p role="alert" className="text-xs text-amber-400">
              {err}
            </p>
          )}
          <div className="flex items-center justify-between gap-2 border-t border-zinc-800 pt-3">
            {confirmDel ? (
              <Button variant="destructive" className="h-11 sm:h-9" onClick={remove} disabled={busy}>
                Точно удалить сервер
              </Button>
            ) : (
              <Button variant="ghost" className="h-11 text-red-400 sm:h-9" onClick={() => setConfirmDel(true)}>
                <Trash2 className="size-4" /> Удалить…
              </Button>
            )}
            <Button variant="ghost" className="h-11 sm:h-9" onClick={onClose}>
              Закрыть
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function McpSection({
  servers,
  tools,
  isOn,
  enabledCount,
  onToggle,
  onReload,
}: {
  servers: McpServer[] | null;
  tools: Record<number, McpTool[]>;
  isOn: (toolName: string) => boolean;
  enabledCount: number;
  onToggle: (names: string[], on: boolean) => void;
  onReload: () => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [manage, setManage] = useState<McpServer | null>(null);
  const [refreshing, setRefreshing] = useState<number | null>(null);
  const [refreshErr, setRefreshErr] = useState<string | null>(null);

  const refresh = async (id: number) => {
    setRefreshing(id);
    setRefreshErr(null);
    try {
      await api(`/api/mcp/${id}/refresh`, { method: "POST" });
    } catch (e) {
      setRefreshErr(e instanceof Error ? e.message : "не удалось перечитать");
    } finally {
      setRefreshing(null);
      onReload();
    }
  };

  const srvCount = (servers ?? []).filter((s) => (tools[s.id] ?? []).some((t) => isOn(t.name))).length;

  return (
    <section className="grid gap-3 rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium text-zinc-200">Инструменты (MCP)</h2>
        <span className="font-mono text-[11px] text-zinc-500">
          включено: {enabledCount} {srvCount > 0 && `· серверов: ${srvCount}`}
        </span>
        <Button variant="outline" className="ml-auto h-11 gap-1.5 px-3 sm:h-9" onClick={() => setAddOpen(true)}>
          <Plus className="size-4" /> Подключить MCP
        </Button>
      </div>

      <ServerRow name="встроенные" transport="builtin" status="ok" tools={BUILTIN_TOOLS} isOn={isOn} onToggle={onToggle} note="всегда доступны" />

      {servers === null && <p className="text-xs text-zinc-500">загрузка серверов…</p>}
      {servers?.length === 0 && (
        <div className="rounded-lg border border-dashed border-zinc-700 px-3 py-3 text-xs text-zinc-500">
          Внешние инструменты не подключены — агент отвечает знаниями модели и встроенными инструментами. Примеры: Home Assistant, погода, календарь.
        </div>
      )}
      {servers?.map((s) => (
        <ServerRow
          key={s.id}
          name={s.name}
          transport={s.transport}
          status={s.status}
          tools={tools[s.id] ?? []}
          isOn={isOn}
          onToggle={onToggle}
          onRefresh={() => refresh(s.id)}
          onManage={() => setManage(s)}
          refreshing={refreshing === s.id}
          muted={!s.enabled}
          note={!s.enabled ? "выключен" : undefined}
        />
      ))}
      {refreshErr && (
        <p role="alert" className="text-xs text-amber-400">
          {refreshErr}
        </p>
      )}

      <AddDialog open={addOpen} onOpenChange={setAddOpen} onAdded={onReload} />
      <ManageDialog server={manage} onClose={() => setManage(null)} onChanged={onReload} />
    </section>
  );
}
