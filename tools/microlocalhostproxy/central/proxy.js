#!/usr/bin/env node
/********************************************************
	DEVPROXY - Central Reverse Proxy
	
	Routes *.localhost requests to registered project servers.
	Listens directly on port 80 (no pfctl needed).
	Drops root privileges after binding to port 80.
	Non-.localhost traffic is ignored (connection reset).
	
	Protocol (Unix socket, newline-delimited JSON):
	  → { "action": "register", "subdomain": "myapp", "port": 3001, "name": "My App" }
	  ← { "ok": true }
	  → { "action": "deregister", "subdomain": "myapp" }
	  ← { "ok": true }
	  → { "action": "list" }
	  ← { "ok": true, "routes": { "myapp": { "port": 3001, "name": "My App" } } }
	
	@license MIT
********************************************************/

import http from 'http';
import { createServer as createNetServer } from 'net';
import { existsSync, unlinkSync, writeFileSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const LISTEN_PORT = 80;
const SOCKET_PATH = join(__dirname, 'proxy.sock');
const PID_FILE = join(__dirname, 'proxy.pid');

// ═══════════════════ ROUTE TABLE ═══════════════════

const routes = new Map(); // subdomain → { port, name }

// ═══════════════════ HTTP SERVER ═══════════════════

const httpServer = http.createServer((req, res) => {
	const host = req.headers.host || '';
	// Extract subdomain: "myapp.localhost" → "myapp"
	const match = host.match(/^([a-z0-9_-]+)\.localhost(:\d+)?$/i);

	if (!match) {
		// Non-localhost traffic — destroy socket immediately.
		// This port only serves *.localhost subdomains.
		// Any other traffic that arrives (shouldn't happen without pfctl)
		// gets a clean connection reset.
		req.socket.destroy();
		return;
	}

	const subdomain = match[1].toLowerCase();
	const route = routes.get(subdomain);

	if (!route) {
		res.writeHead(502, { 'Content-Type': 'text/plain' });
		res.end(`devproxy: no server registered for "${subdomain}.localhost"\nRegistered: ${[...routes.keys()].join(', ') || '(none)'}`);
		return;
	}

	// Buffer request body for retries (needed because req stream is consumed once)
	const bodyChunks = [];
	req.on('data', (chunk) => bodyChunks.push(chunk));
	req.on('end', () => {
		const body = Buffer.concat(bodyChunks);
		forwardWithRetry(req, res, subdomain, route, host, body, 0);
	});
});

// ═══════════════════ RETRY + ERROR PAGE ═══════════════════

const RETRY_DELAYS = [300, 700, 1500]; // 3 retries with backoff (ms)

function forwardWithRetry(req, res, subdomain, route, host, body, attempt) {
	const options = {
		hostname: '127.0.0.1',
		port: route.port,
		path: req.url,
		method: req.method,
		headers: {
			...req.headers,
			'x-forwarded-host': host,
			'x-forwarded-for': req.socket.remoteAddress,
			'content-length': body.length, // recalculate since we buffered
		},
	};

	const proxyReq = http.request(options, (proxyRes) => {
		res.writeHead(proxyRes.statusCode, proxyRes.headers);
		proxyRes.pipe(res, { end: true });
	});

	proxyReq.on('error', (err) => {
		const isRetryable = err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET';

		if (isRetryable && attempt < RETRY_DELAYS.length) {
			const delay = RETRY_DELAYS[attempt];
			setTimeout(() => {
				forwardWithRetry(req, res, subdomain, route, host, body, attempt + 1);
			}, delay);
			return;
		}

		// All retries exhausted or non-retryable error — send error page
		const retried = attempt > 0 ? ` (after ${attempt} retries)` : '';
		console.error(`[devproxy] upstream error: ${subdomain}.localhost:${route.port} — ${err.message}${retried}`);
		res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
		res.end(errorPage(subdomain, route.port, err.message, attempt));
	});

	proxyReq.end(body);
}

function errorPage(subdomain, port, errorMsg, attempts) {
	const domain = `${subdomain}.localhost`;
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>devproxy — ${domain} unreachable</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
         background: #1a1a2e; color: #e0e0e0; display: flex; justify-content: center; align-items: center;
         min-height: 100vh; padding: 2rem; }
  .card { background: #16213e; border: 1px solid #0f3460; border-radius: 12px; padding: 2.5rem;
          max-width: 520px; width: 100%; box-shadow: 0 8px 32px rgba(0,0,0,.4); }
  h1 { font-size: 1.1rem; color: #e94560; margin-bottom: 1rem; font-weight: 600; }
  .domain { color: #53a8b6; font-weight: 600; }
  .port { color: #e94560; font-family: monospace; }
  .error { background: #0f3460; border-radius: 6px; padding: .75rem 1rem; margin: 1rem 0;
           font-family: monospace; font-size: .85rem; color: #ff6b6b; word-break: break-all; }
  .info { font-size: .9rem; line-height: 1.6; color: #a0a0b8; margin-top: 1rem; }
  .info code { background: #0f3460; padding: .15rem .4rem; border-radius: 4px; font-size: .85rem; color: #53a8b6; }
  .retry-info { font-size: .8rem; color: #666; margin-top: 1rem; font-style: italic; }
  .actions { margin-top: 1.5rem; display: flex; gap: .75rem; }
  .btn { padding: .5rem 1.2rem; border-radius: 6px; border: 1px solid #0f3460; background: #0f3460;
         color: #e0e0e0; cursor: pointer; font-size: .85rem; text-decoration: none; transition: background .15s; }
  .btn:hover { background: #1a3a6e; }
  .btn-primary { background: #e94560; border-color: #e94560; color: #fff; }
  .btn-primary:hover { background: #c73e55; }
</style>
</head>
<body>
<div class="card">
  <h1>Upstream server unreachable</h1>
  <p>The server for <span class="domain">${domain}</span> on port <span class="port">${port}</span> is not responding.</p>
  <div class="error">${errorMsg}</div>
  <div class="info">
    <p>This usually means:</p>
    <ul style="margin: .5rem 0 0 1.2rem;">
      <li>The dev server is still starting up</li>
      <li>The dev server crashed or was stopped</li>
      <li>The port <code>${port}</code> changed (dynamic port resolution)</li>
    </ul>
    <p style="margin-top: .75rem;">Try restarting your dev server:</p>
    <p style="margin-top: .25rem;"><code>npm run dev</code></p>
  </div>
  ${attempts > 0 ? `<p class="retry-info">devproxy retried ${attempts} time${attempts > 1 ? 's' : ''} with backoff before giving up.</p>` : ''}
  <div class="actions">
    <a class="btn btn-primary" href="javascript:location.reload()">Retry</a>
  </div>
</div>
</body>
</html>`;
}

// ═══════════════════ UNIX SOCKET CONTROL ═══════════════════

function handleCommand(data) {
	try {
		const cmd = JSON.parse(data);

		if (cmd.action === 'register') {
			if (!cmd.subdomain || !cmd.port) {
				return JSON.stringify({ ok: false, error: 'Missing subdomain or port' });
			}
			const sub = cmd.subdomain.toLowerCase();
			const existing = routes.get(sub);
			const name = cmd.name || sub;
			routes.set(sub, { port: cmd.port, name });
			const verb = existing ? 'updated' : 'registered';
			console.log(`[devproxy] ${verb}: ${sub}.localhost → 127.0.0.1:${cmd.port} (${name})`);
			return JSON.stringify({ ok: true, verb });
		}

		if (cmd.action === 'deregister') {
			if (!cmd.subdomain) {
				return JSON.stringify({ ok: false, error: 'Missing subdomain' });
			}
			const sub = cmd.subdomain.toLowerCase();
			const had = routes.delete(sub);
			if (had) console.log(`[devproxy] deregistered: ${sub}.localhost`);
			return JSON.stringify({ ok: true, removed: had });
		}

		if (cmd.action === 'list') {
			const obj = {};
			for (const [k, v] of routes) obj[k] = { port: v.port, name: v.name };
			return JSON.stringify({ ok: true, routes: obj });
		}

		if (cmd.action === 'ping') {
			return JSON.stringify({ ok: true, pid: process.pid, uptime: process.uptime() });
		}

		return JSON.stringify({ ok: false, error: `Unknown action: ${cmd.action}` });
	} catch (err) {
		return JSON.stringify({ ok: false, error: `Parse error: ${err.message}` });
	}
}

const controlServer = createNetServer((socket) => {
	let buffer = '';
	socket.on('data', (chunk) => {
		buffer += chunk.toString();
		// Process complete lines
		let newline;
		while ((newline = buffer.indexOf('\n')) !== -1) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (line) {
				const response = handleCommand(line);
				socket.write(response + '\n');
			}
		}
	});
	socket.on('error', () => {}); // ignore client disconnects
});

// ═══════════════════ STARTUP ═══════════════════

function cleanup() {
	try { unlinkSync(SOCKET_PATH); } catch {}
	try { unlinkSync(PID_FILE); } catch {}
}

function shutdown() {
	console.log('\n[devproxy] shutting down...');
	httpServer.close();
	controlServer.close();
	cleanup();
	process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Clean up stale socket
if (existsSync(SOCKET_PATH)) {
	unlinkSync(SOCKET_PATH);
}

// Write PID file
writeFileSync(PID_FILE, String(process.pid));

// Start control socket
controlServer.listen(SOCKET_PATH, () => {
	// Make socket writable by non-root users so projects can register
	chmodSync(SOCKET_PATH, 0o777);
	console.log(`[devproxy] control socket: ${SOCKET_PATH}`);
});

// Start HTTP server on port 80
httpServer.listen(LISTEN_PORT, '127.0.0.1', () => {
	console.log(`[devproxy] listening on 127.0.0.1:${LISTEN_PORT}`);

	// Drop root privileges after binding to port 80
	if (process.getuid && process.getuid() === 0) {
		const uid = parseInt(process.env.SUDO_UID || '501', 10);
		const gid = parseInt(process.env.SUDO_GID || '20', 10);
		try {
			process.setgid(gid);
			process.setuid(uid);
			console.log(`[devproxy] dropped privileges to uid=${uid} gid=${gid}`);
		} catch (err) {
			console.warn(`[devproxy] warning: could not drop privileges: ${err.message}`);
		}
	}

	console.log(`[devproxy] ready — route *.localhost here`);
});
