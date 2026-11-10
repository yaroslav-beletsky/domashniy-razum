# Штатные рычаги Яндекс Станции (Mini 2, .79) — разведка ЭТАП 1

Цель: вытащить родные функции колонки (громкость, BT, Wi-Fi, эквалайзер, подсветка, ночной/детский
режим, будильники) на нашу панель, как в приложении вендора. Здесь — только разведка точных
команд чтения/записи и рисков. Прод не деплоился.

## 1. Что это за устройство и почему так

- `yandex-mini2`, hostname `yandex-mini2-0E8K`, прошивка `0.369.1.46.4778262943…`, Buildroot 2020.02.1, root (uid=0),
  доступ `adb -s 192.168.88.79:5555`.
- Это **не Android CLI**: нет `getprop`/`settings`/`dumpsys`/`iw`. Есть busybox/uClibc, ALSA (`amixer`/`alsamixer`),
  bluez+dbus, sysfs для LED, wpa_supplicant.
- Пользовательский слой — стек **quasar**: `/system/vendor/quasar/{quasar_launcher2,maind,launch.json}`;
  `maind` — мультиколл-бинарь (процессы `--telemetry`, `--fluent-bitd`, `--platformd`, `--mediad`).
  Наши действия идут **в обход** IPC-дэмонов quasar — прямо по sysfs/ALSA/bluez/wpa. Плюс: не нужен их
  сложный протокол. Минус: `maind` может перезатирать наше состояние (см. риски).

## 2. Разделение функций

- **(а) безопасно / применяется сразу** — ALSA-громкость, эквалайзер, BT on/off и имя, LED-кольцо (sysfs).
- **(б) требует разрыва/рестарта** — ночной (DND) и детский режим, standby, имя устройства: живут в
  `user_config.dat`, меняются правкой файла + перезапуск пользовательского слоя.
- **(в) вендор-cloud / только через их IPC** — будильники, интеграция сопряжения BT-телефонов,
  часть «капабилити» (`SetNightMode`, `SetBrightnessLevel`, `AlarmAdd`), голос/сценарии.

## 3. Таблица рычагов

Риск: 🟢 низкий · 🟡 средний (может отвалиться/перезатереться) · 🔴 высокий.

| Функция | Как читать | Как менять | Класс | Риск | Проверено |
|---|---|---|---|---|---|
| Громкость | `amixer sget Master` → `Front Left: Playback NN [PP%]` | `amixer set Master PP%` (или `amixer sset Master 0-255`) | а | 🟡 `maind`/volume_manager может переустановить; `last_vendor_volume` — отдельный источник | да (туда-обратно) |
| Mute | `cat /data/quasar/data/is_speaker_muted` (0/1) + `amixer sget 'SPK mute'` | записать `0` в `Master` + `echo 1 > is_speaker_muted`; наоборот — вернуть из `last_vendor_volume` | а | 🟡 штатный путь mute не подтверждён; два источника правды; `SPK mute` через amixer «не липнет» | частично |
| Эквалайзер (SPK EQ) | `amixer sget 'SPK EQ'` → `Mono: Playback [on/off]` | `amixer sset 'SPK EQ' on|off` | а | 🟢 держится, слушается | да (туда-обратно) |
| BT питание | `bluetoothctl show` → `Powered: yes/no` | `bluetoothctl power on|off` | а | 🟢 детерминированно (через dbus) | да (туда-обратно) |
| BT имя станции | `bluetoothctl show` → `Alias:` | `bluetoothctl system-alias "…"` | а | 🟡 меняет только BT-имя; отображаемое в приложении имя — в `user_config.dat` | да (туда-обратно) |
| BT устройства | `bluetoothctl devices` / `bluetoothctl info <mac>` | `bluetoothctl connect/disconnect/pair` | а | 🟡 сопряжение зависит от агента bluez (`just-works-bluez-agent`) | нет |
| LED-кольцо (яркость) | `cat /sys/class/leds/mini2:{red,green,blue}:ring{1..6}/brightness` (18 шт, 0–255) | `echo N > …/brightness`; хелперы `led_ring_on <pct>` / `led_ring_off` (скрипт `mini2_test`) | а | 🔴 `maind` (`BrightnessLedFrameBuffer`) перерисует кольцо при анимации/активации; наша картинка живёт до следующего взаимодействия | да (держится во время простоя) |
| Wi-Fi (статус/скан) | `wpa_cli -i wlan0 status`, `wpa_cli -i wlan0 scan_results` | смена сети: `wpa_cli add_network/set_network/enable_network/save_config` | а (чтение) / 🔴 запись | 🔴 смена сети на лету может отвалить колонку от Wi-Fi | чтение да |
| Ночной режим (DND) | `user_config.dat` → `device_config.dndMode` | правка `user_config.dat` + рестарт слоя | б | 🟡/🔴 файл = protobuf-конверт (см. §5), формат надо пересобирать | нет |
| Детский режим | `user_config.dat` → `account_config.childContentAccess` (`children`) | правка `user_config.dat` + рестарт | б | 🟡 как DND | нет |
| Имя устройства / standby | `user_config.dat` → `device_config.name`, `standby` | правка `user_config.dat` + рестарт | б | 🟡 | нет |
| Будильники | каталог `/data/quasar/data/kids_alarms/` (пока пуст) | локального тула нет → через cloud/их IPC | в | 🟡 | нет |
| Часы/подсветка времени | `user_config.dat` → `led.time_visualization` | правка `user_config.dat` + рестарт | б/в | 🟡 на этой ревизии белых clock-LED в sysfs **нет** | нет |

## 4. Что реально проверено живьём (туда-обратно, с откатом)

Все тесты возвращены в исходное состояние: громкость 55% (`Front Left: Playback 141`), BT alias
«Станция - Детская», ring-LED = 0, EQ = on, `is_speaker_muted` = 0.

1. **Громкость** — `amixer set Master 30%` → `55%`; держится ≥20 с, откат на 55%.
2. **Эквалайзер** — `amixer sset 'SPK EQ' off` → `on`, читается обратно из amixer.
3. **BT питание** — `bluetoothctl power off` → `Powered: no` → `power on` → `Powered: yes`.
4. **BT имя** — `bluetoothctl system-alias 'TEST-STATION'` → вернул «Станция - Детская».
5. **LED ring** — `echo 120 > …:blue/green/red:ring1/brightness` → читается 120 через 3 с → откат на 0.
6. **Wi-Fi чтение** — `wpa_cli -i wlan0 status` (ssid `WiFi-Beletsky-3|9`, ip `.79`) и `scan_results`.

Итого ≥3 функции прогнаны туда-обратно (громкость, BT-питание, BT-имя, EQ, LED) — с восстановлением.

## 5. Важная находка: `user_config.dat` — не JSON

Сырой вид: `0a 88 51 | 0a 09 "250486135" | 12 f6 50 | { json … }`.

Это **protobuf-конверт**: field1 (tag `0a`) — строка-идентификатор, field2 (tag `12`) — JSON настроек строкой.
Правка «в лоб» JSON'ом не пройдёт — надо пересобрать конверт (пересчитать varint-длины). Внутри ключевые
поля приложения: `device_config.{name, dndMode, led.time_visualization, standby}`, `account_config.{childContentAccess, …}`.

Локальные IPC-дэмоны quasar слушают множество `127.0.0.1`-портов (9877, 9909, 9922, 9910, 9911 и др.),
но на пробу `HTTP GET /` и на пустую строку **не ответили** — протокол не HTTP/JSON. `maind --cli` и
`--getprop` есть, но в PATH `maind` не лежит (полный путь `/system/vendor/quasar/maind`).

## 6. Предлагаемая схема (ЭТАП 2)

**API** — новый `panel/lib/stationControl.ts` поверх `adbExec`, и роут `panel/app/api/stations/[id]/control/route.ts`:

- `GET` → snapshot: `{ volume, muted, eq, bt:{powered, alias, devices}, led:{r,g,b}, wifi:{ssid, ip, state} }`
  (каждое поле мягко: недоступное → `null` + `error`).
- `POST` `{ action, … }`, действия: `volume.set(N)`, `volume.mute|unmute`, `eq.set(bool)`,
  `bluetooth.power(bool)`, `bluetooth.alias(string)`, `led.set({r,g,b})`, `led.on|off`.
- Чтение-запись разнести: `wifi`/`alarms` пока read-only.

**UI** — новый компонент `panel/components/stations/controls.tsx` (по образцу `voice-picker.tsx`:
GET на маунте + POST-действия, мобильные таргеты ≥44px), вставка в `app/stations/[id]/page.tsx`
под `VoicePicker`. Блоки: «Звук» (слайдер+мьют, EQ-тумблер), «Bluetooth» (switch + alias-input),
«Подсветка» (RGB), read-only «Wi-Fi»/«Будильники».

## 7. Спорные места / что подтвердить до кода

1. **Mute** — нет единого штатного рычага; предлагается `Master=0` + файл-флаг. При этом `maind` может
   вернуть громкость — нужен опыт: удержит ли состояние.
2. **Перезапись LED `maind`'ом** — в простое держится, но при активации/ответе слой перерисует кольцо.
3. **DND/детский/имя через `user_config.dat`** — надо подтвердить, что правка + рестарт слоя реально
   применяются (и какой именно рестарт достаточен), и отладить protobuf-конверт.
4. **IPC-порты quasar** — если вскроем протокол, часть функций (будильники, night) получится без правки файлов.
5. **Смена Wi-Fi** — на лету рискованно: гарантии автовосстановления нет.

## 8. Статус

- Файлы/код панели не менялись; git не трогали; прод (`192.168.88.207:3110`) **не пересобирался**.
- Для ЭТАП 2 нужен деплой панели. Готовые контролы к бою (а): громкость, EQ, BT on/off+имя, LED.
