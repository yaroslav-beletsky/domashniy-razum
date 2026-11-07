# Заметки: маркеры ADB и журнал quasar_adb.log

Всё, что ниже, — факт со станции (Yandex Mini 2, `yandexmini_2`), а не догадка.
Снято из `/system/vendor/quasar/activate_adb.sh` и `/system/vendor/quasar/adb_options.inc`.

## Как прошивка поднимает ADB

Прошивка не запускает `adbd` безусловно. Цепочка:

1. `init` → `/etc/init.d/rcS` → `S99quasar` → `/system/vendor/quasar/onboot.sh start`.
2. В `onboot.sh` есть строка `/system/vendor/quasar/activate_adb.sh check`.
3. `activate_adb.sh` подключает `adb_options.inc`, который задаёт пути маркеров
   и при команде `check` смотрит: есть ли хотя бы один маркер активации.
4. Если маркер есть — выполняется активация: `touch` сетевого маркера и
   `start-stop-daemon -S -b -x adbd` (для `--network`) либо `/usr/bin/adb.sh start`.
5. `adbd` слушает TCP **5555** и работает от root (`adb shell id` → `uid=0`).

Маркеры (жёстко зашиты в `adb_options.inc`):

| Переменная | Путь | Смысл |
|---|---|---|
| `MARKER_QUASMODROM` | `/data/quasar/activate_adb_quasmodrom` | «включить ADB по конфигу» |
| `MARKER_NETWORK` | `/data/quasar/activate_network_adb` | «ADB по сети, а не по USB» |
| `MARKER_SOUND` | `/data/quasar/activate_adb_sound` | активация звуковой командой |
| `MARKER_GLAGOL` | `/data/quasar/activate_adb_glagol` | активация через glagol |

Нам нужны первые два. Именно их мы и `touch`-им.

## Журнал

`adb_options.inc` пишет в `ADB_LOG=/data/quasar/quasar_adb.log` строки вида
`<дата>: Activate adb by quasmodrom config`. При размере > 2048 байт файл
ротируется в `quasar_adb.log.1`.

Это удобный индикатор: наличие строк «Activate adb by quasmodrom config» и
«Set network flag for adb» означает, что колонка сама поднимала ADB. Строки
«Deactivate adb …» / «Reset network flag …» — что кто-то дёрнул deactivate.

## Почему маркеры надо защищать

Штатный `deactivate` (его вызывает прошивка, когда облако присылает конфиг без
`adbd`) делает `rm` этих файлов. Тогда при следующей загрузке `check` не находит
маркеров и `adbd` не стартует — ADB пропадает после перезагрузки.

Защита — двумя способами сразу (см. `../docs/how-we-took-over.md`, раздел 5):

1. `chattr +i` на оба файла — их нельзя удалить/перезаписать. Проверка:
   `lsattr /data/quasar/activate_adb_quasmodrom /data/quasar/activate_network_adb`
   должна показать флаг `i` (на нашей станции: `-----i---c---`).
2. Патч `quasar.cfg` — команды deactivate не выполняются вообще
   (`patch-quasar-cfg-adbd.sh`).

## Как поставить/снять вручную

```sh
# поставить и защитить
mkdir -p /data/quasar
touch /data/quasar/activate_adb_quasmodrom /data/quasar/activate_network_adb
chattr +i /data/quasar/activate_adb_quasmodrom /data/quasar/activate_network_adb

# поднять сразу, без перезагрузки
/system/vendor/quasar/activate_adb.sh --quasmodrom activate --network

# снять защиту (перед удалением)
chattr -i /data/quasar/activate_adb_quasmodrom /data/quasar/activate_network_adb
```

## Подводные камни

- На **других** моделях и на части factory-сборок маркеры лежат **без вложенной папки**:
  `/data/quasar_activate_adb_*` (через подчёркивание). Для Mini 2 — только
  `/data/quasar/activate_adb_*`, как выше.
- `onboot.sh` на Mini 2 в конце чистит «остатки старого формата»:
  `rm -f /data/quasar_activate_adb_*`. То есть подсовывать ему файлы через подчёркивание
  бесполезно.
- `chattr` есть в busybox этой прошивки; но если его нет — остаётся только слой с
  `quasar.cfg`.
- Не держите порты 5555/2222 открытыми наружу: вход без пароля/по root.
