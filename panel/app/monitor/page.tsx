"use client";

// Монитор сервера: живой tail -f по выбранным источникам (SSE).
// По умолчанию открыт стенд lite-kit на .23 — то, за чем владелец следил в терминале.
import { LogsViewer } from "@/components/diagnostics/logs-viewer";

export default function MonitorPage() {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h1 className="text-lg font-medium text-zinc-100">Монитор</h1>
        <span className="font-mono text-xs text-zinc-500">tail -f без терминала: стенд · агент · мост · панель</span>
      </div>
      <LogsViewer initialSource="stand" />
    </div>
  );
}
