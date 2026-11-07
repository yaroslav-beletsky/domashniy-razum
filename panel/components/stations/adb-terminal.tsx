"use client";

// Настоящий терминал ADB: @xterm/xterm ↔ SSE (вывод) + POST (ввод) ↔ долгоживущий
// `adb shell -tt` на сервере (pty на устройстве — промпт, эхо, backspace работают).
// Никаких чипов/историй/кнопок: подключился и печатай. Из UI — только точка статуса.
import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { cn } from "@/lib/utils";

type TermState = "connecting" | "online" | "reconnecting";

export function AdbTerminal({
  stationId,
  device,
  active,
}: {
  stationId: string;
  device: string;
  /** Вкладка терминала сейчас видима: по true делаем fit + фокус. */
  active: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const chainRef = useRef<Promise<void>>(Promise.resolve()); // порядок POST'ов ввода
  const bufRef = useRef("");
  const timerRef = useRef<number | null>(null);
  const [state, setState] = useState<TermState>("connecting");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 2000,
      theme: {
        background: "#09090b", // zinc-950, как остальной UI
        foreground: "#e4e4e7", // zinc-200
        cursor: "#34d399", // emerald-400
        cursorAccent: "#09090b",
        selectionBackground: "#3f3f46",
        black: "#18181b",
        red: "#f87171",
        green: "#4ade80",
        yellow: "#fbbf24",
        blue: "#60a5fa",
        magenta: "#c084fc",
        cyan: "#22d3ee",
        white: "#e4e4e7",
        brightBlack: "#52525b",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    // ввод: батчим нажатия (мобильные клавиатуры шлют по событию на символ),
    // порядок гарантируем цепочкой промисов — SSE-вывод вернётся в правильном виде
    const flush = () => {
      timerRef.current = null;
      const d = bufRef.current;
      bufRef.current = "";
      if (!d) return;
      chainRef.current = chainRef.current.then(async () => {
        try {
          await fetch(`/api/stations/${stationId}/adb/terminal/input`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ d }),
          });
        } catch {
          /* сеть моргнула — пользователь просто не увидит эхо этих клавиш, продолжаем */
        }
      });
    };
    term.onData((d) => {
      bufRef.current += d;
      if (timerRef.current === null) timerRef.current = window.setTimeout(flush, 12);
    });

    // вывод по SSE; при переподключении чистим экран — сервер пришлёт backlog сессии
    let dropped = false;
    let first = true;
    const es = new EventSource(`/api/stations/${stationId}/adb/terminal`);
    es.onopen = () => {
      setState("online");
      if (!first && dropped) term.reset(); // переподключение: backlog придёт заново
      first = false;
      dropped = false;
    };
    es.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data) as { t?: string; d?: string };
        if (m.t === "o" && typeof m.d === "string") term.write(m.d);
      } catch {
        /* мусорное событие — игнорируем */
      }
    };
    es.onerror = () => {
      if (!dropped && !first) {
        dropped = true;
        setState("reconnecting");
        term.write("\r\n\x1b[2m[связь с терминалом потеряна — переподключаемся…]\x1b[0m\r\n");
      }
      // EventSource сам ретраит; onopen почистит и продолжит
    };

    // вписывание в контейнер: смена размера, поворот, клавиатура на мобильном
    let raf = 0;
    const scheduleFit = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        try {
          fit.fit();
        } catch {
          /* контейнер без размеров (вкладка скрыта) — пропускаем */
        }
      });
    };
    const ro = new ResizeObserver(scheduleFit);
    ro.observe(host);
    window.addEventListener("resize", scheduleFit);
    window.visualViewport?.addEventListener("resize", scheduleFit);
    window.addEventListener("orientationchange", scheduleFit);
    scheduleFit();

    return () => {
      es.close();
      ro.disconnect();
      window.removeEventListener("resize", scheduleFit);
      window.visualViewport?.removeEventListener("resize", scheduleFit);
      window.removeEventListener("orientationchange", scheduleFit);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [stationId]);

  // открытие вкладки: пере-fit (вкладка могла быть скрыта — размеры 0) и фокус в терминал
  useEffect(() => {
    if (!active) return;
    const t = window.setTimeout(() => {
      try {
        fitRef.current?.fit();
      } catch {
        /* ignore */
      }
      termRef.current?.focus();
    }, 50);
    return () => window.clearTimeout(t);
  }, [active]);

  const dot = state === "online" ? "bg-emerald-400" : state === "connecting" ? "bg-amber-400 animate-pulse" : "bg-amber-400 animate-pulse";

  return (
    <section aria-label="Терминал ADB" className="flex flex-col gap-1.5">
      <p className="flex items-center gap-1.5 font-mono text-[11px] text-zinc-500">
        <span className={cn("inline-block size-1.5 rounded-full", dot)} aria-hidden />
        <span className="truncate">{device}</span>
        <span className="text-zinc-700">{state === "reconnecting" ? "переподключение…" : state === "connecting" ? "подключение…" : ""}</span>
      </p>
      <div ref={hostRef} className="h-[58svh] min-h-[320px] w-full overflow-hidden rounded-md border border-zinc-800 bg-[#09090b] p-1.5" />
    </section>
  );
}
