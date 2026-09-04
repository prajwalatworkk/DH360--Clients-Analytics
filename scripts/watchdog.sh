#!/bin/bash
# Keeps the dashboard actually reachable from the phone.
#
# Two things have repeatedly gone down on their own in practice:
#   1. Tailscale drops to "Stopped" (its GUI app isn't running, so nothing
#      reconnects it), which silently cuts phone access even though the
#      server is fine.
#   2. The launchd job for the server crash-loops itself into a permanent
#      backoff and stays dead.
#
# Neither announces itself — the app just appears offline. This checks both
# every few minutes and repairs whichever is broken.

LOG="$HOME/Desktop/ClientReports/logs/watchdog.log"
SERVICE="com.digitalhub360.clientreports3"
TAILSCALE="/usr/local/bin/tailscale"
mkdir -p "$(dirname "$LOG")"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S')  $*" >> "$LOG"; }

# --- 1. Tailscale up? ---------------------------------------------------
if [ -x "$TAILSCALE" ]; then
  if ! "$TAILSCALE" status >/dev/null 2>&1; then
    log "tailscale down — running 'tailscale up'"
    "$TAILSCALE" up >>"$LOG" 2>&1 && log "tailscale recovered" || log "tailscale up FAILED"
  fi
fi

# --- 2. Dashboard responding? -------------------------------------------
# A 200 or a 302 (redirect to /login) both mean the server is alive and serving.
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 http://localhost:4321/login 2>/dev/null)
if [ "$CODE" != "200" ] && [ "$CODE" != "302" ]; then
  log "dashboard not responding (got '$CODE') — kickstarting $SERVICE"
  # kickstart is the supervised restart; never kill the process directly, as
  # that races launchd's own KeepAlive and is what caused the original
  # crash-loop-into-permanent-backoff.
  launchctl kickstart -k "gui/$(id -u)/$SERVICE" >>"$LOG" 2>&1
  sleep 5
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 http://localhost:4321/login 2>/dev/null)
  log "after kickstart: '$CODE'"
fi

# Keep the log from growing without bound.
if [ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -gt 500 ]; then
  tail -200 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
