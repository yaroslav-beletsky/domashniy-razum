# station-setup — как воспроизвести наш захват колонки

Артефакты, которыми на станции (Yandex Mini 2, `192.168.88.79`) сделан
«неубиваемый» сетевой ADB/root, блокировка обновлений и мост `quasar-bridge`.
Полный разбор «почему» — в [`../docs/how-we-took-over.md`](../docs/how-we-took-over.md).

Порядок применения при воспроизведении:

1. Поднять стенд `lite-kit` (DNS + HTTPS на `192.168.88.23`) и отдать откатную
   прошивку `.46` — см. `~/lite-kit` на `.23` (это отдельный репозиторий, здесь не копируем;
   живёт как LaunchDaemon `ru.yaroslav.lite-kit`, поднимается сам после ребута).
2. Сбросить колонку, дождаться OTA на `.46` и появления `adb connect <ip>:5555`.
3. `yandex-noupdate.sh` — выключить обновления (пока ADB жив).
4. Слой защиты ADB: `chattr +i` на маркеры + `patch-quasar-cfg-adbd.sh`.
5. `S98adbd` — автозапуск `adbd`, `touch` маркеров и блок DoH.
6. `S96quasar-bridge` + мост `quasar-bridge` (форк со сменой голоса, `tts.override` → `voice=ermil`) — голос в LiteLLM.

## Что за файлы

| Файл | Что это | Откуда |
|---|---|---|
| `yandex-noupdate.sh` | блокировка OTA: чужой ключ `ota_script.pub`, заглушка `device_ota_update.sh`, вырезание `updatesd` из `launch.json`. Есть `status`/`restore`. | репозиторий `Marker284/yandex-station-extended`, `contrib/yandex-noupdate.sh` (копия 1:1) |
| `S98adbd` | наш init-хук: блок DoH (iptables), `touch` маркеров, запуск `adbd`. | снят со станции, `/etc/init.d/S98adbd` |
| `S96quasar-bridge` | init-хук автозапуска моста. | снят со станции, `/etc/init.d/S96quasar-bridge` |
| `doh-block.sh` | те же 4 правила REJECT, что в `S98adbd`, отдельным скриптом (`on`/`off`/`status`). | наш |
| `patch-quasar-cfg-adbd.sh` | правит `quasar.cfg`: `adbd.allDeactivateCmd` и `quasmodromDeactivateCmd` → `/bin/true`. Ремонтирует `/` в rw на время, бэкап в `/data/opt/backup`. | наш |
| `markers-adb.md` | разбор механизма маркеров `/data/quasar/activate_adb_*` и `quasar_adb.log`. | наш разбор со станции |
| `activate_adb.sh` | вендорный скрипт активации ADB — справочно, на станцию не копируется. | снят со станции, `/system/vendor/quasar/activate_adb.sh` |
| `adb_options.inc` | вендорный include с путями маркеров и журналом — справочно. | снят со станции, `/system/vendor/quasar/adb_options.inc` |
| `quasar-bridge-fork/` | наш форк моста со сменой голоса ответа (`tts.override`, `voice=…`): исходники, `tts-voice.patch`, `build.sh`, готовый `dist/`. Мастер панели ставит именно его. | форк апстрима `v0.7.4`, см. `quasar-bridge-fork/README.md` |

## Чего здесь нет (соседние репозитории)

- **Стенд `lite-kit`** (dnsmasq + `equasar_server.py` + серты eMudhra + откатная
  прошивка) — `~/lite-kit` на `.23` (LaunchDaemon `ru.yaroslav.lite-kit` в
  `/Library/LaunchDaemons`). Ставит DNS-подмену `quasar.yandex.net` и
  отдаёт в `/get_sync_info` конфиг с `adbd.remoteActivation=true`.
- **`quasar-bridge`** — Go-мост от `skrashevich`; `S96quasar-bridge` запускает его `app/control.sh start`.
  Он же (`control.sh apply`) переводит `quasar.cfg` uProxy на `ws://127.0.0.1:8443/uni.ws`.
  Ставит его мастер панели (`panel/`), источник — **наш форк** `quasar-bridge-fork/dist/` (со сменой
  голоса: `voice=ermil` в `/data/opt/quasar-bridge/tts.override`, читается на каждый ответ; откат
  голоса — `rm tts.override`). Форк-бандла нет — мастер качает апстрим-релиз с GitHub (женский голос);
  откат на апстрим — вернуть оригинальный бинарь в `app/bin/quasar-bridge`.
- **`yandex-noupdate.sh`** взят из `yandex-station-extended` целиком; апстрим может
  отличаться — сверяйте, если у вас свежий клон.

## Как применять скрипты из этой папки

Скрипты кладутся на станцию через `adb push` и запускаются `sh` от root.
Секретов внутри нет (ключ LiteLLM для бриджа живёт в `/data/opt/quasar-bridge/runtime.env`).

```sh
adb connect 192.168.88.79:5555
adb push station-setup/yandex-noupdate.sh    /data/opt/yandex-noupdate.sh
adb push station-setup/patch-quasar-cfg-adbd.sh /data/opt/patch-quasar-cfg-adbd.sh
adb shell sh /data/opt/yandex-noupdate.sh
adb shell sh /data/opt/patch-quasar-cfg-adbd.sh
# S98adbd ставится в /etc/init.d, dropbear/SSH — опционально (см. upstream ssh.md)
```

## Проверка после перезагрузки

```sh
adb connect 192.168.88.79:5555 && adb -s 192.168.88.79:5555 shell id   # uid=0(root)
adb shell lsattr /data/quasar/activate_adb_quasmodrom                  # должен быть флаг i
adb shell iptables -C OUTPUT -d 1.1.1.1 -j REJECT                      # rc=0
adb shell sh /data/opt/yandex-noupdate.sh status                       # updatesd убран, ключ подменён
```

## Откат

- обновления: `sh /data/opt/yandex-noupdate.sh restore`
- патч `quasar.cfg`: `sh /data/opt/patch-quasar-cfg-adbd.sh restore`
- снять маркеры: `chattr -i ...` и удалить файлы
- `S98adbd`: удалить/переименовать файл в `/etc/init.d`

Направление деградации: сначала возвращаем настоящий DNS (убираем стенд) — колонка
всё равно остаётся с ADB, потому что уже стоит `yandex-noupdate` и защита маркеров.
