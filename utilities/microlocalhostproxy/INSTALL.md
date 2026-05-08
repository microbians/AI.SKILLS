# devproxy — Installation & Usage Guide

Zero-config local subdomain routing with auto-start for any project type.

## What it does

**Auto-detection:** Scans the current directory to determine project type (PHP, Node, Python, static) and derives the subdomain from the directory name.

**Auto-start:** When a request hits `myproject.localhost` and the server isn't running, devproxy starts it automatically using the appropriate command (`php -S`, `npm run dev`, `python -m http.server`, etc.).

**Persistence:** Registered projects are saved to `~/.config/devproxy/projects.json` and survive reboots. Visit the URL anytime — the server starts on demand.

**Idle cleanup:** Auto-started servers with no traffic for 15 minutes are stopped automatically.

---

## Prerequisites

- macOS (uses LaunchDaemon for port 80 binding)
- Node.js 18+

---

## Installation

```bash
# 1. Copy central files
mkdir -p ~/.config/devproxy
cp central/proxy.js ~/.config/devproxy/
cp central/install.sh ~/.config/devproxy/
cp central/package.json ~/.config/devproxy/

# 2. Run installer
bash ~/.config/devproxy/install.sh
```

The installer sets up:
1. **dnsmasq** — resolves `*.localhost` → 127.0.0.1
2. **macOS resolver** — `/etc/resolver/localhost`
3. **LaunchDaemon** — proxy on port 80, auto-starts at boot, drops root after binding
4. **CLI tool** — `devproxy` command available globally via `/usr/local/bin/devproxy`

---

## Pattern A: Single server (Next.js, Vite, Express)

Node projects with their own dev launcher:

```javascript
// dev.mjs
import { devproxy } from './lib/devproxy.js';

const PORT = await resolvePort(3001);
server.listen(PORT, () => {
  devproxy({ port: PORT, subdomain: 'myproject' });
});
```

Copy `client/devproxy.js` to `lib/devproxy.js` in your project. Add to `.gitignore`:
```
lib/devproxy.js
```

---

## Pattern B: Multi-process (frontend + backend)

Same as Pattern A but with two servers. See the full multi-process template in the code examples below.

---

## Pattern C: Any project (PHP, Python, static, etc.)

**Zero config.** Just run `devproxy` from the project directory:

```bash
cd ~/Programacion/MICRO.AutoMkt
devproxy
```

Output:
```
  ✓ automkt registered
    URL:  http://automkt.localhost
    Dir:  /Users/.../MICRO.AutoMkt
    Type: php
    Port: 8000
```

Now visit `http://automkt.localhost` — the proxy auto-starts `php -S` pointed at the `public/` directory.

### How auto-detection works

**Subdomain** (from directory name):
- `LAB.Imager` → `imager` (part after the dot, lowercase)
- `MICRO.AutoMkt` → `automkt`
- `pepe` → `pepe` (no dot, name as-is)

**Project type** (by files present):
| Files detected | Type |
|---|---|
| `composer.json`, `index.php`, `public/index.php`, `artisan` | `php` |
| `package.json` | `node` |
| `requirements.txt`, `pyproject.toml`, `*.py` | `python` |
| `*.html` (fallback) | `static` |

**Start command** (auto-generated):
| Type | Command |
|---|---|
| `php` | `php -S 127.0.0.1:PORT -t public/` (or project root if no `public/`) |
| `node` | `npm run dev` (or `npm start`, or `node start.js/server.js/index.js`) |
| `python` | `python3 -m http.server PORT` |
| `static` | `php -S 127.0.0.1:PORT -t DIR` |

### Override defaults

```bash
devproxy --port 9000              # Use specific port
devproxy --subdomain myname       # Override subdomain
devproxy --type node              # Override detected type
```

---

## CLI Reference

```bash
devproxy                          # Register cwd (auto-detect)
devproxy --port 8000              # Register with specific port
devproxy --subdomain foo          # Register with specific subdomain
devproxy --type php               # Override project type
devproxy --dir /path/to/project   # Register a different directory
devproxy list                     # Show all registered projects + status
devproxy start <subdomain>        # Manually start a server
devproxy stop <subdomain>         # Stop a running server
devproxy remove <subdomain>       # Remove from registry permanently
devproxy help                     # Show help
```

---

## Proxy Socket Protocol

The proxy accepts JSON commands via Unix socket (`~/.config/devproxy/proxy.sock`):

```bash
# Register a project (persistent, with auto-start)
echo '{"action":"register-project","subdomain":"automkt","dir":"/path/to/project","type":"php","port":8000}' | nc -U ~/.config/devproxy/proxy.sock

# Register a route (dynamic, non-persistent — for Node projects that manage their own server)
echo '{"action":"register","subdomain":"myapp","port":3001,"name":"My App"}' | nc -U ~/.config/devproxy/proxy.sock

# List everything
echo '{"action":"list"}' | nc -U ~/.config/devproxy/proxy.sock

# Start/stop a project's server
echo '{"action":"start","subdomain":"automkt"}' | nc -U ~/.config/devproxy/proxy.sock
echo '{"action":"stop","subdomain":"automkt"}' | nc -U ~/.config/devproxy/proxy.sock

# Remove a project permanently
echo '{"action":"remove-project","subdomain":"automkt"}' | nc -U ~/.config/devproxy/proxy.sock

# Deregister a dynamic route
echo '{"action":"deregister","subdomain":"myapp"}' | nc -U ~/.config/devproxy/proxy.sock

# Ping
echo '{"action":"ping"}' | nc -U ~/.config/devproxy/proxy.sock
```

---

## Debugging

```bash
# Show registered projects
devproxy list

# Check proxy is alive
echo '{"action":"ping"}' | nc -U ~/.config/devproxy/proxy.sock

# Check port 80 is listening
lsof -i :80 -sTCP:LISTEN

# Check DNS resolution
dig +short test.localhost @127.0.0.1

# Test proxy directly
curl -H "Host: automkt.localhost" http://127.0.0.1:80/

# View proxy logs (includes auto-start output)
tail -f ~/.config/devproxy/proxy.log

# View persisted projects
cat ~/.config/devproxy/projects.json

# Restart the LaunchDaemon
sudo launchctl unload /Library/LaunchDaemons/com.devproxy.proxy.plist
sudo launchctl load /Library/LaunchDaemons/com.devproxy.proxy.plist
```

---

## Gotchas

### Servers need a moment to boot
When a server is auto-started, the first request gets a "Starting..." page that auto-refreshes after 2 seconds. Subsequent requests are proxied normally.

### Idle timeout
Auto-started servers are killed after 15 minutes of inactivity. The next request will auto-start them again (with a brief loading page).

### LaunchDaemon can freeze
macOS may suspend the daemon after prolonged inactivity. Fix:
```bash
sudo launchctl unload /Library/LaunchDaemons/com.devproxy.proxy.plist
sudo launchctl load /Library/LaunchDaemons/com.devproxy.proxy.plist
```

### Port conflicts
The CLI finds a free port automatically (tries base port, then +1 to +20). If a project was previously registered on a port that's now in use, the auto-start will still work — the proxy retries with backoff.

---

## License

MIT
