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
│         → kills idle servers after 15min inactivity            │
│                                                               │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│  SUBDOMAIN NAMING (from directory name)                       │
│  ├── LAB.Imager      → imager.localhost                       │
│  ├── MICRO.AutoMkt   → automkt.localhost                      │
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
# From any project directory:
cd ~/Programacion/MICRO.AutoMkt
devproxy

# That's it. Visit http://automkt.localhost
# The server auto-starts when you visit the URL.
```

## How it works

1. **Register**: Run `devproxy` from your project directory. It auto-detects the project type, derives the subdomain from the directory name, finds a free port, and registers with the central proxy.

2. **Auto-start**: When you visit `automkt.localhost` in the browser, the proxy checks if the server is running. If not, it starts it automatically (`php -S`, `npm run dev`, etc.).

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
# Copy central files to ~/.config/devproxy/
cp central/proxy.js ~/.config/devproxy/
cp central/install.sh ~/.config/devproxy/

# Run installer (one-time — installs dnsmasq, resolver, LaunchDaemon, CLI)
bash ~/.config/devproxy/install.sh
```

The installer:
1. Installs dnsmasq (resolves `*.localhost` → 127.0.0.1)
2. Creates `/etc/resolver/localhost`
3. Sets up LaunchDaemon (proxy on port 80, auto-starts at boot)
4. Installs `devproxy` CLI globally (`/usr/local/bin/devproxy`)

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

# Restart the LaunchDaemon
sudo launchctl unload /Library/LaunchDaemons/com.devproxy.proxy.plist
sudo launchctl load /Library/LaunchDaemons/com.devproxy.proxy.plist
```

## License

MIT
