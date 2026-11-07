#!/bin/sh

. "`dirname $0 `/adb_options.inc" $*

if [ "$ARG_CMD" = "activate" ]; then
    if [ "$ARG_NETWORK" = "true" ]; then
        start-stop-daemon -S -b -x adbd
    else
        if [ -f "$MARKER_NETWORK" ]; then
            # deactivate network usb before activating on usb
            start-stop-daemon -K -b -x adbd
            rm "$MARKER_NETWORK"
        fi

        /usr/bin/adb.sh start
    fi
else
    /usr/bin/adb.sh stop
    start-stop-daemon -K -b -x adbd
fi
