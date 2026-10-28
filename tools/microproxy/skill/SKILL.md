---
name: microproxy
description: Turn the local *.localhost proxy (microproxy, also called devproxy) on or off, restart it, and show its status, routes or log. Use for "/microproxy on|off|restart|status|list|log", "enciende/apaga el proxy", "reinicia el proxy", "pepe.localhost no funciona", "is the proxy running?".
argument-hint: "[on | off | restart | status | list | log]"
version: 1.1.0
license: MIT
---

# microproxy

The proxy that serves `<folder>.localhost` for any dev server started on this Mac. It runs as the
user LaunchAgent `com.devproxy.proxy` (shown as "microproxy" in Login Items), on ports 80 (HTTP)
and 53 (DNS for `*.localhost`), no root. Files live in `~/.config/devproxy/`.

## Commands

Run the one matching the argument with Bash and reply with its output only — no commentary.
No argument means `status`.

```bash
# port 53 — before on and restart: remove the old dnsmasq service and the root LaunchDaemon,
# which hold DNS. Only when one exists; asks for the admin password in a macOS dialog.
if brew services list 2>/dev/null | grep -q '^dnsmasq .*started' || [ -f /Library/LaunchDaemons/com.devproxy.proxy.plist ]; then
  osascript -e "do shell script \"$(brew --prefix)/bin/brew services stop dnsmasq 2>/dev/null || true; rm -f /Library/LaunchDaemons/com.devproxy.proxy.plist\" with administrator privileges"
fi

# on — start it now and at every login
launchctl enable gui/$(id -u)/com.devproxy.proxy
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.devproxy.proxy.plist 2>/dev/null
launchctl kickstart -k gui/$(id -u)/com.devproxy.proxy && echo "microproxy: on"

# off — stop it now and keep it off at login (until "on")
launchctl bootout gui/$(id -u)/com.devproxy.proxy 2>/dev/null
launchctl disable gui/$(id -u)/com.devproxy.proxy && echo "microproxy: off"

# restart — after updating proxy.js, or when it stops answering (port-53 block above runs first)
launchctl kickstart -k gui/$(id -u)/com.devproxy.proxy && echo "microproxy: restarted"

# status — running?, enabled at login?, who holds ports 80 and 53
launchctl print gui/$(id -u)/com.devproxy.proxy 2>/dev/null | grep -m2 -E '^\s*(state|pid) =' || echo "microproxy: not loaded"
launchctl print-disabled gui/$(id -u) | grep com.devproxy.proxy || echo "enabled at login"
lsof -nP -iTCP:80 -sTCP:LISTEN; lsof -nP -iUDP:53

# list — registered projects (servers started by hand are found live and not listed)
node ~/.config/devproxy/devproxy-cli.js list

# log — last lines
tail -30 ~/.config/devproxy/proxy.log
```

## Notes

- `off` never needs sudo. `on` and `restart` ask for the admin password only when the old dnsmasq
  service or the root LaunchDaemon is still installed.
- A server started by hand needs nothing: `<folder>.localhost` finds it (folder `LAB.Pepe` → `pepe`).
- If the log shows `DNS on port 53: bind EADDRINUSE`, run `restart`: the port-53 block removes the old dnsmasq.
