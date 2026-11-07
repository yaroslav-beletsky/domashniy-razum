"use client";

import Link from "next/link";
import { Bot } from "lucide-react";

/** Бейдж «Агент: имя ↗». На карточке (внутри Link) — без вложенной ссылки.
 *  Выбора агента в панели больше нет: все колонки идут в единственного агента,
 *  подключение/отключение — аварийные действия на странице колонки (меня «⋯»/«Подключить»). */
export function AgentBadge({ agent, link }: { agent: { slug: string; name: string }; link?: boolean }) {
  const cls = "inline-flex h-5 max-w-full items-center gap-1 truncate rounded border border-violet-900/60 bg-violet-950/30 px-1.5 font-mono text-[11px] text-violet-300";
  const body = (
    <>
      <Bot className="size-3 shrink-0" aria-hidden />
      <span className="truncate">Агент: {agent.name}</span>
      {link && <span aria-hidden>↗</span>}
    </>
  );
  return link ? (
    <Link href={`/agent/${agent.slug}`} className={`${cls} hover:border-violet-700`}>
      {body}
    </Link>
  ) : (
    <span className={cls}>{body}</span>
  );
}
