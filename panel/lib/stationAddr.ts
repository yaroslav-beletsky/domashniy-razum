// Сопоставление «адрес станции из реестра» ↔ её текущий IP по MAC.
// Панель и реестр держат IP (host:port). У станции адрес может смениться (DHCP):
// тогда по сохранённому MAC находим актуальный IP в ARP-таблице хоста и транслируем
// адрес ТОЛЬКО в момент adb-вызова. Реестр/id при этом не меняются.
// Best-effort: если arp/neigh недоступны (напр. внутри docker без доступа в LAN) —
// возвращаем адрес как есть, поведение прежнее.
import { execSync } from "node:child_process";
import { listStations } from "./stationsStore";

const memMac = new Map<string, string>(); // device -> mac (из успешных опросов)
const arpCache = { at: 0, table: new Map<string, string>() };
let lastWarm = 0;

/** Запомнить MAC станции (вызывается при удачном опросе, кладётся и в реестр). */
export function rememberMac(device: string, mac?: string): void {
  if (device && mac) memMac.set(device, mac.toLowerCase());
}

function macFor(device: string): string | undefined {
  const m = memMac.get(device) ?? listStations().find((s) => s.device === device)?.last?.mac;
  return m ? m.toLowerCase() : undefined;
}

function parseArp(out: string, table: Map<string, string>): void {
  // macOS: `? (192.168.88.48) at b8:87:6e:57:9e:48 on en0 ifscope [ethernet]`
  // Linux (busybox/iproute): `? (192.168.88.48) at b8:87:6e:57:9e:48 [ether] on eth0`
  for (const line of out.split("\n")) {
    const m = line.match(/\((\d+\.\d+\.\d+\.\d+)\)\s+at\s+([0-9a-f:]{11,17})/i);
    if (m) table.set(m[2].toLowerCase(), m[1]);
  }
}

function arpTable(fresh = false): Map<string, string> {
  if (!fresh && Date.now() - arpCache.at < 4000) return arpCache.table;
  const table = new Map<string, string>();
  try {
    parseArp(execSync("arp -an 2>/dev/null", { encoding: "utf8", timeout: 2000, shell: "/bin/sh" }), table);
  } catch {
    /* нет arp */
  }
  if (!table.size) {
    try {
      parseArp(execSync("ip -4 neigh 2>/dev/null", { encoding: "utf8", timeout: 2000, shell: "/bin/sh" }), table);
    } catch {
      /* ignore */
    }
  }
  arpCache.at = Date.now();
  arpCache.table = table;
  return table;
}

/** IP по MAC из ARP; null — неизвестно. */
export function ipByMac(mac?: string): string | null {
  if (!mac) return null;
  return arpTable().get(mac.toLowerCase()) ?? null;
}

/** Разбудить ARP широковещательным пингом (не чаще раза в 10 с). */
function arpWarm(): void {
  if (Date.now() - lastWarm < 10000) return;
  lastWarm = Date.now();
  try {
    execSync("ping -c 1 -t 1 255.255.255.255 >/dev/null 2>&1", { timeout: 1500, shell: "/bin/sh" });
  } catch {
    /* ignore */
  }
}

/** Адрес для adb: если по MAC виден новый IP — отдаём его, иначе исходный device. */
export function resolveDevice(device: string): string {
  if (!device) return device;
  const i = device.indexOf(":");
  const host = i < 0 ? device : device.slice(0, i);
  const port = i < 0 ? "5555" : device.slice(i + 1);
  const mac = macFor(device);
  let cur = mac ? ipByMac(mac) : null;
  if (mac && !cur) {
    arpWarm();
    cur = ipByMac(mac);
  }
  if (!mac) return device;
  if (cur && cur !== host) return `${cur}:${port}`;
  return device;
}
