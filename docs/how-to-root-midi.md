# Как получить root на midi (Yandex Station 2) — пошагово

Воспроизводимая процедура до `uid=0(root)` на ВТОРОЙ колонке (платформа `yandexmidi`).
Факты и журнал — в [`KB.md`](KB.md); тут только процедура. Общая методичка по mini
(`.79`, платформа `yandexmini_2`) — в [`how-we-took-over.md`](how-we-took-over.md).

Идентификаторы цели: `device_id=U008ZS200V1E1K`, MAC `b8:87:6e:57:9e:48`,
hostname `Yandex-Station-gen2`, ядро `4.9.68 aarch64`, шелл busybox (без `getprop`).
IP плавает (`.32→.20→.48`) — **ловить по MAC, не по IP**.

---

## 1. Цель

Отдать midi прошивку `yandexmidi 0.332.1.0.3761320513.20260123.258` (вместо стоявшей `.50`),
включить через стенд сетевой `adbd` и получить root. Схема:

```
физический сброс → заводская прошивка → подмена раздачи на .332 → OTA-ребут →
get_sync_info (стенд вписывает adbd) → :5555 → uid=0
```

## 2. Предпосылки (почему именно так)

- **Ротация CA.** 30 сен 2026 Яндекс сменил сертификат `quasar.yandex.net`
  (`not_before 2026-09-30T13:35:59`; живой лист сейчас — `eMudhra EM OV TLS CA - G3C`,
  notBefore 2026-10-20). Наш стенд уводит колонку emSign-чейном `leaf ← G3C ← AAA`.
  Прошивка `.50` выкинула легаси-корень `AAA` из стора → наш чейн не валится в корень →
  TLS Alert `15 03 03 00 02 02 30` (fatal `unknown_ca`) → до sync не доходит.
- **Почему сброс.** Сброс возвращает на ЗАВОДСКУЮ `yandexmidi/0.8.1.56…factory-4.factory`;
  в её сторе `AAA` ЕСТЬ → наш чейн проходит TLS, колонка доходит до активации (по HTTP).
  Второго/recovery-стора и записей в `/data` нет → сама на `.50` не «перемыкается».
- **Почему `.332`, а не `.50` или новее.** В сторе `.332` тоже есть `AAA` +
  `emSign ECC Root CA - G3` (`openssl verify leaf` = OK), версия современная и зовёт
  `get_sync_info`. Стор `.50` — современный (DigiCert/GlobalSign/…), но без `AAA`.
- **Изоляция.** Раздача выбирается по платформе `yandexmidi` — mini `.79` не задет.

## 3. Предустановка (стенд `~/lite-kit`)

- Стенд поднят на `192.168.88.23` (`equasar_server.py`, `:80/:443`, launchd).
- DNS `quasar.yandex.net`, `quasar.yandex.ru`, `scbh.yandex.net` → стенд (или форвард роутера).
- Раздача `~/lite-kit/firmware/yandexmidi/manifest.json` → `.332`; фолбэк `firmware/manifest.json`
  на `yandexmidi/.332` + symlink (для запроса без `platform`); фолбэк
  `plat = plat or ota_platform()` в `check_updates`. Тумблер `run/no_downgrade` — выключен.
- **TLS-приёмник стенда не должен делать рукопожатие в главном потоке** (иначе один клиент
  без ClientHello вешает весь `:443`): `wrap_socket(..., do_handshake_on_connect=False)` +
  рукопожатие в `EquasarHandler.setup()` с таймаутом.
- `adb` не в PATH: `ADB=~/Library/Android/sdk/platform-tools/adb`.

## 4. Действия

```bash
# (a) физический сброс колонки -> заводская прошивка
#     сброс очищает /data; второго стора нет

# (b) дать Wi-Fi в приложении вендора -> колонка стартует заводскую, идёт регистрация
#     стенд отвечает: POST /register -> 200
#     -> GET /check_updates?version=0.8.1.56…factory -> манифест на .332
#     -> GET /yandexmidi/ota/<.332>.zip целиком (89147392 б, crc ок) -> установка

# (c) ребут уже в .332; IP меняется (.32 -> .20 -> .48), ловить по MAC
#     /etc/os-release: BUILD_ID=3761320513

# (d) стенд вписывает adbd в ответ на GET /get_sync_info
#     (config.system_config.adbd=on, network=on) -> на колонке открывается :5555

# (e) забираем root
ADB=~/Library/Android/sdk/platform-tools/adb
$ADB connect 192.168.88.48:5555
$ADB -s 192.168.88.48:5555 shell id        # uid=0(root) gid=0(root)
```

Прогнать закрепление (см. §5) можно сразу: `./station-ready.sh --target b8:87:6e:57:9e:48
--platform yandexmidi` (после сброса и выдачи Wi-Fi; шаги 0–4 требует живого стенда).

Проверить раздачу стенда:

```bash
curl -sk "https://quasar.yandex.net/check_updates?platform=yandexmidi&device_id=X" | head -c 300
```

## 5. Закрепление (переживает ребут)

Все слои ставит `station-ready.sh` (шаг 6), затем проверяет ребутом:

1. **noupdate** — `yandex-noupdate.sh` (OTA заблокирована).
2. **Маркеры ADB** — `touch /data/quasar/activate_adb_quasmodrom`, `activate_network_adb`
   (обе схемы имён) + `chattr +i`.
3. **Вотчдог** — `/etc/init.d/S98adbd`: блок DoH (4 × `iptables REJECT`), `touch` маркеров,
   автозапуск `adbd`, если не запущен.
4. **Патч `quasar.cfg`** — `patch-quasar-cfg-adbd.sh` (deactivate → `/bin/true`, 2 вхождения).
5. (Опц.) мост `quasar-bridge .7.4`, голос `ermil`, uniproxy → `127.0.0.1:8443/uni.ws`
   (autostart `/etc/init.d/S96quasar-bridge`).

## 6. Грабли (уже наступили — не повторять)

- **Залипание `:443` стенда.** `accept()` на обёрнутом сокете делал рукопожатие в ГЛАВНОМ потоке
  (ThreadingMixIn уводит в поток только обработку запроса, не хендшейк). Один клиент, открывший TCP
  без ClientHello, вешал весь `:443`; `:80` жил → заводская уходила в цикл `HTTP HEAD /generate_204`
  и не доходила до `register`. Фикс — см. §3 (бэкап `equasar_server.py.bak-tlsfix-*`).
- **`station-ready.sh` не парсил аргументы.** Добавлены `--target MAC`/`--platform PLAT`
  (env `TARGET_MAC`/`FORCED_PLATFORM`), фильтр `discover_column` по MAC, state `mac-<mac>`.
- **`sed` по `quasar.cfg`.** Скрипт ждал `"key":"val"`, а в файле пробелы (`"k" : "v"`) — sed молча
  не срабатывал. Правка: `[[:space:]]*` вокруг `:`.
- **`QUASAR_MODE`.** Шаг 7 писал `"llm"`, а бинарь моста `.7.4` принимает только `observe`/`hybrid`
  (`config.go: mode must be observe or hybrid`). Исправлено на `hybrid`.
- **`chat_template_kwargs`.** LiteLLM-роут отдавал `HTTP 400` (мост шлёт ключ всегда). Нейтрализовано
  в `config.json`: `llm_chat_parameters={"chat_template_kwargs":null,"reasoning_effort":"none"}`.
- **`/tmp/station`.** На macOS `/tmp` чистится — `os.makedirs(..., exist_ok=True)` перед записью
  `register_up.bin`.

## 7. Проверка / откат

- Проверка после ребута: `uid=0(root)`, `quasar.cfg /bin/true`=2, `127.0.0.1:8443/uni.ws`=1,
  DoH REJECT=4, `S98adbd`+`S96quasar-bridge` на месте, `adbd`/мост поднялись сами, IP `.48`.
- Откат: сброс колонки к заводским стирает `/data` (мост, маркеры, патчи уходят); после сброса
  процедуру можно прогнать заново.
