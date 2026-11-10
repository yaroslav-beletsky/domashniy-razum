#!/bin/sh
# adbd-watchdog.sh — держит сетевой adbd (TCP :5555) живым между перезагрузками колонки.
# Зачем: S98adbd отрабатывает только один раз на загрузке. Если adbd позже прибьёт maind
# (deactivate adb) или он упадёт — до следующего ребута колонка пропадает из панели (offline).
# Этот сторож запускается из S98adbd в фоне и поднимает adbd обратно.
# Идемпотентен: повторный запуск выходит по pidfile. Порт: проверяем LISTEN на :5555.
# station-llm / cyber.
PIDF=/var/run/adbd-watchdog.pid
LOG=/data/opt/adbd-watchdog.log

# уже крутится?
if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF" 2>/dev/null)" 2>/dev/null; then
	exit 0
fi
echo $$ > "$PIDF"

# ротация лога
if [ -f "$LOG" ]; then
	sz=$(wc -c < "$LOG" 2>/dev/null || echo 0)
	[ "${sz:-0}" -gt 65536 ] && mv -f "$LOG" "$LOG.1"
fi

listening() { netstat -ltn 2>/dev/null | grep -q ':5555 '; }
markers() { touch /data/quasar/activate_network_adb /data/quasar/activate_adb_quasmodrom 2>/dev/null; }

markers
while true; do
	if ! pidof adbd >/dev/null 2>&1 || ! listening; then
		echo "$(date '+%Y-%m-%d %H:%M:%S'): adbd=off или :5555 не слушает (pidof=$(pidof adbd 2>/dev/null)) — перезапуск" >> "$LOG"
		killall adbd 2>/dev/null
		sleep 1
		markers
		/usr/bin/adbd &
	fi
	sleep 15
done
