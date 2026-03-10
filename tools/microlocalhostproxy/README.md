# Smart Dev Port (microlocalhostproxy)

Drop-in port resolution and local subdomain routing for Node.js dev servers.

## What it does

**Port resolution:**
1. **Port free** -- uses it directly
2. **Port occupied by THIS project** -- kills the old process, reuses port
3. **Port occupied by ANOTHER project** -- finds next free port (up to +20)

**Devproxy (optional):** Routes `myproject.localhost` -> `localhost:PORT` via a central reverse proxy daemon. No `/etc/hosts` editing, works in Safari/Chrome/Firefox.

```
Browser -> myapp.localhost:80
        -> pfctl redirect -> 127.0.0.1:8080
        -> devproxy (central proxy) -> routes by Host header
        -> 127.0.0.1:3001 (your dev server)
```

## Patterns included

| Pattern | Use case |
|---------|----------|
| **Pattern A** | Single server (Next.js, Vite, Express) |
| **Pattern B** | Multi-process (frontend + backend on separate ports) |

## Quick start

1. Copy the port helper functions from `microlocalhostproxy.md` into your dev startup file
2. Use `resolvePort(basePort)` before starting your server
3. (Optional) Add devproxy for `*.localhost` subdomain routing

```javascript
import { devproxy } from './lib/devproxy.js';

const PORT = await resolvePort(3001);
server.listen(PORT, () => {
  devproxy({ port: PORT, subdomain: 'myproject' });
});
```

## Documentation

Full documentation, code examples, AGENTS.md templates, and gotchas are in [`microlocalhostproxy.md`](microlocalhostproxy.md).

## Requirements

- macOS (uses `lsof` for PID/cwd detection, `pfctl` for port forwarding)
- Node.js 18+ (top-level await)

## License

MIT
