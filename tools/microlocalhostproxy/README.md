# Smart Dev Port (microlocalhostproxy)

Drop-in port resolution and local subdomain routing for Node.js dev servers.

```
┌───────────────────────────────────────────────────────────────┐
│                                                               │
│  MICROLOCALHOSTPROXY                                          │
│                                                               │
│  Browser → myapp.localhost:80                                 │
│         → pfctl redirect → 127.0.0.1:8080                     │
│         → devproxy (central proxy) → routes by Host header    │
│         → 127.0.0.1:3001 (your dev server)                    │
│                                                               │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│  PORT RESOLUTION                                              │
│  ├── Port free         → use it directly                      │
│  ├── Occupied by US    → kill old process, reuse port         │
│  └── Occupied by OTHER → find next free port (up to +20)      │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

## What it does

**Port resolution:** Detects port conflicts using `lsof` to get the PID, then checks if its working directory is inside the current project root. Kills stale processes from the same project, or finds a free port if another project owns it.

**Devproxy (optional):** Routes `myproject.localhost` → `localhost:PORT` via a central reverse proxy daemon. No `/etc/hosts` editing. Works in Safari, Chrome, Firefox.

## Patterns included

```
┌─────────────┬─────────────────────────────────────────────────┐
│  Pattern    │  Use case                                       │
├─────────────┼─────────────────────────────────────────────────┤
│  Pattern A  │  Single server (Next.js, Vite, Express)         │
│  Pattern B  │  Multi-process (frontend + backend)             │
└─────────────┴─────────────────────────────────────────────────┘
```

## Quick start

```javascript
import { devproxy } from './lib/devproxy.js';

const PORT = await resolvePort(3001);
server.listen(PORT, () => {
  devproxy({ port: PORT, subdomain: 'myproject' });
});
```

## Documentation

Full documentation, code examples, AGENTS.md templates, and gotchas are in [`INSTALL.md`](INSTALL.md).

## Requirements

- macOS (uses `lsof` for PID/cwd detection, `pfctl` for port forwarding)
- Node.js 18+ (top-level await)

## License

MIT
