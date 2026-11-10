# KB — station-llm / стенд lite-kit / trust-чейн колонки

> **Правило шапки.** Отвечаем по-русски, коротко. Не коммитим/пушим без просьбы.
> Секреты и ключи (LiteLLM, glagol-токены) не печатаем. Путь «взлом Станции»
> (MITM, свои сертификаты, ADB, root через дыру) — закрытый, отдельно не трогаем.
> Не ломать `192.168.88.207` (LiteLLM) и mini `.79`. Не удалять `/tmp/fw/out50`,
> `/tmp/fw/out332`, `/tmp/fw/_chains`, `~/lite-kit`.

Формат: **Факты** (твёрдые, проверенные) · **Открыто** (что не решено) · **ЖУРНАЛ** (что делали).
Процедура (воспроизведение root) — в [`how-to-root-midi.md`](how-to-root-midi.md).

---

## Факты

- Стенд `~/lite-kit` жив (launchd `system/ru.yaroslav.lite-kit`), слушает `:80/:443`, healthy;
  IP `192.168.88.23`. Подменяет `quasar.yandex.net`/`scbh.yandex.net`. Целевая прошивка — `.332`.
- **Цель midi `.32`:** MAC `b8:87:6e:57:9e:48`, платформа `yandexmidi`, `device_id=U008ZS200V1E1K`,
  hostname `Yandex-Station-gen2`, ядро `4.9.68 aarch64`, busybox (без `getprop`). IP плавал `.32→.20→.48`.
- **Симптом на `.32` (прошивка `.50`):** `HEAD /generate_204` (host `scbh.yandex.net`) по HTTP → 204,
  а на `quasar.yandex.net:443` — TLS Alert `15 03 03 00 02 02 30` (fatal `unknown_ca`). Устойчив,
  реконнект ~раз в 30 с. Ловится `tcpdump -i en0 -nn -X 'host 192.168.88.32 and tcp port 443'`.
- **Остров сертификатов** от листа `quasar.yandex.net` (единственно достижимое вверх):
  `leaf ← EM OV TLS CA - G3C ← { AAA Certificate Services | emSign Root TLS CA - G3 ← emSign ECC Root CA - G3 }`.
  Верхушки self-signed (AAA, emSign ECC Root CA - G3); кроссов к чему-либо ещё нет (BFS по ~6k
  CCADB-сертов + crt.sh: у AAA только 3 серта [self + AddTrust + Entrust], у emSign ECC Root CA - G3 — self).
- **Стор `.50`** (образ `yandexmidi 0.369.1.50…20261021.295`, 122 серта): DigiCert, GlobalSign R46/R3/R6,
  Sectigo, USERTrust, Amazon, GTS, ISRG, `YandexInternalRootCA`, `Russian Trusted Root CA`.
  **НЕТ** AAA, emSign ECC Root CA - G3, AddTrust, Entrust.
- **Стор `.332`** (образ `yandexmidi 0.332.1.0…20260123.258`, 139 сертов): есть AAA, emSign ECC Root CA - G3,
  AddTrust, Entrust, старый GlobalSign R1. `openssl verify leaf` против него = OK.
- **Ключ `G3C` = `d=4`** (ECDSA P-384; `ec.derive_private_key(4)` == SPKI `int.pem`). В
  `docs/firmware-key-hunt.md` было «d=1» — неверно.
- Приватного ключа листа `quasar.yandex.net` в прошивке нет; `~/lite-kit/certs/quasar-all.key` совпадает
  с публичным ключом РЕАЛЬНОГО живого листа (лист == live, sha256 `56:68:D2:97…`).
- Ни у одного корня стора `.50` нет малого `d` (EC-скан до N=300k); RSA-корни чётным Ферма не факторятся.
  ⇒ «свой корень» не подсунуть, нужна чужая подпись; генуинного пути лист→корни стора `.50` нет.
- **Живой `quasar.yandex.net` отдаёт ДВА чейна** (round-robin): (1) emSign `leaf ← G3C ← AAA`;
  (2) GlobalSign `leaf′ ← GlobalSign GCC R46 DV TLS CA 2025 ← GlobalSign Root R46`. GlobalSign-чейн
  валидируется о стор `.50` (`openssl verify … → OK`), emSign — нет; ключа `leaf′` нет,
  `gcd(n_leaf′, n_emLeaf)=1`.
- BFS лист→якоря стора `.50` по ~6k CCADB-сертов: пути нет (у G3C ровно два родителя — AAA и
  emSign Root TLS CA - G3, оба вне стора; кроссов к стор-корням нет).
- Первоисточники: `miilv/ya-station-root-shell`, `hu553in/yandex-station-root` (`issuer.pem` sha256
  `678b89db…`, `issuer.key` d=4 == `/tmp/fw/int.pem`), `derangedabbot` issue #3. Успех там — на сброшенной колонке.

## Как получен root на midi (Станция 2)

Воспроизводимый путь до `uid=0` на ВТОРОЙ колонке; пошаговая процедура и грабли —
в [`how-to-root-midi.md`](how-to-root-midi.md). Не путать с mini (`.79`, `yandexmini_2`) —
там [`how-we-took-over.md`](how-we-took-over.md). Схема: физический сброс → заводская →
подмена раздачи на `.332` → OTA → `get_sync_info` включает `adbd` → `:5555` → root.

**Идентификаторы цели:** платформа `yandexmidi`, `device_id=U008ZS200V1E1K`, MAC `b8:87:6e:57:9e:48`,
hostname `Yandex-Station-gen2`, IP плавал `.32→.20→.48` (ловить по MAC). Ядро `4.9.68 aarch64`,
шелл busybox (`getprop` отсутствует).

**Первопричина.** 30 сен 2026 Яндекс сменил сертификат `quasar.yandex.net` (crt.sh: `not_before
2026-09-30T13:35:59`, issuer `GlobalSign GCC R46 DV TLS CA 2025`; живой лист сейчас `eMudhra
EM OV TLS CA - G3C`, notBefore 2026-10-20). Наш стенд уводит колонку через emSign-чейн
`leaf ← G3C ← AAA`. Прошивка `.50` выкинула легаси-корень `AAA` из стора → наш чейн не валится в
корень → TLS Alert `15 03 03 00 02 02 30` (fatal `unknown_ca`) → колонка не доходит до sync.
Расследование (BFS, кроссы, `d=4`) — в «Фактах» выше.

**Почему помог сброс.** Сброс возвращает на ЗАВОДСКУЮ
`yandexmidi/0.8.1.56.1200464012.20220131.factory-4.factory`; в её сторе `AAA` ЕСТЬ → наш чейн
проходит TLS, колонка доходит до активации (по HTTP). Второго/recovery-стора и записей в `/data`
на ней нет — поэтому обратно на `.50` она сама не «перемыкается».

**Решение — отдать ей `.332`.** Заводская зовёт `get_sync_info` и `check_updates`; стенд отвечает
манифестом на `yandexmidi 0.332.1.0.3761320513.20260123.258` (в сторе `.332` тоже есть `AAA` +
`emSign ECC Root CA - G3`, `openssl verify leaf` = OK). Изоляция по платформе `yandexmidi` — mini
`.79` не задет. Правки стенда: `firmware/yandexmidi/manifest.json` (уже на `.332`), `firmware/manifest.json`
+ symlink и фолбэк `plat = plat or ota_platform()` в `check_updates`; тумблер `run/no_downgrade` сейчас выключен.

**Ход (по логу `/tmp/fw/watch.out`, 12:29):** цель на заводской → `POST /register` от `192.168.88.20`
→ 200 → `GET /check_updates?version=0.8.1.56…factory` → манифест на `.332` → `GET /yandexmidi/ota/<.332>.zip`
целиком (`89147392 б`, crc ок) → установка → ребут уже в `.332` (`/etc/os-release: BUILD_ID=3761320513`)
→ IP сменился на `.48` → `GET /get_sync_info` → стенд вписывает `adbd`
(`config.system_config.adbd=on`, `network=on`) → `:5555` открылся → `adb shell id` = `uid=0(root) gid=0(root)`.

**Закрепление и грабли.** noupdate, маркеры `/data/quasar/activate_adb_*` + `chattr +i`, `S98adbd`
(вотчдог + DoH-блок), патч `quasar.cfg`; устранённые блокеры — залипание `:443`, `--target`, `sed` по
`quasar.cfg`, `hybrid`, `chat_template_kwargs`. Полностью — в [`how-to-root-midi.md`](how-to-root-midi.md).
Проверено ребутом: root/adb и мост поднимаются сами, IP остаётся `.48`.

## Открыто / дальше

- ✅ ЗАКРЫТО: путь (б) доведён до конца — цель на `yandexmidi 0.332`, root получен (`uid=0`), `:5555`
  открыт. Стор `.332` содержит `AAA` → наш чейн `leaf→G3C→AAA` проходит TLS и на `.332`, и на
  заводской. Кросса AAA/emSignG3 к корням стора `.50` так и нет (путь (а) не нужен).
- ✅ ЗАКРЫТО: баг залипания `:443` (рукопожатие в главном потоке) — исправлен (`do_handshake_on_connect=False`
  + рукопожатие в `setup()`), регрессий нет.
- Дальше (не сделано, по желанию): 
  - закрепить в `~/lite-kit` «боевой» конфиг (раздача `.332` для `yandexmidi`, изоляция mini) — сейчас
    изменения не закоммичены;
  - при надобности — временная инъекция/устойчивость `adbd` (сейчас окно adb boot-only, ловить сразу);
  - решение владельца: оставить `.332` как целевую для `yandexmidi` или поднять что-то новее.
- `adb` не в PATH; нужный бинарь — `~/Library/Android/sdk/platform-tools/adb`. IP цели меняется
  (`.32` → `.20` → `.48`), ловить по MAC.
- ✅ ЗАКРЫТО: полное закрепление root (маркеры `chattr +i`, `S98adbd`, noupdate, DoH, патч `quasar.cfg`)
  и мост `quasar-bridge` (`.7.4`, голос `ermil`, uniproxy → `127.0.0.1:8443/uni.ws`) — проверено ребутом.
- ✅ ЗАКРЫТО: мост переведён на домашний LiteLLM (`http://192.168.88.207:4000/v1`, модель
  `vnc-cyber-deepseek-v4-1-flash-uncensored`, `reasoning_effort=none`) — сквозной ответ получен, выжило ребут.
  Альтернативы модели на выбор владельца: `vnc-cyber-qwen-3-6-plus` (своя), `op-gemini-3.8-flash` /
  `op-deepseek-v4.1-flash` (быстрые, сторонние); для более «умных» ответов — `reasoning_effort=low`.

## ЖУРНАЛ

- (2026-11-10) Подтверждён alert `unknown_ca` от `.32` сырым tcpdump'ом (SNI `quasar.yandex.net`).
- (2026-11-10) BFS по пулу сертов (CCADB all-intermediates 5519 + MEGA/S50X + локальные) —
  пути к корню `.50` нет. crt.sh: кроссов AAA (только AddTrust/Entrust) и emSign ECC Root CA - G3 (нет).
- (2026-11-10) Прогнаны через стенд чейны base/aaa/emsign/aaa+addtrust/aaa+entrust/aaa+utrsa/kitchen —
  все `unknown_ca`.
- (2026-11-10) Проверено: ключ G3C = d=4; у корней `.50` нет малого d (до 300k); RSA-корни Ферма не бьются.
- (2026-11-10) Обнаружено: живой `quasar.yandex.net` отдаёт ДВА разных чейна (emSign и GlobalSign).
  GlobalSign-чейн валиден о стор `.50`; emSign — нет. Таблично: `openssl verify` подтверждает
  `real1 ← GCC R46 DV ← GlobalSign Root R46 = OK`.
- (2026-11-10) BFS от листа к якорям стора `.50` по пулу ~6k сертов — пути нет; у G3C только AAA и
  emSign-TLS-G3 в родителях, оба вне стора. Значит без ключа `real1` GlobalSign-чейн не собрать.
- (2026-11-10) Стенд-тест: поставил чейны `leaf,G3C` / `+AAA` / `+AAA,AAA` / `G3C_em,emSignTLSG3,
  emSignECCG3`. `tcpdump` подтвердил alert `15 03 03 00 02 02 30` (unknown_ca) на всех. Вернул
  `fullchain.pem` к faithful-живому 4-серт. emSign-чейну (`leaf,G3C,AAA,AAA`; лист == live, ключ
  `quasar-all.key` совпадает). Стенд снова healthy.
- (2026-11-10) Сверил с апстримами: `int.pem` == `hu553in/…/certs/issuer.pem` (sha256 `678b89db…`),
  `issuer.key` = скаляр 4. Уточнено: у hu553in/derangedabbot успех — на сброшенной колонке.
- (2026-11-10) Путь (б): цель раздачи переведена на `yandexmidi 0.332` (образ в
  `~/lite-kit/firmware/yandexmidi/`, crc сверен). Manifest `firmware/yandexmidi/manifest.json` уже
  указывал на `.332`; `firmware/manifest.json` тоже переведён на `yandexmidi/.332` + symlink, чтобы
  работал и запрос без `platform`. В `check_updates` добавлен фолбэк `plat = plat or ota_platform()`.
  Проверено curl'ом: `platform=yandexmidi` (и без платформы) → манифест на `.332` + 206-раздача зипа;
  `yandexmini_2` → `hasUpdate:false` (не сломали). Бэкапы: `scripts/equasar_server.py.bak-ota-*`,
  `firmware/manifest.json.bak`.
- (2026-11-10) Наблюдение: цель `.32` по-прежнему даёт `unknown_ca` (tcpdump: `1503 0300 0202 30`) →
  она НЕ на заводской прошивке (иначе стор с AAA пропустил бы наш чейн). Нужен физический сброс →
  заводская (TLS ок) → оттуда `.332`. Запущены поллеры: `/tmp/fw/catchlock.py` (скан :5555),
  `/tmp/fw/watch.py` (→ `/tmp/fw/watch_live.log`).
- (2026-11-10) ПРИЧИНА сбоя активации после сброса: TLS-приёмник стенда (:443) залипал. `accept()`
  на обёрнутом слушающем сокете делал рукопожатие в ГЛАВНОМ потоке (ThreadingMixIn уводит в поток
  только обработку запроса, не хендшейк) → один клиент, открывший TCP и не приславший ClientHello,
  вешал ВЕСЬ :443. Итог: `curl -sk https://127.0.0.1/…` → мгновенный `000`/broken pipe; висело
  `192.168.88.23:443 → 192.168.88.11 (ESTABLISHED)` без записи в логе. Порт :80 жив → заводская
  колонка уходила в цикл `HTTP HEAD /generate_204` и не доходила до `register`/`check_updates` →
  приложение «начните настройку заново». Раздача `.332` при этом НЕ виновата (давала верный манифест).
- (2026-11-10) Фикс стенда: `wrap_socket(..., do_handshake_on_connect=False)` + рукопожатие в
  `EquasarHandler.setup()` (в потоке соединения, с таймаутом `LISTEN_HANDSHAKE_TIMEOUT=15`).
  Бэкап `scripts/equasar_server.py.bak-tlsfix-*`. Проверено: при залипшем клиенте `curl` мгновенный
  (0.01 c), HTTPS 200/0.05 c, манифест `.332` и zip (Range) отдаются. Не коммичено.
- (2026-11-10) Мелкий баг: `[REGISTER-DEBUG] не сохранил: FileNotFoundError` — писал в
  `/tmp/station/register_up.bin`, а каталога `/tmp/station` не было (на macOS `/tmp` чистится).
  Добавил `os.makedirs("/tmp/station", exist_ok=True)`. Бэкап `scripts/equasar_server.py.bak-regdir-*`.
- (2026-11-10) **ROOT ПОЛУЧЕН (подпись `cyber`).** Цель: Yandex Station 2 (`yandexmidi`),
  `device_id=U008ZS200V1E1K`, MAC `b8:87:6e:57:9e:48`, hostname `Yandex-Station-gen2`. Полный путь:
  физический сброс → заводская `0.8.1.56…factory` (на ней TLS к нашему чейну проходит) → `register`→200 →
  стенд отдал манифест на `.332` → цель скачала образ ПОЛНОСТЬЮ (`89147392 б`, crc ок) → установка →
  ребут уже в `.332` (на устройстве `/etc/os-release: BUILD_ID=3761320513` = `.332.1.0.3761320513…`).
  После ребута IP сменился `.32→.20→.48`; TLS на `.332` остался (стор с AAA). На `.48` открылся `:5555`
  (adbd, вписан стендом в `get_sync_info`): `adb connect 192.168.88.48:5555` → `adb shell id` =
  `uid=0(root) gid=0(root)`. Ядро `4.9.68 aarch64` (gcc 6.3.1, сборка 2026-01-23), шелл — busybox
  (`getprop` отсутствует). Не коммичено.
- (2026-11-10) **Полное закрепление root + мост (подпись `cyber`).** Прогнал `station-ready.sh`
  под цель по MAC (`--target b8:87:6e:57:9e:48 --platform yandexmidi`). Скрипт реально не парсил
  аргументы — добавил `--target MAC`/`--platform PLAT` (+env `TARGET_MAC`/`FORCED_PLATFORM`), фильтр
  клиентов `discover_column` по MAC, state `mac-<mac>`, `determine_platform` возвращает форс-платформу.
  Бэкапы `station-ready.sh.bak-target-*`.
- (2026-11-10) Применено на цели и подтверждено на устройстве: noupdate (OTA заблок.), маркеры
  `/data/quasar/activate_adb_*` + `chattr +i` (обе схемы имён), `S98adbd` в `/etc/init.d`, DoH-блок
  (4 правила REJECT). **Ребут — ВСЁ выжило**: маркеры `+i`, adb/root поднялись сами, IP остался `.48`.
- (2026-11-10) Баг шаблона: `patch-quasar-cfg-adbd.sh` ждал формат `"key":"val"`, а в `quasar.cfg`
  пробелы (`"allDeactivateCmd" : "…"`) → sed молча не срабатывал. Правка: `[[:space:]]*` вокруг `:`.
  Бэкап `patch-quasar-cfg-adbd.sh.bak-*`. После правки `grep -o /bin/true | wc -l` = 2.
- (2026-11-10) Баг шага 7: `runtime_env` писал `QUASAR_MODE="llm"`, а форк `quasar-bridge .7.4` принимает
  только `observe`/`hybrid` (`config.go: mode must be observe or hybrid`). Исправил на `hybrid`
  (`station-ready.sh`, бэкап `station-ready.sh.bak-mode-*`). Мост поставлен и `healthy`, autostart
  `/etc/init.d/S96quasar-bridge`, голос `ermil`, uniproxy → `ws://127.0.0.1:8443/uni.ws`.
- (2026-11-10) После ребута перепроверено: `uid=0(root)`, `cfg /bin/true`=2, `127.0.0.1:8443/uni.ws`=1,
  DoH REJECT=4, `S98adbd`+`S96quasar-bridge` на месте, `adbd` (pid) и мост healthy (pid) поднялись сами.
  `check_updates` для `yandexmidi .332` → `hasUpdate:false` (не уезжает на `.50`); mini `.79` не сломана
  (root жив, `hasUpdate:false`). Не коммичено.
- (2026-11-10) **Мост подключён к домашнему LiteLLM (подпись `cyber`).** Разобрал, как задаётся LLM:
  env-файл `/data/opt/quasar-bridge/runtime.env` (`QUASAR_MODE`/`QUASAR_LLM_BASE_URL`/`QUASAR_LLM_MODEL`/
  `QUASAR_LLM_API`/`QUASAR_LLM_API_KEY`), который `app/start.sh` сорсит (`set -a`) при старте; API —
  `chat_completions` (baseURL+`/chat/completions`, `Authorization: Bearer`). Бинарь принимает только
  `observe`/`hybrid`; правил env + `config.json` (не автозапуск).
- (2026-11-10) LiteLLM `.207:4000` читается по ключу (без ключа 401), `/v1/models` отдаёт 621 id.
  Выбрал `vnc-cyber-deepseek-v4-1-flash-uncensored` (своя, быстрая, uncensored). `runtime.env`:
  base `http://192.168.88.207:4000/v1` (LAN, без TLS-CA), model `vnc-cyber-deepseek-v4-1-flash-uncensored`,
  api `chat_completions`. Бэкап `runtime.env.bak-cyber`.
- (2026-11-10) Баг: `check-backends` → `LLM returned HTTP 400` — LiteLLM-роут не принимает
  `chat_template_kwargs` (мост шлёт его всегда). Нейтрализовал через `config.json`:
  `llm_chat_parameters={"chat_template_kwargs":null,"reasoning_effort":"none"}` (null удаляет ключ;
  `reasoning_effort=none` гасит thinking → 0.5s вместо 1.7s). Бэкап `config.json.bak-cyber`.
- (2026-11-10) Подтверждение сквозного отклика: `control.sh check-backends` → `LLM: ok`; движок
  `start.sh -query "…"` → `{"Route":"llm","Answer":"…"}` (ответ реальный); `/proc/net/tcp` на колонке —
  ESTABLISHED `192.168.88.48 → 192.168.88.207:4000` (мост держит соединения к LiteLLM). Ребут — мост
  поднялся сам на LiteLLM (`Bridge healthy`, `check-backends` ok). mini `.79` и `.207` не тронуты (только
  read/API). Не коммичено.
- (2026-11-10) **Фикс консольных ошибок гидратации на `/stations` (подпись `cyber`).** В
  `panel/components/stations/station-card.tsx` карточка была `<Link>` (→ `/stations/<id>`) и внутри
  ещё `<Link>` на `…/#adb` — вложенные `<a>`. React/Next ругались двумя ошибками на каждый рендер:
  `In HTML, <a> cannot be a descendant of <a>. This will cause a hydration error.` и
  `<a> cannot contain a nested <a>` (в оверлее — «1/2»). Вторая ошибка — та же причина.
- (2026-11-10) Починка: внешнюю обёртку карточки сделал `div` с `role="link"`, `tabIndex={0}`,
  `onClick`+`onKeyDown` (Enter/Space) → `router.push('/stations/<id>')`; внутреннюю оставил настоящим
  `<Link href="…/#adb" onClick={stopPropagation}>` (родительский переход не срабатывает). Стили и
  доступность сохранены (hover/focus-visible, cursor-pointer). Второй ошибки-источника больше нет.
- (2026-11-10) Подтверждение: dev-консоль `/stations` чистая — `nested <a>` в DOM = 0
  (`document.querySelectorAll('a a').length`), console.error нет (только React DevTools info);
  клик по карточке → `/stations/192.168.88.48-5555`, клик по ADB → `…-5555#adb`. Страница колонки
  `/stations/[id]` тоже без ошибок гидратации. Панель жива (`127.0.0.1:3000`), стенд/поллеры не тронуты.
  Не коммичено.
- (2026-11-10) (подпись `cyber`) В KB развёрнут отдельный раздел «Как получен root на midi (Станция 2)»
  (между «Фактами» и «Открыто») — воспроизводимый путь: сброс → заводская → раздача `.332` → OTA →
  `get_sync_info` → `:5555` → `uid=0`; первопричина (смена CA 30 сен 2026), устранённые блокеры, закрепление
  и команды воспроизведения. Сверено по `watch.out`/`equasar_server.py`/`station-ready.sh`/crt.sh. Не коммичено.
- (2026-11-10) **Панель: «AGENT_ADMIN_TOKEN не задан в .env панели» — агент снова виден (подпись `cyber`).**
  Причина: `panel/lib/agentApi.ts` (`agentConfigured()`) бьёт 503 и не ходит в `/admin/*`, пока пуст
  `process.env.AGENT_ADMIN_TOKEN` (`panel/lib/config.ts:83`); сам токен нигде не был задан — ни в
  `panel/.env`, ни в `/tmp/station-panel-dev.sh` (тот экспортит только `AGENT_SERVICE_URL`). Верное значение
  взял с `.207` (read-only ssh): `~/Documents/home/station-llm/agent-service/secrets/agent/mcp.env`
  (`AGENT_ADMIN_TOKEN`, 48 hex; agent-service читает его из env_file compose). Сверил: `curl -H "Authorization: Bearer <tok>" http://192.168.88.207:4100/admin/agents` → 200.
  Прописал в `panel/.env` (`AGENT_ADMIN_TOKEN` + `AGENT_SERVICE_URL=http://192.168.88.207:4100`), бэкап `.env.bak-<ts>`;
  перезапуск panel dev. Подтверждение: `GET /api/agents` → 200 c агентом `home`, `/agent` → 200. Стенд `~/lite-kit`
  и поллеры `/tmp/fw` не тронуты. Не коммичено.
- (2026-11-10) (подпись `cyber`) Документация KB разделена: «Факты» сжаты до сухих проверяемых фактов
  (идентификаторы, стор `.50`/`.332`, `unknown_ca`, остров сертов, `d=4`, два чейна, BFS, первоисточники);
  повествование (первопричина, почему сброс, почему `.332`) осталось в разделе «Как получен root на midi».
  Полная процедура (цель, предпосылки, действия сброс→заводская→`.332`→ребут→sync/adbd→`adb`, закрепление,
  грабли) вынесена в новый `docs/how-to-root-midi.md`; в KB — ссылка. Соответствие: KB = факты + журнал,
  how-to = процедура. Не коммичено.
- (2026-11-10) **Все колонки — в ОДНОГО агента; мост midi переведён с LiteLLM на агента (подпись `cyber`).**
  Уточнение владельца: есть один агент, и режим LLM/hybrid любой колонки всегда идёт в него (никаких «модель
  под колонку»). До правки у mini `.79` так уже было (`QUASAR_LLM_MODEL=agent:home`), а мост midi `.48` ошибочно
  бил ПРЯМО в LiteLLM (`:4000`) со своей моделью — исправлено.
  - **Где задаётся модель агента:** не в env, а в SQLite `agent-service/secrets/agent/agent.db`, таблица `agents`,
    колонка `model` (агент `home`, id=1). Правится через admin-API `PATCH /admin/agents/1 {"model":…}` (Bearer
    `AGENT_ADMIN_TOKEN` из `secrets/agent/mcp.env`). Агент отдаёт OpenAI-совместимый `POST /v1/chat/completions`
    (плюс `/v1/models`, `/health`), сам зовёт LiteLLM с промптом/tools. Модель агента поставлена `cx-gpt-6-luna`
    (была `op-glm-5.3-flash`), фолбэк `op-deepseek-v4.1-flash` оставлен. Бэкап `agent.db.bak-cyber-<ts>`.
  - **Мост midi:** в `runtime.env` base `…:4000/v1` → `http://192.168.88.207:4100/v1`, model → `agent:home`,
    ключ → ключ колонки. В агенте заведена станция `192.168.88.48-5555` (id 6), привязана к `home`, выпущен
    `sk-station-…`. Бэкап устройства `runtime.env.bak-cyber-<ts>`. `api=chat_completions` и нейтрализация
    `chat_template_kwargs` сохранены (для маршрута через агента доп. параметры всё равно отбрасываются).
  - **Дефолт `station-ready.sh`:** новые рутнутые колонки теперь идут в агента — `USE_AGENT=1`, `AGENT_SERVICE`/
    `AGENT_LAN_URL`/`AGENT_MODEL=agent:home`/`AGENT_ADMIN_TOKEN`, функция `agent_bind_station()` сама заводит
    станцию в агенте, привязывает к `home` и выпускает ключ. `USE_AGENT=0`/нет токена → фолбэк напрямую в LiteLLM.
    Бэкап `station-ready.sh.bak-agent-<ts>`.
  - **Доказательства сквозного маршрута колонка → агент → LiteLLM:** audit агента `agent.run` station_id=6
    (midi) и station_id=2 (mini), `slug=home`, `fallbackUsed=false`; на midi `/proc/net/tcp`/`netstat` —
    соединения `192.168.88.48 → 192.168.88.207:4100`; `check-backends` → `LLM: ok`; движок
    `start.sh -query` вернул реальные ответы в стиле агента (midi: «Пять, блин.»). Контейнер агента перезапущен
    (життер virtiofs: host-правка файла БД не была видна живому процессу), после ребута agent-service healthy.
  - mini `.79` и LiteLLM `.207:4000` не тронуты (кроме самого agent-service). Стенд `~/lite-kit`, поллеры
    `/tmp/fw` не тронуты. Панель и её `agent:home` у mini работают как раньше. Не коммичено.
