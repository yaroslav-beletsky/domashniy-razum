#!/usr/bin/env bash
# Диагностика listen_after_reply на колонке со quasar-bridge (запускать с Mac, когда колонка online).
#
#   diag-listen-after-reply.sh discover            # только чтение: help моста, control.sh, структура config.json
#   diag-listen-after-reply.sh scenario [--yes] [--wait SEC]
#                                                  # listen_after_reply=true на 1–2 диалога, снимок лога, откат
#   diag-listen-after-reply.sh restore [DIR]       # вернуть config.json из снимка (если сценарий оборвался)
#   diag-listen-after-reply.sh all                 # discover, затем scenario
#
# Переменные: DEV (192.168.88.79:5555), ADB (по умолчанию adb из PATH), OUT (каталог результатов).
#
# Безопасность:
#  - discover ничего не пишет на колонку (только cat/ls/grep/-h);
#  - scenario меняет ТОЛЬКО listen_after_reply в config.json (JSON-merge, остальное как есть);
#    перед правкой снимок config.json кладётся локально в $OUT/<ts>/config.json.orig и на колонку
#    (config.json.bak-listen-diag); откат — через trap на выход/Ctrl-C/ошибку, затем check + restart;
#  - runtime.env не трогается; режим не переключается (нужен уже Гибрид/LLM);
#  - в выводе секреты скрыты: значения ключей с key/token/secret/password/auth/dsn и sk-…/Bearer… в логе.
# Сценарий дважды перезапускает мост (~15 с каждый раз): не запускать, пока колонку держит другой агент/панель.
set -uo pipefail

DEV="${DEV:-192.168.88.79:5555}"
ADB="${ADB:-$(command -v adb || echo /opt/homebrew/bin/adb)}"
STATE="/data/opt/quasar-bridge"
APP="$STATE/app"
CFG="$STATE/config.json"
LOG="$STATE/service.log"
TS="$(date +%Y%m%d-%H%M%S)"
OUT_BASE="${OUT:-/private/var/folders/5p/xnv75cx97zg27qywn9wl2p200000gn/T/opencode/diag-listen}"
RUN="$OUT_BASE/$TS"

die() { echo "ERROR: $*" >&2; exit 1; }
say() { printf '\n== %s\n' "$*"; }
a() { "$ADB" -s "$DEV" "$@"; }

# Ограничение по времени для зависших команд (на macOS нет timeout).
run_to() {
  local secs="$1"; shift
  "$@" & local pid=$!
  ( sleep "$secs"; kill "$pid" 2>/dev/null ) & local w=$!
  wait "$pid" 2>/dev/null; local rc=$?
  kill "$w" 2>/dev/null; wait "$w" 2>/dev/null
  return $rc
}

# Скрытие секретов в тексте (логи, help).
redact() {
  perl -pe '
    s/sk-[A-Za-z0-9_-]{6,}/sk-<hidden>/g;
    s/\b(Bearer)\s+[A-Za-z0-9._~+\/=-]{8,}/$1 <hidden>/gi;
    s/((?:api[_-]?key|token|secret|password|authorization)["\x27]?\s*[:=]\s*["\x27]?)[^"\x27\s,}]+/$1<hidden>/gi;
  '
}

connect() {
  [ -x "$ADB" ] || die "нет adb: $ADB"
  say "adb connect $DEV"
  run_to 10 "$ADB" connect "$DEV" || true
  local st; st="$(run_to 10 "$ADB" -s "$DEV" get-state 2>&1 || true)"
  [ "$st" = "device" ] || die "колонка недоступна по adb (get-state: ${st:-пусто}). Остановка без изменений."
  echo "ok: device"
}

mkdir -p "$RUN" 2>/dev/null || die "не могу создать $RUN"
chmod 700 "$RUN" 2>/dev/null || true

# ---------- обработка config.json: структура без секретов ----------
read -r -d '' DUMP_PY <<'PY' || true
import json, re, sys
SECRET = re.compile(r"key|token|secret|passw|auth|dsn|credential", re.I)
NEIGH = re.compile(r"listen|reply|continu|follow|stick|session|ttl|timeout|route|routing|mode|dialog|wake|mic|native|yandex|llm", re.I)
raw = sys.stdin.read()
try:
    cfg = json.loads(raw)
except Exception as e:
    print("config.json не JSON:", e); sys.exit(1)

def red(o, k=""):
    if isinstance(o, dict):
        return {kk: red(v, kk) for kk, v in o.items()}
    if isinstance(o, list):
        return [red(v, k) for v in o]
    if SECRET.search(k) and o not in (None, "", False, True):
        return "<hidden>"
    if isinstance(o, str) and re.search(r"sk-[A-Za-z0-9_-]{6,}|Bearer\s+\S{8,}", o):
        return "<hidden>"
    return o

c = red(cfg)
print("-- ключи верхнего уровня")
for k, v in c.items():
    if isinstance(v, dict):   desc = f"object({len(v)}): {', '.join(list(v)[:12])}"
    elif isinstance(v, list): desc = f"array({len(v)})"
    else:                     desc = json.dumps(v, ensure_ascii=False)
    print(f"  {k}: {desc[:200]}")

print("\n-- listen_after_reply")
print("  ", json.dumps(c.get("listen_after_reply", "<ключа нет>"), ensure_ascii=False))

print("\n-- routing (целиком)")
print(json.dumps(c.get("routing", "<блока нет>"), ensure_ascii=False, indent=2))

print("\n-- соседние ключи (по имени: listen/reply/continue/follow/sticky/session/ttl/timeout/route/mode/dialog/wake/native…), любой глубины")
def walk(o, path=""):
    if isinstance(o, dict):
        for k, v in o.items():
            p = f"{path}.{k}" if path else k
            if NEIGH.search(k) and not (p.startswith("routing.rules") ):
                if isinstance(v, (dict, list)):
                    print(f"  {p}: {type(v).__name__}({len(v)})")
                else:
                    print(f"  {p} = {json.dumps(v, ensure_ascii=False)[:160]}")
            if p != "routing.rules":
                walk(v, p)
walk(c)
PY
dump_cfg() { python3 -c "$DUMP_PY"; } # stdin: config.json

# ---------- 1–2. discover ----------
discover() {
  connect
  local f="$RUN/discover.txt"
  {
    say "устройство"
    run_to 10 a shell 'uname -a; date' 2>&1

    say "каталог моста ($STATE)"
    run_to 10 a shell "ls -la $STATE $APP 2>&1" 2>&1

    say "бинарь моста"
    local bins; bins="$(run_to 10 a shell "find $STATE -maxdepth 3 -type f \\( -name 'quasar-bridge*' -o -name 'bridge*' \\) 2>/dev/null" 2>&1 | tr -d '\r')"
    echo "${bins:-<не найден>}"
    local bin; bin="$(echo "$bins" | grep -E 'quasar-bridge$' | head -1)"
    [ -z "$bin" ] && bin="$(echo "$bins" | head -1)"
    echo "выбран: ${bin:-<нет>}"

    if [ -n "$bin" ]; then
      say "$bin -h"
      run_to 10 a shell "$bin -h </dev/null 2>&1 | head -150" 2>&1 | redact
      say "$bin --help (если отличается)"
      run_to 10 a shell "$bin --help </dev/null 2>&1 | head -150" 2>&1 | redact

      say "строки бинаря про continue/follow-up/sticky/listen/native_route/reply (имена ключей и логов)"
      run_to 30 a shell "grep -a -o -E '[A-Za-z_.-]{0,40}(listen|continu|follow|sticky|native_route|reply|dialog|session)[A-Za-z_.-]{0,40}' $bin 2>/dev/null | sort -u | head -150" 2>&1
    fi

    say "control.sh без аргументов"
    run_to 15 a shell "sh $APP/control.sh </dev/null 2>&1 | head -60" 2>&1 | redact

    say "control.sh: текст скрипта (первые 150 строк, секреты скрыты)"
    run_to 10 a shell "sed -n 1,150p $APP/control.sh 2>&1" 2>&1 | redact

    say "control.sh status"
    run_to 15 a shell "sh $APP/control.sh status 2>&1" 2>&1 | redact

    say "runtime.env: только имена переменных"
    run_to 10 a shell "sed -E 's/=.*//' $STATE/runtime.env 2>&1" 2>&1

    say "QUASAR_MODE из runtime.env"
    run_to 10 a shell "grep -E '^QUASAR_MODE=' $STATE/runtime.env 2>&1" 2>&1

    say "config.json: структура"
    run_to 15 a shell "cat $CFG" 2>/dev/null | tr -d '\r' | dump_cfg

    say "probe -route (маршрутизация фразы без колонки; read-only)"
    if [ -n "$bin" ]; then
      for ph in "Алиса, какая погода" "расскажи анекдот"; do
        echo "-- '$ph'"
        run_to 15 a shell "cd $STATE && sh $APP/start.sh -route '$ph' </dev/null 2>&1 | head -20" 2>&1 | redact
      done
    fi

    say "хвост service.log (40 строк, секреты скрыты)"
    run_to 10 a shell "tail -n 40 $LOG 2>&1" 2>&1 | redact
  } 2>&1 | tee "$f"
  echo; echo "Сохранено: $f"
}

# ---------- 3. scenario ----------
PID_BEFORE=""
restart_and_wait() {
  local old; old="$(a shell "sh $APP/control.sh status 2>&1" 2>/dev/null | grep -oE 'PID [0-9]+' | head -1 | grep -oE '[0-9]+')"
  say "control.sh check"
  local chk; chk="$(run_to 20 a shell "sh $APP/control.sh check 2>&1" 2>&1)"
  echo "$chk" | redact | tail -3
  echo "$chk" | grep -qi 'configuration is valid' || { echo "check не прошёл" >&2; return 1; }
  say "control.sh restart"
  local r; r="$(run_to 60 a shell "sh $APP/control.sh restart 2>&1" 2>&1)"
  echo "$r" | redact | tail -3
  echo "$r" | grep -qiE 'did not become ready|fail|configuration rejected|"level":"ERROR"' && { echo "restart сообщил об ошибке" >&2; return 1; }
  local i pid
  for i in $(seq 1 30); do
    pid="$(a shell "sh $APP/control.sh status 2>&1" 2>/dev/null | grep -oE 'PID [0-9]+' | head -1 | grep -oE '[0-9]+')"
    if [ -n "$pid" ] && [ "$pid" != "$old" ]; then echo "мост поднялся: PID $pid (был ${old:-?})"; return 0; fi
    sleep 1
  done
  echo "мост не показал новый PID за 30 с" >&2; return 1
}

push_cfg() { # $1 локальный файл
  a push "$1" "$CFG" >/dev/null 2>&1 || return 1
  a shell "chmod 600 $CFG" >/dev/null 2>&1 || true
}

RESTORE_FILE=""
ROLLED=0
rollback() {
  [ "$ROLLED" = 1 ] && return 0
  [ -n "$RESTORE_FILE" ] && [ -f "$RESTORE_FILE" ] || return 0
  ROLLED=1
  say "ОТКАТ: возвращаем исходный config.json"
  if push_cfg "$RESTORE_FILE"; then
    restart_and_wait && echo "откат выполнен" || echo "ВНИМАНИЕ: config.json возвращён, но мост не подтвердил рестарт — проверьте вручную (снимок: $RESTORE_FILE)" >&2
  else
    echo "ВНИМАНИЕ: не удалось запушить снимок. Вручную: adb -s $DEV push $RESTORE_FILE $CFG && sh $APP/control.sh restart" >&2
  fi
}

scenario() {
  local yes=0 wait_s=0
  while [ $# -gt 0 ]; do
    case "$1" in --yes) yes=1;; --wait) wait_s="${2:-0}"; shift;; esac; shift
  done
  connect

  say "снимок config.json"
  local orig="$RUN/config.json.orig"
  run_to 15 a shell "cat $CFG" 2>/dev/null | tr -d '\r' > "$orig"
  [ -s "$orig" ] || die "config.json пуст/не прочитан"
  python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$orig" || die "config.json не JSON — не трогаю"
  chmod 600 "$orig"
  a shell "cp $CFG $CFG.bak-listen-diag && chmod 600 $CFG.bak-listen-diag" >/dev/null 2>&1 \
    && echo "копия на колонке: $CFG.bak-listen-diag" || echo "(копию на колонке сделать не удалось — остаётся локальная)"
  echo "локально: $orig"
  RESTORE_FILE="$orig"
  trap 'rollback' EXIT
  trap 'echo; echo "прервано"; exit 130' INT TERM

  local mode lar
  mode="$(a shell "grep -E '^QUASAR_MODE=' $STATE/runtime.env 2>/dev/null" | tr -d "\r\"'"'' | sed 's/^QUASAR_MODE=//' | tail -1)"
  lar="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("listen_after_reply","<нет>"))' "$orig")"
  echo "режим моста: ${mode:-?}; listen_after_reply сейчас: $lar"
  [ "$mode" = "hybrid" ] || { RESTORE_FILE=""; die "нужен Гибрид или LLM (mode=hybrid в runtime.env), сейчас '${mode:-?}'. Переключите режим в панели и повторите. Ничего не менялось."; }

  if [ "$yes" != 1 ]; then
    echo; echo "Сценарий: listen_after_reply=true → check → restart (~15 с) → ваши 1–2 диалога → откат → restart."
    read -r -p "Продолжить? [y/N] " ans; [ "$ans" = "y" ] || { echo "отмена"; RESTORE_FILE=""; exit 0; }
  fi

  say "включаем listen_after_reply=true (JSON-merge, остальное без изменений)"
  local mod="$RUN/config.json.test"
  python3 - "$orig" "$mod" <<'PY' || die "не удалось собрать config.json"
import json, sys
c = json.load(open(sys.argv[1])); c["listen_after_reply"] = True
json.dump(c, open(sys.argv[2], "w"), ensure_ascii=False, indent=2)
PY
  chmod 600 "$mod"
  push_cfg "$mod" || die "adb push не удался (откат сработает через trap)"
  restart_and_wait || die "мост не поднялся с новым конфигом (откат сработает через trap)"

  local off; off="$(a shell "wc -c < $LOG" | tr -d '\r[:space:]')"
  [ -n "$off" ] || off=0
  echo "лог: смещение $off байт"

  say "ТЕПЕРЬ ГОВОРИТЕ с колонкой"
  cat <<'TXT'
  Диалог 1: «Алиса, расскажи анекдот» (ответит модель) → дождитесь, пока микрофон откроется сам
            → без слова-активатора задайте продолжение, например «а ещё один».
  Диалог 2 (по желанию): то же с другой фразой.
  Если микрофон после ответа не открылся — это тоже результат.
TXT
  if [ "$wait_s" -gt 0 ]; then
    echo "жду $wait_s с…"; sleep "$wait_s"
  else
    read -r -p "Когда закончили, нажмите Enter… " _
  fi

  say "снимаем лог"
  local raw="$RUN/service.log.slice"
  a shell "tail -c +$((off + 1)) $LOG" 2>/dev/null | tr -d '\r' | redact > "$raw"
  local sel="$RUN/continue-lines.txt"
  grep -aiE 'native_route|route=|routing|decision|listen|continue|follow|sticky|reopen|mic|session|stt|llm' "$raw" > "$sel" || true
  echo "полный срез:  $raw ($(wc -l < "$raw") строк)"
  echo "выборка:      $sel ($(wc -l < "$sel") строк)"
  echo; echo "---- выборка (до 120 строк) ----"; head -120 "$sel"

  say "сводка"
  local dec yan
  dec="$(grep -aci 'native_route_decision' "$raw" || true)"
  yan="$(grep -aE 'native_route' "$raw" | grep -aci 'route=yandex' || true)"
  echo "native_route_decision: $dec"
  echo "native_route route=yandex: $yan"
  echo "native_route ... sent=true без decision рядом — признак продолжения, ушедшего в Яндекс мимо routing:"
  grep -aE 'native_route' "$raw" | grep -a 'sent=true' | head -10 || true

  rollback
  trap - EXIT
  echo; echo "Результаты: $RUN"
}

restore_cmd() {
  local d="${1:-}"
  [ -n "$d" ] || d="$(ls -dt "$OUT_BASE"/*/ 2>/dev/null | head -1)"
  [ -f "${d%/}/config.json.orig" ] || die "нет снимка в '${d:-$OUT_BASE}' — укажите каталог: restore <DIR>"
  RESTORE_FILE="${d%/}/config.json.orig"
  connect
  echo "снимок: $RESTORE_FILE"
  rollback
}

case "${1:-}" in
  discover) discover ;;
  scenario) shift; scenario "$@" ;;
  restore)  shift; restore_cmd "${1:-}" ;;
  all)      discover; shift; scenario "$@" ;;
  *) sed -n 2,13p "$0"; exit 2 ;;
esac
