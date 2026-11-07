"use client";

import { useId } from "react";
import { cn } from "@/lib/utils";

import { normalizeMode } from "@/lib/modes";

export type RingTone = "alice" | "llm" | "hybrid" | "busy" | "off";

/** Состояние колонки → тон светового кольца. */
export function ringTone(state: string, mode?: string): RingTone {
  if (state === "offline") return "off";
  if (state === "applying" || state === "bridge-down") return "busy";
  const pm = normalizeMode(mode);
  return pm === "alice" ? "alice" : pm === "hybrid" ? "hybrid" : "llm";
}

const TONE: Record<RingTone, { stroke: string; glow: string; pulse: boolean }> = {
  alice: { stroke: "#38bdf8", glow: "rgba(56,189,248,0.75)", pulse: false },
  llm: { stroke: "#34d399", glow: "rgba(52,211,153,0.75)", pulse: false },
  hybrid: { stroke: "#a78bfa", glow: "rgba(167,139,250,0.75)", pulse: false },
  busy: { stroke: "#fbbf24", glow: "rgba(251,191,36,0.8)", pulse: true },
  off: { stroke: "#3f3f46", glow: "transparent", pulse: false },
};

// Силуэты в общем viewBox 56×72: верх цилиндра (кольцо) и высота корпуса.
const SHAPES: Record<string, { top: number; rx: number; ry: number; bottom: number }> = {
  max: { top: 10, rx: 17, ry: 5, bottom: 66 }, // высокая
  mini: { top: 30, rx: 22, ry: 6, bottom: 64 }, // шарообразная, ниже и шире
  lite: { top: 48, rx: 24, ry: 6, bottom: 64 }, // низкая «шайба»
  unknown: { top: 18, rx: 19, ry: 5.5, bottom: 66 }, // аккуратный цилиндр
};

interface Props {
  kind?: string;
  tone: RingTone;
  className?: string;
  /** подпись для скринридера */
  label?: string;
}

export function StationSvg({ kind = "unknown", tone, className, label }: Props) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const shape = SHAPES[kind] ?? SHAPES.unknown;
  const t = TONE[tone];
  const { top, rx, ry, bottom } = shape;
  const cx = 28;
  const left = cx - rx;
  const right = cx + rx;
  const dim = tone === "off";

  // корпус: боковые стенки + скруглённое дно
  const body = `M ${left} ${top} L ${left} ${bottom - ry} A ${rx} ${ry} 0 0 0 ${right} ${bottom - ry} L ${right} ${top} Z`;

  return (
    <svg
      viewBox="0 0 56 72"
      role="img"
      aria-label={label ?? "Колонка"}
      className={cn("shrink-0 overflow-visible", className)}
    >
      <defs>
        <linearGradient id={`b${uid}`} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#18181b" />
          <stop offset="0.45" stopColor="#3f3f46" />
          <stop offset="1" stopColor="#18181b" />
        </linearGradient>
        <pattern id={`g${uid}`} width="3" height="3" patternUnits="userSpaceOnUse">
          <circle cx="1.5" cy="1.5" r="0.45" fill="#a1a1aa" opacity="0.35" />
        </pattern>
        <radialGradient id={`s${uid}`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor={t.glow} stopOpacity={dim ? 0 : 0.45} />
          <stop offset="1" stopColor={t.glow} stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* свечение под кольцом */}
      {!dim && <ellipse cx={cx} cy={top} rx={rx + 8} ry={ry + 8} fill={`url(#s${uid})`} className={t.pulse ? "station-pulse" : undefined} />}

      {/* корпус и тканевая сетка */}
      <path d={body} fill={`url(#b${uid})`} stroke="#27272a" strokeWidth="1" opacity={dim ? 0.8 : 1} />
      <path d={body} fill={`url(#g${uid})`} />

      {/* верхняя крышка */}
      <ellipse cx={cx} cy={top} rx={rx} ry={ry} fill="#09090b" stroke="#27272a" strokeWidth="1" />

      {/* световое кольцо — индикатор */}
      <ellipse
        cx={cx}
        cy={top}
        rx={rx - 2.5}
        ry={ry - 1.4}
        fill="none"
        stroke={t.stroke}
        strokeWidth="1.6"
        className={t.pulse ? "station-pulse" : undefined}
        style={dim ? undefined : { filter: `drop-shadow(0 0 3px ${t.glow})` }}
      />
    </svg>
  );
}

/** Контурный силуэт для пустого состояния. */
export function StationOutline({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 56 72" aria-hidden className={cn("shrink-0", className)} fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray="3 3">
      <path d="M 9 18 L 9 60 A 19 5.5 0 0 0 47 60 L 47 18" />
      <ellipse cx="28" cy="18" rx="19" ry="5.5" />
      <ellipse cx="28" cy="18" rx="16" ry="4" strokeDasharray="1 3" />
    </svg>
  );
}
