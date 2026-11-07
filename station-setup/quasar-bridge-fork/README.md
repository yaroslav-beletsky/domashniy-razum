# quasar-bridge fork: смена голоса ответа (`TtsGenerate.Voice`)

Эксперимент 2026-11-07. **Результат: работает. Мужской голос `ermil` включён на .79 и подтверждён на слух.**
Мастер панели ставит именно этот форк-бандл (`dist/`) и сам кладёт `tts.override` с голосом
`WIZARD_BRIDGE_VOICE` (по умолчанию `ermil`); ставить оригинал или удалять `tts.override` вручную —
только при откате на апстрим (голос вернётся к женскому).

## Источник
- Upstream: https://github.com/skrashevich/quasar-bridge, тег `v0.7.4`, коммит `ddedcb6499418213a3962ac39dd561204ba9b7fe`
  (на .79 была `0.7.4`, оригинальный бинарь sha256 `62fb45ffd3f92fda…`).
- `src/` — исходники без `.git` и `dist` (патч уже внутри). Модуль требует Go 1.27.3 (go сам скачает toolchain).
- `tts-voice.patch` — единый diff от чистого `v0.7.4` (5 файлов, в том числе новые `tts_probe.go`, `tts_style.go`), `git apply --check` проходит, результат побайтно равен `src/`.

## Что делает патч
- `internal/bridge/native.go`
  - `newTtsGenerate(text)`: как раньше `Lang=ru-RU`, `Format=audio/opus`; голос берётся из `QUASAR_TTS_VOICE` (если задан).
  - `tts.override` в рабочем каталоге моста (`/data/opt/quasar-bridge/tts.override`), строки `key=value`: `voice`, `emotion`, `quality`, `speed`, `lang`.
    Читается на КАЖДЫЙ запрос озвучки, рестарт моста не нужен. Приоритет выше окружения. Нет файла и нет переменной = поведение upstream.
  - лог `tts_generate_sent` (voice/emotion/quality/speed/lang/format/text_len, текста реплики нет).
  - проба голосов: строка `probe=voice[@emotion],…` в `tts.override` (до 12 кандидатов, не чаще раза в 20 с). После настоящей озвучки мост шлёт серверу
    пробные `TtsGenerate` с текстом «а», аудио проб глушит. Результат в `service.log`: `tts_probe_sent` + `EventException`/`TtsSpeak` с тем же `ref`.
- `cmd/quasar-bridge/main.go`: в лог пишется текст `EventException` (`exception`, до 400 символов) и `ref`; для `TtsSpeak` пишется `ref`.
- `internal/bridge/tts_voice_test.go`: тесты (`TestNewTtsGenerateVoice`, `TestTtsOverride`, `TestReadProbeList`).

## Что показал сервер Яндекса
Текст исключения: `directive exception: scope=TTS_DISPENSER code=tts_backend_error text=…/dispenser/utils/utils.cpp:950: Unsupported voice '<id>'`.
Сервер читает поле `Voice`, а `filipp` и `alena` отвергает просто как неизвестные ему id. Механизм рабочий, дело было в значении.

Пробы (изолированно, в одном живом запросе, параллельно с обычным ответом):

| Значение | Ответ сервера |
|---|---|
| `ermil` | принят (`TtsSpeak`), на слух мужской голос |
| `zahar` | принят |
| `shitova` | принят |
| `oksana` | принят |
| `omazh` | принят |
| `jane` | принят |
| `ermil@good` (Emotion=good) | принят |
| `@good` (только Emotion, без Voice) | принят |
| `filipp` | `Unsupported voice 'filipp'` |
| `alena` | `Unsupported voice 'alena'` |
| `madirus` | `Unsupported voice 'madirus'` |
| `levitan` | ответа нет (ни `TtsSpeak`, ни ошибки) — не определено |

Принят сервером не значит «услышано»: на слух проверен только `ermil` (мужской). `zahar` (тоже мужской в SpeechKit) принят, но не слушали.

## Выразительная озвучка (стенд проб, 2026-11-07)
Стенд `tts.cases`: положить в рабочий каталог моста файл `tts.cases` (по JSON-объекту на строку: `id`, `text`, `voice`, `emotion`, `quality`, `speed`, `volume`,
`format`, `lang`, `tag`, `dump`). Мост сам забирает файл (переименует в `tts.cases.taken`), шлёт `TtsGenerate`, глушит звук и пишет в `service.log`
строку `tts_case_result` (`outcome`, `exception`, `audio_bytes`, `first_ms`, `total_ms`). С `format=audio/x-pcm;bit=16;rate=16000` длительность = bytes/32000 с;
`"dump":true` кладёт PCM в `tts-dump/<id>.pcm` (потом ffmpeg → wav → ASR). Лимит: 40 строк и 64 КБ на файл. После проб удалить `tts-dump/` и `tts.cases*`.

Что принимает синтез (голос `ermil`, ни один кейс не дал `EventException`):

| Пометка | Результат |
|---|---|
| SSML: `<speak>`, `<break>`, `<prosody>`, `<emphasis>`, `<say-as>`, `<sub>`, `<phoneme>`, `<voice>`, неизвестный тег, незакрытый тег | **не поддерживается**, теги читаются вслух («меньше чем спик больше чем…») |
| `<p><s>…</s></p>` | текст пропадает целиком (аудио 0.1 с) |
| `<break/>` без `<speak>` | читается как «BreakTime 1С» |
| `sil<[800]>` | **работает**: тишина ≈ 920 мс, тег не читается |
| `sil<800>` (без скобок) | читается вслух («сил, 800») |
| `з+амок` (плюс перед гласной) | принимается, аудио отличается от `замок`; ASR разницы не видит, на слух не проверено |
| `ё` | различается («Всё» / «Все») |
| `...` | паузы ≈ 300 мс на многоточие, `\n\n` ≈ 800 мс, тире ≈ 350 мс |
| markdown (`**`, `_`, `` ` ``, ссылки) | вырезается/съедается, текст местами пропадает |
| `&`, `<`, `>` в обычном тексте | читаются как слова, исключений нет |

Поля `TtsGenerate`:

| Поле | Результат |
|---|---|
| `Speed` | **работает**, монотонно: 0.5 → 9.3 с, 0.7 → 6.7, 1.0 → 4.6, 1.3 → 3.6, 1.5 → 3.1, 2.0 → 2.3, 3.0 → 1.6 (фраза одна и та же) |
| `Volume` | принимается, **громкость не меняется** (RMS и длительность те же; `0` = как не задано). Громкость колонки задаётся самой колонкой |
| `Quality` | принимается любое значение, аудио побитово равно базовому: **игнорируется** |
| `Emotion` | принимается любое значение, включая `zzz` (ошибки нет). Аудио отличается от базы, повтор одного значения даёт то же аудио. Высота тона (F0) измерением не различается. **Эффект подтверждается только на слух**; значения `neutral`/`good`/`evil` — по документации Яндекса |
| `Format` | `opus`, `pcm`, `wav`, `mp3` принимаются; `wav`/`mp3` фактически отдают тот же поток, что `opus` |

### Управление из моста
- Глобально: `tts.override` (`emotion=`, `speed=`, `volume=`, `quality=`, `voice=`, `lang=`), читается на каждый ответ, рестарт не нужен.
- Per-response (`tts_style.go`): ответ агента может начинаться с тега `[tts emotion=good speed=1.15]`. Мост вырезает его до показа в панели и до озвучки и
  применяет значения только к этому ответу (поверх `tts.override`). `emotion` — `neutral|good|evil`, `speed` ограничен 0.6..1.6, `volume` — 0.3..2.0. Тег не в начале текста не трогается.
- Подготовка текста (`cleanSpeech`, только для озвучки; текст в панели не меняется): `<break time="500ms"/>` → `sil<[500]>`, `sil<800>` → `sil<[800]>`,
  остальные XML-теги и markdown вырезаются. `з+амок` и `sil<[мс]>` остаются как есть.
- Лог `tts_generate_sent` теперь включает `volume` и `styled`.

### Рекомендация
LLM пишет обычный короткий текст с пунктуацией (запятые, тире, `...`, абзацы — они реально дают паузы), без SSML и markdown. Нужна особая пауза — `sil<[300]>`; ударение — `+` только для
слов, которые модель точно путает. Стиль ответа (эмоция, темп) — необязательный тег `[tts …]` в начале, но в промпте агента его пока не включали (промпт `home` не менялся).
Длинные ответы режутся на стороне агента (`max_tokens`, около 600 символов), для голоса держать 1–3 предложения.

## Сборка
`./build.sh` — тесты, `go vet`, затем штатный упаковщик апстрима (`CGO_ENABLED=0 GOOS=linux GOARCH=arm64`, UPX `-6`, встроенный PCM-плеер).
Нужны `go`, `python3`, `upx`. Результат: `dist/quasar-bridge-arm64` (текущий sha256 `bf727a3e19e03b6a…`; предыдущие форки: v2 `a1322635…`, v3 `144e33ff…`, ELF aarch64, 8.2 МБ) и
`dist/quasar-bridge-linux-arm64.tar.gz` (+ `.sha256`, текущий sha256 `62138673c903b501…` — именно его сверяет мастер при установке; проверено 2026-11-07: пины совпадают с файлами в `dist/`).
Простой `go build` без упаковщика даёт бинарь без PCM-плеера (19 МБ) — на колонку не годится.

## Состояние на .79
- Бинарь: форк (`bf727a3e19e03b6a…`; откат на предыдущий — `backup-voice/quasar-bridge.fork-v3`, `…fork-v2-ermil`), в `/data/opt/quasar-bridge/tts.override` одна строка `voice=ermil`. `runtime.env` и `config.json` не менялись
  (sha `5719d46d…` и `4361e08e…`). Режим LLM, привязка к агенту `home` без изменений. Сверка пинов с `dist/` по adb — 2026-11-07, совпадает.
- Сменить голос: `echo 'voice=zahar' > /data/opt/quasar-bridge/tts.override` (chmod 600). Рестарт не нужен, подхватится на следующем ответе.
- Вернуть женский голос по умолчанию: `rm /data/opt/quasar-bridge/tts.override`.
- Перебрать новые значения: добавить строку `probe=a,b,c@emotion`, сказать колонке любую фразу, смотреть `grep -E 'tts_probe_sent|Unsupported voice|TtsSpeak' service.log`.
  Строку `probe=` после проб убрать (пробы нужны только для диагностики).

## Установка и откат на колонке
Бэкап оригинала: `/data/opt/quasar-bridge/backup-voice/` (`quasar-bridge.orig` с битом 755, `config.json.orig`, `runtime.env.orig`).
1. `control.sh stop`; положить бинарь в `app/bin/quasar-bridge` и сделать `chmod 755` (без него `Permission denied`); `control.sh check`; `control.sh start`; `control.sh status`.
2. Откат на оригинал: `stop`, `cp -p backup-voice/quasar-bridge.orig app/bin/quasar-bridge`, `chmod 755`, `rm tts.override`, `check`, `start`.
   sha после отката: бинарь `62fb45ff…`, config `4361e08e…`, runtime.env `5719d46d…`.

## Риски
- Это не штатная возможность: Яндекс может отключить выбор голоса. Если сервер начнёт отвечать `Unsupported voice` на `ermil`, колонка снова будет «висеть в загрузке» —
  тогда `rm tts.override` (рестарт не нужен) вернёт женский голос.
- Форк надо пересобирать вручную при выходе новой версии upstream (патч небольшой, `tts-voice.patch`).
