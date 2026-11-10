// Прокси к стенду: read-only список недавних клиентов для авто-discovery.
// GET → JSON {clients: [{ip, ts, path, platform, version, ua}]}
// Стенд живёт на 192.168.88.23 (standBaseUrl), self-signed сертификат —
// rejectUnauthorized=false осознанно и только к стенду.
import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import https from "node:https";

export const dynamic = "force-dynamic";

interface StandClient {
  ip: string;
  ts: number;
  path: string;
  platform: string;
  version: string;
  ua: string;
  /** MAC из ARP хоста стенда (нижний регистр) — используется для пере-резолва адреса. */
  mac?: string;
}

export async function GET() {
  const url = `${config.standBaseUrl}/recent_clients`;

  const body = await new Promise<string | null>((resolve) => {
    const req = https.get(url, { rejectUnauthorized: false, timeout: 8000 }, (res) => {
      let data = "";
      res.on("data", (d: Buffer) => (data += d.toString("utf8")));
      res.on("end", () => resolve(data));
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });

  if (body === null) {
    return NextResponse.json({ ok: false, error: "стенд не ответил", clients: [] });
  }

  try {
    const j = JSON.parse(body) as { clients?: StandClient[] };
    const clients = (j.clients ?? []).filter(
      (c) => c.ip && !c.ip.startsWith("127.") && !c.ip.startsWith("0."),
    );
    return NextResponse.json({ ok: true, clients });
  } catch {
    return NextResponse.json({ ok: false, error: "стенд вернул не JSON", clients: [] });
  }
}
