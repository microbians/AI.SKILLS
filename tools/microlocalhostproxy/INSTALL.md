# Smart Dev Port — Auto port resolution + devproxy for dev servers

Drop-in port resolution and local subdomain routing for any Node.js dev server.

## What it does

**Port resolution:**
1. **Port free** → uses it directly
2. **Port occupied by THIS project** → kills the old process, reuses port
3. **Port occupied by ANOTHER project** → finds next free port (up to +20)

Detection: uses `lsof` to get the PID on the port, then checks if its working directory is inside the current project root.

**Devproxy (optional):** Routes `myproject.localhost` → `localhost:PORT` via a central reverse proxy daemon at `~/.config/devproxy/`. First run auto-installs dnsmasq + pfctl rules. Subsequent runs just register the subdomain.

---

## Prerequisites

- macOS (uses `lsof` for PID/cwd detection, `pfctl` for port forwarding)
- Node.js 18+ (top-level await)
- devproxy infrastructure at `~/.config/devproxy/` (copy from `central/` in this repo)

---

## Port helper functions (shared by all patterns)

These three functions are the core. Copy them into whichever file manages your dev startup:

```javascript
import { execSync } from 'child_process';
import { createServer } from 'net';

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => { srv.close(); resolve(true); });
    srv.listen(port);  // ⚠ NO host argument — see Gotchas
  });
}

function getPortPid(port) {
  try {
    const out = execSync(`lsof -ti:${port}`, { encoding: 'utf-8' }).trim();
    const pid = parseInt(out.split('\n')[0], 10);
    return isNaN(pid) ? null : pid;
  } catch { return null; }
}

function isOurProject(pid) {
  try {
    const cwd = execSync(
      `lsof -p ${pid} | grep cwd | awk '{print $NF}'`,
      { encoding: 'utf-8' }
    ).trim();
    return cwd.startsWith(PROJECT_ROOT);
  } catch { return false; }
}

async function resolvePort(basePort, label = 'Server') {
  if (await isPortFree(basePort)) return basePort;

  const pid = getPortPid(basePort);
  if (pid && isOurProject(pid)) {
    console.log(`  [${label}] Killing previous instance (PID ${pid}) on port ${basePort}`);
    try { process.kill(pid, 'SIGTERM'); } catch {}
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 200));
      if (await isPortFree(basePort)) return basePort;
    }
  }

  for (let i = 1; i <= 20; i++) {
    if (await isPortFree(basePort + i)) {
      console.log(`  [${label}] Port ${basePort} in use by another project, using ${basePort + i}`);
      return basePort + i;
    }
  }
  throw new Error(`[${label}] No free port in range ${basePort}-${basePort + 20}`);
}
```

> `PROJECT_ROOT` must be defined before these functions. See patterns below.

---

## Pattern A: Single server (Next.js, Vite, Express, etc.)

Create `dev.mjs` next to the project's `package.json`:

```javascript
/**
 * Smart dev wrapper — auto port resolution + devproxy
 * Usage: node dev.mjs
 */
import { spawn, execSync } from 'child_process';
import { createServer } from 'net';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { devproxy } from './lib/devproxy.js';  // optional

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = __dirname;
const BASE_PORT = parseInt(process.env.PORT || '3001', 10);

// ── Port helpers (paste from above) ──────────────────────
// isPortFree, getPortPid, isOurProject, resolvePort
// ...

// ── Start ────────────────────────────────────────────────

const PORT = await resolvePort(BASE_PORT);

// === Next.js ===
const child = spawn('npx', ['next', 'dev', '--port', String(PORT)], {
  stdio: 'inherit',
  env: { ...process.env, PORT: String(PORT) },
});

// === OR Vite ===
// const child = spawn('npx', ['vite', '--port', String(PORT)], { ... });

// === OR Express / plain Node ===
// const child = spawn('node', ['server.js'], {
//   stdio: 'inherit',
//   env: { ...process.env, PORT: String(PORT) },
// });

// Register devproxy (optional — remove if not using devproxy)
setTimeout(() => {
  devproxy({ port: PORT, subdomain: 'myproject' });
}, 3000);

child.on('close', (code) => process.exit(code));
```

---

## Pattern B: Multi-process (frontend + backend)

For monorepos with a frontend (Next.js/Vite) and a backend (Express/Fastify) on separate ports. Create `start.js` at the project root:

```javascript
/**
 * Multi-process dev launcher with smart port resolution + devproxy
 * Usage: node start.js --dev
 */
import { spawn, execSync } from 'child_process';
import { createServer } from 'net';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { devproxy } from './lib/devproxy.js';  // optional

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = __dirname;
const isDev = process.argv.includes('--dev');

// ── Port helpers (paste from above) ──────────────────────
// isPortFree, getPortPid, isOurProject, resolvePort
// ...

// ── Resolve BOTH ports ───────────────────────────────────
// IMPORTANT: resolve backend first, then frontend.
// The frontend needs the resolved backend port for API proxy/rewrites.

const BASE_API_PORT = parseInt(process.env.INTERNAL_API_PORT || '3010', 10);
const BASE_PUBLIC_PORT = parseInt(process.env.PORT || '3011', 10);

const API_PORT = await resolvePort(BASE_API_PORT, 'API');
const PUBLIC_PORT = await resolvePort(BASE_PUBLIC_PORT, 'Client');

console.log(`[MyProject] Starting...`);
console.log(`  Frontend: port ${PUBLIC_PORT}`);
console.log(`  Backend:  port ${API_PORT} (internal)`);

// ── Process launcher ─────────────────────────────────────

function startProcess(name, command, args, cwd, env = {}) {
  const proc = spawn(command, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  proc.on('error', (err) => {
    console.error(`[${name}] Failed to start: ${err.message}`);
    process.exit(1);
  });
  proc.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[${name}] Exited with code ${code}`);
      process.exit(code);
    }
  });
  return proc;
}

// ── Start backend ────────────────────────────────────────

const serverProc = startProcess(
  'API',
  'node',
  [isDev ? '--watch' : '', 'index.js'].filter(Boolean),
  resolve(__dirname, 'server'),
  {
    PORT: String(API_PORT),
    NODE_ENV: isDev ? 'development' : 'production',
  }
);

// ── Start frontend ───────────────────────────────────────
// CRITICAL: pass the resolved API_PORT so the frontend's proxy/rewrites
// point to the correct backend port (e.g. Next.js rewrites, Vite proxy).

const clientProc = startProcess(
  'Client',
  'npm',
  ['run', 'dev', '--', '--port', String(PUBLIC_PORT)],
  resolve(__dirname, 'client'),
  {
    PORT: String(PUBLIC_PORT),
    INTERNAL_API_PORT: String(API_PORT),  // ← frontend reads this for rewrites
    NODE_ENV: 'development',
  }
);

// ── Devproxy (optional) ──────────────────────────────────
// Register the PUBLIC (frontend) port — that's what the browser hits.

if (isDev) {
  setTimeout(() => {
    devproxy({ port: PUBLIC_PORT, subdomain: 'myproject' });
  }, 3000);
}

// ── Graceful shutdown ────────────────────────────────────

function shutdown() {
  serverProc.kill('SIGTERM');
  clientProc.kill('SIGTERM');
  setTimeout(() => process.exit(0), 3000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

### Frontend config (Next.js example)

The frontend must read `INTERNAL_API_PORT` to proxy API calls to the resolved backend port:

```typescript
// next.config.ts
const API_URL = `http://localhost:${process.env.INTERNAL_API_PORT || '3010'}`;

const nextConfig = {
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${API_URL}/api/:path*` },
    ];
  },
};
export default nextConfig;
```

For Vite:
```typescript
// vite.config.ts
export default defineConfig({
  server: {
    proxy: {
      '/api': `http://localhost:${process.env.INTERNAL_API_PORT || '3010'}`,
    },
  },
});
```

---

## Setting up devproxy

### 1. Copy `lib/devproxy.js` into your project

The file is a self-contained client that talks to the central proxy daemon. Copy it from the `client/` folder in this repo:

```
myproject/
  lib/
    devproxy.js    ← copy this file
  start.js         ← or dev.mjs
  package.json
```

### 2. CORS for the subdomain

If your backend has CORS restrictions, add the devproxy subdomain to allowed origins:

```javascript
// Express example
const corsOrigin = process.env.NODE_ENV === 'production'
  ? true
  : ['http://localhost:3011', 'http://myproject.localhost'];
app.use(cors({ origin: corsOrigin }));
```

### 3. Subdomain naming

`devproxy()` resolves the subdomain in this order:
1. Explicit `subdomain` option → `devproxy({ port, subdomain: 'myapp' })`
2. `name` field from nearest `package.json`
3. Interactive macOS dialog prompt (last resort)

Always pass it explicitly to avoid surprises.

### 4. Wire to npm scripts

```json
{
  "scripts": {
    "dev": "node start.js --dev"
  }
}
```

Or for single-server projects:
```json
{
  "scripts": {
    "dev": "node dev.mjs"
  }
}
```

### 5. Add to `.gitignore`

`lib/devproxy.js` is a local-only file (identical across all projects, depends on machine-specific `~/.config/devproxy/` infrastructure). It must NOT be committed to the repo.

Add this to the project's `.gitignore`:

```gitignore
# Devproxy (local-only, machine-specific)
lib/devproxy.js
```

---

## Gotchas

### `isPortFree` must NOT bind to a specific host

Node's `server.listen(port)` (no host) binds to `::` (all interfaces, IPv4+IPv6). If you test only `127.0.0.1`, a server listening on `::` won't be detected and you'll get `EADDRINUSE` when the real server starts.

```javascript
// ✅ Correct
srv.listen(port);

// ❌ Wrong — misses IPv6 listeners
srv.listen(port, '127.0.0.1');
```

### Non-localhost traffic pass-through

Since pfctl redirects ALL loopback port 80 traffic to 8080, any local HTTP request on port 80 (e.g., Apple Mail Private Relay health checks, system HTTP requests) will hit the proxy. The proxy handles this by returning a `301` redirect to the HTTPS version of the same URL for any request whose `Host` header is NOT `*.localhost`. This ensures non-dev traffic isn't blocked and apps like Mail continue working normally.

### Devproxy daemon can freeze

macOS may suspend the proxy daemon process after prolonged inactivity (shows as state `SNs` in `ps`). Symptoms: `lsof` shows port 8080 LISTEN but connections timeout.

**Fix:** Kill and restart the daemon:
```bash
kill -9 $(cat ~/.config/devproxy/proxy.pid)
node ~/.config/devproxy/proxy.js &
```

Routes are in-memory only — if the daemon restarts, projects re-register automatically on their next `npm run dev`. Re-registering the same subdomain overwrites the port (subdomain is the unique key).

**Manual registration** (without restarting a project):
```bash
echo '{"action":"register","subdomain":"myproject","port":3001}' | nc -U ~/.config/devproxy/proxy.sock
```

### Multi-process: resolve backend port FIRST

When both frontend and backend need port resolution, resolve the backend port first. The frontend depends on knowing the backend's actual port for API proxy/rewrite config. Pass it via environment variable (e.g., `INTERNAL_API_PORT`).

### Don't hardcode ports in sub-package scripts

If your root `start.js` resolves ports dynamically, don't also hardcode ports in the sub-package's `package.json` scripts. Either:
- Remove the port from the sub-package script and always launch via root `start.js`
- Or keep the sub-package script as a fallback but accept the `--port X --port Y` duplication (cosmetic, harmless)

---

## Debugging

```bash
# Check what's registered
echo '{"action":"list"}' | nc -U ~/.config/devproxy/proxy.sock

# Check if daemon is alive
echo '{"action":"ping"}' | nc -U ~/.config/devproxy/proxy.sock

# Check pfctl redirect (port 80 → 8080)
sudo pfctl -a com.devproxy -s nat

# Check DNS resolution
dig +short myproject.localhost @127.0.0.1

# Test proxy directly (bypassing DNS/pfctl)
curl -H "Host: myproject.localhost" http://127.0.0.1:80/

# See all registered PIDs on a port
lsof -ti:3011

# Check if proxy process is healthy (look for S vs SNs state)
ps aux | grep proxy.js
```

---

## AGENTS.md section (copy into each project)

When installing smart-dev-port + devproxy into a project, add the following section to the project's `AGENTS.md` (or equivalent agent instructions file). Adapt the values in `[brackets]` to the specific project.

---

### Template for single-server projects (Pattern A)

````markdown
## DEV SERVER & DEVPROXY

**Dev command:** `npm run dev` (runs `node dev.mjs`)
**URL:** `http://[subdomain].localhost` (via devproxy) or `http://localhost:[PORT]`
**Base port:** `[PORT]` (auto-resolves if occupied — see `dev.mjs`)

### How dev startup works (`dev.mjs`)
- Smart port resolution: if port [PORT] is busy, kills previous instance of THIS project or finds next free port
- Registers `[subdomain].localhost` with devproxy daemon (`~/.config/devproxy/`)
- Devproxy routes `[subdomain].localhost` → `localhost:<resolved-port>` via reverse proxy on port 80

### Key files
- `dev.mjs` — Dev launcher with port resolution + devproxy registration
- `lib/devproxy.js` — Devproxy client (do NOT modify — shared pattern across projects, gitignored)

### Restarting dev server
```bash
# Preferred — smart port resolution handles killing previous instance:
npm run dev

# Manual full kill if needed:
lsof -ti:[PORT] | xargs kill -9 2>/dev/null; npm run dev
```

### If devproxy stops working
The devproxy daemon (`~/.config/devproxy/proxy.js`) may freeze (macOS suspends idle processes). Fix:
```bash
kill -9 $(cat ~/.config/devproxy/proxy.pid) 2>/dev/null
node ~/.config/devproxy/proxy.js &
```
After a daemon restart, routes are cleared. Projects re-register automatically on their next `npm run dev`.

### RULES for dev server changes
- **NEVER hardcode ports** — always use `resolvePort()` or read from env vars
- **NEVER modify `lib/devproxy.js`** — it's a shared client, identical across projects, gitignored
- **Ports are dynamic** — don't assume `:PORT` is always [PORT], check what `dev.mjs` resolved
- If adding CORS, include `http://[subdomain].localhost` in allowed origins
- Browser URL is `http://[subdomain].localhost`, NOT `localhost:[PORT]`
- **Railway/production NOT affected** — `dev.mjs` and `devproxy.js` are gitignored, production uses `build`+`start` only
````

---

### Template for multi-process projects (Pattern B)

````markdown
## DEV SERVER & DEVPROXY

**Dev command:** `npm run dev` (runs `node start.js --dev`)
**URL:** `http://[subdomain].localhost` (via devproxy) or `http://localhost:[PUBLIC_PORT]`
**Ports:** Frontend :[PUBLIC_PORT] | Backend :[API_PORT] (both auto-resolve if occupied)

### How dev startup works (`start.js --dev`)
1. Resolves backend port (base [API_PORT]) — kills previous instance of THIS project or finds next free
2. Resolves frontend port (base [PUBLIC_PORT]) — same logic
3. Starts backend with resolved port via `PORT` env var
4. Starts frontend with resolved port + passes `INTERNAL_API_PORT` env var so rewrites/proxy point to correct backend
5. Registers `[subdomain].localhost` with devproxy daemon → routes to frontend port

### Key files
- `start.js` — Multi-process dev launcher with port resolution + devproxy
- `lib/devproxy.js` — Devproxy client (do NOT modify — shared pattern across projects, gitignored)
- `[frontend-config]` — Reads `INTERNAL_API_PORT` env var for API proxy/rewrites

### Restarting dev server
```bash
# Preferred — smart port resolution handles killing previous instances:
npm run dev

# Manual full kill if needed:
lsof -ti:[API_PORT],[PUBLIC_PORT] | xargs kill -9 2>/dev/null; npm run dev
```

### If devproxy stops working
The devproxy daemon (`~/.config/devproxy/proxy.js`) may freeze (macOS suspends idle processes). Fix:
```bash
kill -9 $(cat ~/.config/devproxy/proxy.pid) 2>/dev/null
node ~/.config/devproxy/proxy.js &
```
After a daemon restart, routes are cleared. Projects re-register automatically on their next `npm run dev`.

### RULES for dev server changes
- **NEVER hardcode ports** — always use `resolvePort()` or read from env vars
- **NEVER modify `lib/devproxy.js`** — it's a shared client, identical across projects, gitignored
- **Ports are dynamic** — don't assume :[API_PORT] and :[PUBLIC_PORT] are fixed, check what `start.js` resolved
- **INTERNAL_API_PORT must flow** — if backend port changes, frontend must receive it via env var for rewrites to work
- If adding/changing CORS on the backend, include `http://[subdomain].localhost` in allowed origins
- Browser URL is `http://[subdomain].localhost`, NOT `localhost:[PUBLIC_PORT]`
- When verifying with curl, use `http://[subdomain].localhost` as the primary URL
- **Railway/production NOT affected** — `start.js` and `devproxy.js` are gitignored, production uses `build`+`start` only
````

---

### `.gitignore` additions

Add this to every project where smart-dev-port + devproxy is installed:

```gitignore
# Devproxy (local-only, machine-specific)
lib/devproxy.js
```

`lib/devproxy.js` is identical across all projects and depends on machine-local infrastructure (`~/.config/devproxy/`). It must NOT be committed. Each developer copies it from the `client/` folder in this repo on first setup.
