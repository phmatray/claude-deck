#!/bin/sh
# Is the deck's control channel healthy? Forces one profile switch (via claude-ask,
# 2 s timeout) and fails if the Stream Deck app logs a device command failure after it.
# A desynced deck times out every SetBacklight (5 s each) → every page switch lags ~6 s,
# and the app reads the serial number where the firmware version should be.
# Fix when red: unplug the deck ≥15 s, replug. Run: sh scripts/check-deck-link.sh
LOG="$HOME/Library/Logs/ElgatoStreamDeck/StreamDeck.log"
ASK="$(ls "$HOME"/.claude/plugins/cache/phmatray/claude-deck/*/bin/claude-ask 2>/dev/null | tail -1)"
[ -x "$ASK" ] || { echo "claude-ask not installed"; exit 2; }
T=$(date +%Y-%m-%dT%H:%M:%S)
printf '%s' '{"header":"Probe","question":"probe","timeout":2,"context":"probe","options":["-"]}' | "$ASK" >/dev/null 2>&1
sleep 12
FAILS=$(awk -v s="$T" '$1>=s && /DeviceComm/ && / err /' "$LOG")
grep -h "firmware version" "$LOG" | tail -1 | grep -o "firmware version: [^,]*"
if [ -z "$FAILS" ]; then echo "GREEN: page switch at $T, no device command failure"; exit 0; fi
printf '%s\n' "$FAILS" | awk '{t=substr($1,12,12); $1=$2=$3=""; print t, $0}'
echo "RED: device command failures after page switch at $T — unplug the deck 15 s and replug"
exit 1
