// Сканер колонок в LAN (шаг 1 мастера). POST {subnet?} → SSE:
//   {type:"progress", scanned, total} · {type:"host", ip, known} · {type:"done", candidates}
// Контейнер видит LAN через NAT (colima), поэтому скан TCP; ARP/MAC-вендор и mDNS изнутри
// недоступны. NAT бывает «тугим» — скан идёт в 4 прохода: реестр (щедрый таймаут), :5555 с
// повтором, alive-порты и второй шанс для молчащих.
import { NextRequest } from "next/server";
import { config } from "@/lib/config";
import { sse } from "@/lib/agentRoutes";
import { scanLan } from "@/lib/wizardExec";
import { listStations } from "@/lib/stationsStore";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

export async function POST(req: NextRequest) {
  let subnet = config.wizardLanSubnet;
  try {
    const b = await req.json().catch(() => ({}));
    if (typeof b?.subnet === "string" && b.subnet.trim()) subnet = b.subnet.trim();
  } catch {
    /* дефолт */
  }
  const known = new Map<string, string>();
  for (const s of listStations()) known.set(s.device.split(":")[0], s.name ? `${s.name} (${s.device})` : s.device);
  return sse(async (send) => {
    send({ type: "log", level: "info", text: `сканирую ${subnet}.0/24 (TCP :5555 + alive-порты)…` });
    await scanLan(subnet, known, send);
  });
}
