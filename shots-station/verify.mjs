// Смоук + скрины панели station-llm (playwright-core + системный Chrome).
// Отсутствующий verify.mjs дизайнера — функциональный эквивалент, собранный на месте.
import { chromium } from "playwright-core";
import fs from "node:fs";

const BASE = "http://192.168.88.207:3110";
const ID = "192.168.88.79-5555";
const OUT = "/Users/yaroslav/Documents/home/station-llm/shots-station";
fs.mkdirSync(OUT, { recursive: true });

const PAGES = [
  ["home", "/"],
  ["stations", "/stations"],
  ["station-detail", `/stations/${ID}`],
  ["add-station", "/add-station"],
  ["voice", "/voice"],
  ["models", "/models"],
  ["logs", "/logs"],
];

const results = [];
const browser = await chromium.launch({ channel: "chrome", headless: true });

// Desktop
for (const [label, path] of PAGES) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  let status = 0;
  const resp = await page.goto(`${BASE}${path}`, { waitUntil: "load", timeout: 30000 }).catch((e) => { errors.push("goto: " + String(e).slice(0, 120)); return null; });
  status = resp ? resp.status() : 0;
  await page.waitForTimeout(2500); // дать SSE/фетчам отрисоваться
  const shot = `${OUT}/desktop-${label}.png`;
  await page.screenshot({ path: shot }).catch(() => {});
  results.push({ page: label, tag: "desktop", http: status, shot, consoleErrors: errors });
  await context.close();
}

// Mobile
for (const [label, path] of PAGES) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  let status = 0;
  const resp = await page.goto(`${BASE}${path}`, { waitUntil: "load", timeout: 30000 }).catch((e) => { errors.push("goto: " + String(e).slice(0, 120)); return null; });
  status = resp ? resp.status() : 0;
  await page.waitForTimeout(2500);
  const shot = `${OUT}/mobile-${label}.png`;
  await page.screenshot({ path: shot }).catch(() => {});
  results.push({ page: label, tag: "mobile", http: status, shot, consoleErrors: errors });
  await context.close();
}

// Блок «Голос» на детальной станции (desktop): видимость + скрин блока
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.goto(`${BASE}/stations/${ID}`, { waitUntil: "load", timeout: 30000 });
  const section = page.locator('section[aria-label="Голос колонки"]');
  await section.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  const visible = await section.isVisible().catch(() => false);
  const text = visible ? (await section.innerText()).slice(0, 300) : null;
  if (visible) await section.screenshot({ path: `${OUT}/desktop-station-detail-voice-block.png` }).catch(() => {});
  // мобильный вариант блока
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const mpage = await mctx.newPage();
  await mpage.goto(`${BASE}/stations/${ID}`, { waitUntil: "load", timeout: 30000 });
  const msection = mpage.locator('section[aria-label="Голос колонки"]');
  await msection.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  const mvisible = await msection.isVisible().catch(() => false);
  if (mvisible) await msection.scrollIntoViewIfNeeded().catch(() => {});
  if (mvisible) await msection.screenshot({ path: `${OUT}/mobile-station-detail-voice-block.png` }).catch(() => {});
  results.push({ page: "voice-block", tag: "check", desktopVisible: visible, mobileVisible: mvisible, text });
  await context.close(); await mctx.close();
}

await browser.close();
fs.writeFileSync(`${OUT}/verify-results.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
