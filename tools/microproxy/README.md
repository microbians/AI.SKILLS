# devproxy — Zero-config local subdomain routing

Auto-discovers, registers, and auto-starts dev servers for any project type (PHP, Node, Python, static).

```
┌───────────────────────────────────────────────────────────────┐
│                                                               │
│  DEVPROXY                                                     │
│                                                               │
│  Browser → myapp.localhost:80                                 │
│         → devproxy (listens directly on port 80)              │
│         → routes by Host header                               │
│         → 127.0.0.1:3001 (your dev server)                    │
│                                                               │
│  Server not running?                                          │
│         → devproxy auto-starts it (php -S, npm run dev, etc.) │
│         → kills idle servers after 15min inactivity           │
│                                                               │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│  SUBDOMAIN NAMING (from directory name)                       │
│  ├── LAB.Photos      → photos.localhost                       │
│  ├── APP.Invoices    → invoices.localhost                     │
│  ├── AI.SKILLS       → skills.localhost                       │
│  └── pepe            → pepe.localhost                         │
│                                                               │
│  PROJECT TYPE (auto-detected)                                 │
│  ├── composer.json / index.php / public/index.php → php       │
│  ├── package.json                                  → node     │
│  ├── requirements.txt / *.py                       → python   │
│  └── *.html (fallback)                             → static   │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

## Quick start

```bash
# Start your server the way you always do, from the project folder:
cd ~/Projects/APP.Invoices
npm run dev            # or php artisan serve, rails s, python manage.py runserver, …

# That's it. Visit http://invoices.localhost — no registration needed.
```

To have the server start by itself when you visit the URL, register the project once with `devproxy` (see below).

## How it works

0. **Live discovery (no setup)**: When `invoices.localhost` is requested, the proxy looks for a process listening on a TCP port whose working directory is a folder named `invoices` (or `XXX.Invoices`), or a folder inside it. It routes to that port on whichever address the server bound (`127.0.0.1`, `::1` or all), so it works whatever port or command the server chose. The closest folder wins, then the lowest port. The result is cached until a connection to it fails, then looked up again. WebSockets (hot reload) are forwarded too. A live server always wins over a registered route.

1. **Register**: Run `devproxy` from your project directory. It auto-detects the project type, derives the subdomain from the directory name, finds a free port, and registers with the central proxy.

2. **Auto-start**: When you visit `invoices.localhost` in the browser, the proxy checks if the server is running. If not, it starts it automatically (`php -S`, `npm run dev`, etc.).

3. **Persist**: Projects are saved in `~/.config/devproxy/projects.json`. After a reboot, visiting any registered subdomain auto-starts its server.

4. **Idle cleanup**: Servers with no traffic for 15 minutes are automatically stopped.

## CLI

```bash
devproxy                          # Register current directory (auto-detect everything)
devproxy --port 8000              # Override port
devproxy --subdomain foo          # Override subdomain
devproxy --type php               # Override project type
devproxy list                     # Show all registered projects
devproxy start <subdomain>        # Start a project's server
devproxy stop <subdomain>         # Stop a running server
devproxy remove <subdomain>       # Remove project from registry
devproxy help                     # Show help
```

## Node.js module (for existing projects)

Node projects can still use the import API for dynamic registration:

```javascript
import { devproxy } from './lib/devproxy.js';

server.listen(PORT, () => {
  devproxy({ port: PORT, subdomain: 'myproject' });
});
```

This registers a dynamic (non-persistent) route. The project manages its own server lifecycle.

## Installation

```bash
# From the repo — copies everything into ~/.config/devproxy/ and sets it up
bash tools/microproxy/central/install.sh
```

Re-run the same command to update after pulling changes.

The installer:
1. Creates `/etc/resolver/localhost`, which sends `*.localhost` lookups to `127.0.0.1:53`. The proxy answers them itself (`*.localhost` → `127.0.0.1` / `::1`; anything else is refused), so no dnsmasq or Homebrew is needed
2. Sets up a LaunchAgent named `microproxy` (that is the name shown in Login Items): proxy on ports 80 and 53, starts at login, runs as you — no root. macOS lets a user open ports below 1024 on all interfaces; the proxy only answers this Mac
3. Removes what earlier versions installed: the root LaunchDaemon, and the dnsmasq service if it was set up for devproxy (the dnsmasq package stays)
4. Installs `devproxy` CLI globally (`/usr/local/bin/devproxy`)

Only steps 1, 3 and 4 ask for the admin password, once.

## Requirements

- macOS
- Node.js 18+

## Debugging

```bash
# Show registered projects and status
devproxy list

# Check proxy is alive
echo '{"action":"ping"}' | nc -U ~/.config/devproxy/proxy.sock

# View proxy logs
tail -f ~/.config/devproxy/proxy.log

# View persisted projects
cat ~/.config/devproxy/projects.json

# Restart the proxy (LaunchAgent, no sudo)
launchctl kickstart -k gui/$(id -u)/com.devproxy.proxy
```

## License

MIT
