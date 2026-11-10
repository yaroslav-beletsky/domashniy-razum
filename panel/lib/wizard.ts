// Мастер «Добавить колонку» (ветка A — локальный мост).
// Машина шагов по docs/add-station-wizard.md (A.1): каждый шаг имеет критерий успеха,
// экран ведёт человека, автоматику исполняет сервер. Состояние персистентно (файл рядом
// с реестром колонок), без секретов. Скрипты исполнения — в lib/wizardExec.ts.
import fs from "node:fs";
import path from "node:path";
import { config } from "./config";
import { parseDevice } from "./stationsStore";

export type WizardStepId =
  | "discover"
  | "stand"
  | "reset"
  | "bindwifi"
  | "ota"
  | "adbroot"
  | "bridge"
  | "persist"
  | "staticip"
  | "noupdate"
  | "mode"
  | "register"
  | "test";

export type StepKind = "auto" | "manual" | "semi";
export type StepStatus = "pending" | "running" | "done" | "error" | "skipped";

export interface WizardStepDef {
  id: WizardStepId;
  n: number;
  title: string;
  /** Текст для неспециалиста: что делать / что сейчас произойдёт. */
  hint: string;
  kind: StepKind;
  skippable: boolean;
  /** «Примерно минут» для экрана прогресса. */
  estMin: number;
  /** Критерий успеха — показываем на экране до запуска. */
  criteria: string;
  /** Опасная операция (правка /system, отключение обновлений) — просим явное подтверждение. */
  danger?: boolean;
  /** Откат (памятка на экране). */
  rollback?: string;
  /** Больше не используется: заглушек в v1 не осталось (поле оставлено для совместимости UI). */
  todo?: string;
}

// Порядок: сначала физика руками владельца (сброс → Wi-Fi), затем автоматика
// (поиск → стенд → прошивка → adb → мост → закрепление → статика → noupdate →
// режим → регистрация → тест). Черновики хранят статусы по id шага, а не по
// индексу — перестановка списка безопасна для существующих черновиков.
export const WIZARD_STEPS: WizardStepDef[] = [
  {
    id: "reset",
    n: 1,
    title: "Сброс к заводским",
    hint: "Обесточьте колонку. Зажмите кнопку микрофона, подайте питание и держите 10–15 секунд, пока не мигнёт подсветка и голос не скажет о сбросе. Потом жмите «Готово».",
    kind: "manual",
    skippable: true,
    estMin: 3,
    criteria: "Подсветка мигнула, ассистент сообщил о сбросе; колонка снова в сети.",
    rollback: "Повторить сброс.",
  },
  {
    id: "bindwifi",
    n: 2,
    title: "Привязка и Wi-Fi",
    hint: "В приложении вендора добавьте колонку и дайте ей ваш Wi-Fi (сеть с нашим DNS). Жмите «Готово», когда она доедет до сети.",
    kind: "manual",
    skippable: true,
    estMin: 5,
    criteria: "Колонка привязана, в сети; домен активации указывает на стенд.",
    rollback: "Сбросить привязку и начать с шага «Сброс».",
  },
  {
    id: "discover",
    n: 3,
    title: "Найти колонку в сети",
    hint: "Найду колонку в вашей сети. Ничего делать не нужно — просто выберите её из списка найденных (или введите адрес вручную).",
    kind: "auto",
    skippable: false,
    estMin: 1,
    criteria: "Устройство найдено, адрес известен, тип опознан.",
  },
  {
    id: "stand",
    n: 4,
    title: "Стенд с откатной прошивкой",
    hint: "Готовлю сервер настройки, чтобы колонка сама поставила нужную версию. Проверяю, что стенд отвечает, DNS ведёт нужные домены на стенд, сертификат выстроен в доверенную цепочку и активационная прошивка для модели колонки на месте.\n\nDNS: домены quasar.yandex.net, quasar.yandex.ru, scbh.yandex.net должны резолвиться на IP стенда (через DHCP-резолвер, который получит колонка). Если все уже резолвятся — «DNS настроен, прописывать ничего не нужно». Иначе — пропишите на своём роутере/резолвере форвард этих доменов на IP стенда.",
    kind: "auto",
    skippable: false,
    estMin: 1,
    criteria: "Стенд отвечает: adbd включён в get_sync_info; quasar.yandex.net / quasar.yandex.ru / scbh.yandex.net через DHCP-резолвер → IP стенда; сертификат eMudhra-цепочка; check_updates → hasUpdate: стенд сам называет версию для модели колонки.",
    rollback: "Снять подмену доменов на промежуточном резолвере (вернуть настоящий DNS).",
  },
  {
    id: "ota",
    n: 5,
    title: "Прошивка нужной версии",
    hint: "Колонка сама скачает и поставит нужную версию с нашего стенда (обычно 3–10 минут). Просто не выключайте её. Я сам жду появления adb и сверяю версию с той, что отдаёт стенд для модели колонки; если ещё не готово — подождите пару минут и нажмите «Повторить».",
    kind: "semi",
    skippable: true,
    estMin: 10,
    criteria: "Прошивка = версия, которую стенд отдаёт для модели колонки; колонка перезагрузилась.",
    rollback: "Снять hasUpdate на стенде / вернуть штатный ключ (пока обновления не заблокированы).",
  },
  {
    id: "adbroot",
    n: 6,
    title: "Включить adb и root",
    hint: "Включаю доступ к железу. Колонка уже отдаёт его сама — подключаюсь (несколько попыток) и проверяю root.",
    kind: "auto",
    skippable: false,
    estMin: 1,
    criteria: "adb connect успешен; shell id → uid=0(root).",
    rollback: "Снять маркеры /data/quasar/activate_adb_*.",
  },
  {
    id: "bridge",
    n: 7,
    title: "Установить мост на LiteLLM",
    hint: "Ставлю наш форк моста (со сменой голоса, мужской по умолчанию), прописываю адрес модели и ключ, записываю голос в tts.override и переключаю uniproxy на мост. Переключение заработает после перезагрузки — она будет на следующем шаге.",
    kind: "semi",
    skippable: false,
    estMin: 5,
    criteria: "control.sh status → Bridge healthy; в quasar.cfg uniproxy → 127.0.0.1:8443 (бэкап endpoint-backup.json); tts.override с голосом на месте.",
    rollback: "control.sh rollback (вернуть uniproxy), удалить мост. Голос: rm /data/opt/quasar-bridge/tts.override; вернуться на оригинал — оригинальный бинарь в app/bin/quasar-bridge.",
  },
  {
    id: "persist",
    n: 8,
    title: "Закрепить доступ (три слоя)",
    hint: "Делаю доступ неубиваемым, чтобы его не сняла ни одна обнова: неизменяемые маркеры, конфиг прошивки с пустой деактивацией, блок обходного DNS и страховочный автозапуск. В конце перезагружаю колонку и убеждаюсь, что доступ поднялся сам (1–2 минуты) — заодно вступит в силу переключение на мост.",
    kind: "auto",
    skippable: false,
    estMin: 4,
    criteria: "lsattr показывает «i» на маркерах; deactivate = /bin/true; DoH заблокирован; после перезагрузки adb/root поднялись сами и всё закрепление на месте.",
    danger: true,
    rollback: "chattr -i; patch-quasar-cfg-adbd.sh restore; убрать /etc/init.d/S98adbd.",
  },
  {
    id: "staticip",
    n: 9,
    title: "Статический адрес и DNS",
    hint: "Закрепляю адрес, чтобы всё не зависело от роутера: прописываю текущий адрес, шлюз и промежуточный DNS в dhcpcd.conf (оригинал сохраняю в /data/opt/backup), затем перезагружаю колонку и проверяю, что адрес и DNS-цепочка до стенда работают.",
    kind: "auto",
    skippable: true,
    estMin: 4,
    criteria: "После перезагрузки адрес тот же; в dhcpcd.conf статика; quasar.yandex.net с колонки резолвится в стенд.",
    danger: true,
    rollback: "Вернуть /data/opt/backup/dhcpcd.conf.orig и перезагрузить.",
  },
  {
    id: "noupdate",
    n: 10,
    title: "Заблокировать обновления",
    hint: "Отключаю автосброс, чтобы обнова не снесла доступ. Делается сразу, пока adb жив. Заодно забираю бэкап оригиналов к себе — сброс колонки его стёр бы.",
    kind: "auto",
    skippable: false,
    estMin: 2,
    criteria: "yandex-noupdate.sh status: ключ подменён, updatesd убран; копия /data/opt/backup на панели.",
    danger: true,
    rollback: "yandex-noupdate.sh restore + reboot.",
  },
  {
    id: "mode",
    n: 11,
    title: "Режим",
    hint: "Выберите, кто отвечает: Алиса / только сложные вопросы — модель / всё — модель. Модель подставится от агента автоматически; настройки записываются, мост перезапускается с проверкой.",
    kind: "semi",
    skippable: false,
    estMin: 2,
    criteria: "Мост healthy с новым PID; режим выставлен; при отказе настройки возвращены.",
    rollback: "Снимок runtime.env/config.json; вернуть режим «Алиса».",
  },
  {
    id: "register",
    n: 12,
    title: "Регистрация и агент",
    hint: "Регистрирую колонку в панели и сразу подключаю её к единственному агенту — без ручного выбора. Ключ колонки на экран не выводится — он сразу прописывается на колонке.",
    kind: "semi",
    skippable: false,
    estMin: 2,
    criteria: "Карточка в «Колонках» онлайн; агент привязан; ключ подставлен.",
    rollback: "Отвязать агента и удалить колонку из панели.",
  },
  {
    id: "test",
    n: 13,
    title: "Тест",
    hint: "Скажите колонке тестовую фразу — из динамика должен ответить ваш агент. Ниже можно посмотреть свежие строки лога моста: должно быть видно, что запрос ушёл в модель (route=llm), а не в облако.",
    kind: "semi",
    skippable: true,
    estMin: 2,
    criteria: "Колонка ответила нашим агентом/моделью; в логе нет ухода в облако по умолчанию.",
    rollback: "Переключить режим (шаг «Режим»).",
  },
];

export const STEP_BY_ID = new Map(WIZARD_STEPS.map((s) => [s.id, s]));
export const STEP_ORDER: WizardStepId[] = WIZARD_STEPS.map((s) => s.id);

/** Платформа активационной прошивки по типу колонки. Стенд сам решает, какую
 *  версию отдать по platform (мини 2 → .46, Станция 2 → .50), поэтому мастер
 *  НЕ хардкодит версию — целевую версию называет стенд в check_updates. */
export const KIND_PLATFORM: Record<string, string> = {
  mini: "yandexmini_2",
  station2: "yandexmidi",
};

/** Платформа по типу; null — тип не отображён на известную платформу
 *  (в exec-скриптах fallback на config.wizardPlatform). */
export function platformForKind(kind?: string): string | null {
  return (kind && KIND_PLATFORM[kind]) || null;
}

export function nextStep(id: WizardStepId): WizardStepId | null {
  const i = STEP_ORDER.indexOf(id);
  return i >= 0 && i < STEP_ORDER.length - 1 ? STEP_ORDER[i + 1] : null;
}
export function prevStep(id: WizardStepId): WizardStepId | null {
  const i = STEP_ORDER.indexOf(id);
  return i > 0 ? STEP_ORDER[i - 1] : null;
}

// ---------- состояние мастера ----------

export interface StepState {
  status: StepStatus;
  at?: number;
  note?: string;
}

export interface WizardState {
  key: string; // host:port — фиксированный ключ черновика, не меняется при переезде
  host: string;
  port: number;
  /** MAC колонки (нижний регистр) — по нему мастер пере-резолвит текущий IP, если адрес сменился. */
  mac?: string;
  /** Предыдущий адрес (до переезда) — только для журнала/диагностики. */
  lastHost?: string;
  name?: string;
  kind?: string;
  /** Платформа активационной прошивки (yandexmini_2 / yandexmidi / …) — по типу
   *  колонки; стенд по ней сам называет целевую версию. */
  platform?: string;
  current: WizardStepId;
  steps: Record<string, StepState>;
  log: { ts: number; level: "info" | "ok" | "err"; text: string }[];
  createdAt: number;
  updatedAt: number;
  registeredId?: string;
  // выбранные на шаге «Режим и модель»
  mode?: string;
  model?: string;
}

const FILE = process.env.WIZARD_STATE_FILE ?? path.join(config.adbHome, ".android", "panel-wizard.json");
const MAX_LOG = 300;

function readAll(): Record<string, WizardState> {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, "utf8")) as { states?: Record<string, WizardState> };
    return j.states && typeof j.states === "object" ? j.states : {};
  } catch {
    return {};
  }
}

function writeAll(states: Record<string, WizardState>): string | null {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ states }, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, FILE);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message.slice(0, 120) : "не удалось записать состояние мастера";
  }
}

export function listWizardStates(): WizardState[] {
  return Object.values(readAll()).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getWizardState(key: string): WizardState | null {
  return readAll()[key] ?? null;
}

/** Состояние черновика по ключу ЛИБО по текущему адресу колонки (если адрес «переехал»).
 *  Нужно шагам, которые получили уже пере-резолвленный device вместо исходного ключа. */
export function getWizardStateAny(addr: string): WizardState | null {
  const all = readAll();
  if (all[addr]) return all[addr];
  const host = addr.split(":")[0];
  return Object.values(all).find((s) => s.host === host || s.key.split(":")[0] === host) ?? null;
}

export function appendWizardLog(key: string, level: "info" | "ok" | "err", text: string): void {
  const states = readAll();
  const st = states[key];
  if (!st) return;
  st.log.push({ ts: Date.now(), level, text: text.slice(0, 500) });
  if (st.log.length > MAX_LOG) st.log = st.log.slice(-MAX_LOG);
  st.updatedAt = Date.now();
  writeAll(states);
}

export function setWizardStep(key: string, step: WizardStepId, patch: StepState): void {
  const states = readAll();
  const st = states[key];
  if (!st) return;
  st.steps[step] = { ...st.steps[step], ...patch, at: Date.now() };
  st.updatedAt = Date.now();
  writeAll(states);
}

export function setWizardCurrent(key: string, current: WizardStepId): void {
  const states = readAll();
  const st = states[key];
  if (!st) return;
  st.current = current;
  st.updatedAt = Date.now();
  writeAll(states);
}

export function patchWizardState(key: string, patch: Partial<WizardState>): string | null {
  const states = readAll();
  const st = states[key];
  if (!st) return "черновик не найден";
  Object.assign(st, patch, { updatedAt: Date.now() });
  return writeAll(states);
}

export function deleteWizardState(key: string): void {
  const states = readAll();
  delete states[key];
  writeAll(states);
}

/** Создаёт черновик мастера для колонки. Шаг «Поиск» (discover) считается выполненным —
 *  адрес выбран. Шаги подготовки (сброс/Wi-Fi) отмечаются по ответу диалога добавления:
 *  prep.reset / prep.wifi = "done" | "skipped" | undefined (не трогать). */
export function createWizardState(
  host: string,
  port?: number | string,
  name?: string,
  kind?: string,
  prep?: { reset?: "done" | "skipped"; wifi?: "done" | "skipped" },
  mac?: string,
): { ok: boolean; key?: string; error?: string } {
  const p = parseDevice(host, port ?? 5555);
  if (!p.device) return { ok: false, error: p.error ?? "некорректный адрес" };
  const states = readAll();
  if (states[p.device]) return { ok: false, error: "для этой колонки уже есть черновик — продолжите его" };
  const now = Date.now();
  const steps: Record<string, StepState> = {
    discover: { status: "done", at: now, note: "адрес выбран вручную или из списка найденных" },
  };
  if (prep?.reset) steps.reset = { status: prep.reset, at: now, note: prep.reset === "done" ? "подтверждено в диалоге добавления" : "пропущено в диалоге добавления" };
  if (prep?.wifi) steps.bindwifi = { status: prep.wifi, at: now, note: prep.wifi === "done" ? "подтверждено в диалоге добавления" : "пропущено в диалоге добавления" };
  states[p.device] = {
    key: p.device,
    host: host.trim(),
    port: Number(port ?? 5555) || 5555,
    mac: mac?.trim().toLowerCase() || undefined,
    name: name?.trim() || undefined,
    kind: kind?.trim() || undefined,
    platform: platformForKind(kind?.trim() || undefined) ?? undefined,
    current: "stand",
    steps,
    log: [{ ts: now, level: "info", text: `черновик создан для ${p.device}` }],
    createdAt: now,
    updatedAt: now,
  };
  const err = writeAll(states);
  return err ? { ok: false, error: err } : { ok: true, key: p.device };
}
