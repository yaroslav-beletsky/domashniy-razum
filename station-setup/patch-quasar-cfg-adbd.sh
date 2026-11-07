#!/bin/sh
# patch-quasar-cfg-adbd.sh — слой 2 «неубиваемости ADB»: правим adbd-блок
# в /system/vendor/quasar/quasar.cfg так, чтобы команда deactivate стала no-op.
#
# Зачем:
#   Облачный конфиг Яндекса приходит без adbd. Тогда maind берёт из quasar.cfg
#   поля adbd.allDeactivateCmd / adbd.quasmodromDeactivateCmd и выполняет их.
#   Штатно там activate_adb.sh ... deactivate, который УДАЛЯЕТ маркеры
#   /data/quasar/activate_adb_*. Мы подменяем эти команды на /bin/true —
#   активация остаётся штатной, а деактивация ничего не снимает.
#   См. docs/how-we-took-over.md, раздел 5.
#
# Что именно делается в блоке "adbd":{...}:
#   allDeactivateCmd         := /bin/true
#   quasmodromDeactivateCmd  := /bin/true
#   quasmodromActivateCmd        (не трогаем)
#   quasmodromNetworkActivateCmd (не трогаем)
#
# Корень монтируется rw только на время правки, потом снова ro.
# Оригинал quasar.cfg сохраняется в /data/opt/backup/quasar.cfg.orig.
#
#   sh patch-quasar-cfg-adbd.sh          # применить
#   sh patch-quasar-cfg-adbd.sh status   # показать
#   sh patch-quasar-cfg-adbd.sh restore  # вернуть оригинал
set -u

Q=/system/vendor/quasar/quasar.cfg
BK=/data/opt/backup/quasar.cfg.orig

say() { echo "[*] $*"; }
err() { echo "[!] $*" >&2; }
need_root() { [ "$(id -u)" = 0 ] || { err "нужен root"; exit 1; }; }
rw() { mount -o remount,rw / 2>/dev/null || { err "remount rw / не удался"; exit 1; }; }
ro() { sync; mount -o remount,ro / 2>/dev/null; }

json_ok() {
	f="$1"
	[ -s "$f" ] || return 1
	a=$(tr -cd '{' <"$f" | wc -c); b=$(tr -cd '}' <"$f" | wc -c)
	c=$(tr -cd '[' <"$f" | wc -c); d=$(tr -cd ']' <"$f" | wc -c)
	[ "$a" = "$b" ] && [ "$c" = "$d" ] || return 1
	grep -q '"quasmodromActivateCmd"' "$f" || return 1
	return 0
}

ensure_true() {
	key=$1
	if grep -q "\"$key\"" "$Q"; then
		sed -i "s#\"$key\":\"[^\"]*\"#\"$key\":\"/bin/true\"#g" "$Q"
	else
		sed -i "s#\"adbd\":{#&\"$key\":\"/bin/true\",#" "$Q"
	fi
}

do_apply() {
	need_root
	[ -f "$Q" ] || { err "нет $Q"; exit 1; }
	rw
	if [ ! -s "$BK" ]; then
		cp -p "$Q" "$BK" || { err "не смог сохранить бэкап $BK"; ro; exit 1; }
		say "бэкап: $BK"
	fi
	ensure_true allDeactivateCmd
	ensure_true quasmodromDeactivateCmd
	if json_ok "$Q"; then
		say "quasar.cfg: adbd.deactivate -> /bin/true"
	else
		err "проверка не прошла, восстанавливаю из бэкапа"
		cp "$BK" "$Q"
	fi
	ro
	echo
	say "ГОТОВО. Нужен reboot (deactivate читается на старте демонов)."
}

do_status() {
	echo "== adbd-блок quasar.cfg =="
	grep -o '"adbd":{[^}]*}' "$Q" 2>/dev/null | tr ',' '\n' | grep -E 'DeactivateCmd|ActivateCmd' | sed 's/^/  /'
	echo "-- бэкап: $([ -s "$BK" ] && echo "$BK" || echo 'нет')"
}

do_restore() {
	need_root
	[ -s "$BK" ] || { err "нет бэкапа $BK"; exit 1; }
	rw
	cp "$BK" "$Q" && say "quasar.cfg восстановлен из бэкапа"
	ro
	say "ГОТОВО. Нужен reboot."
}

case "${1:-apply}" in
	apply)   do_apply ;;
	restore) do_restore ;;
	status)  do_status ;;
	*) echo "usage: $0 {apply|status|restore}"; exit 1 ;;
esac
