#!/usr/bin/env node
/********************************************************
	DEVPROXY - Central Reverse Proxy
	
	Routes *.localhost requests to registered project servers.
	Accepts registrations/deregistrations via Unix socket.
	
	Protocol (Unix socket, newline-delimited JSON):
	  → { "action": "register", "subdomain": "myapp", "port": 3001 }
	  ← { "ok": true }
	  → { "action": "deregister", "subdomain": "myapp" }
	  ← { "ok": true }
	  → { "action": "list" }
	  ← { "ok": true, "routes": { "myapp": 3001 } }
	
	@license MIT
********************************************************/

import http from 'http';
import { createServer as createNetServer } from 'net';
import { existsSync, unlinkSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PROXY_PORT = 8080;
const SOCKET_PATH = join(__dirname, 'proxy.sock');
const PID_FILE = join(__dirname, 'proxy.pid');

// ═══════════════════ ROUTE TABLE ═══════════════════

const routes = new Map(); // subdomain → port

// ═══════════════════ HTTP PROXY ═══════════════════

const httpServer = http.createServer((req, res) => {
	const host = req.headers.host || '';
	// Extract subdomain: "myapp.localhost" → "myapp"
	const match = host.match(/^([a-z0-9_-]+)\.localhost(:\d+)?$/i);

	if (!match) {
		// Non-localhost traffic (e.g. Apple Mail Private Relay health checks)
		// hits us because pfctl redirects ALL loopback port 80 → 8080.
		// Instead of blocking with 404, redirect to HTTPS so the original
		// service handles it. Fixes Mail not loading images.
		const redirectUrl = `https://${host}${req.url}`;
		res.writeHead(301, { Location: redirectUrl });
		res.end();
		return;
	}

	const subdomain = match[1].toLowerCase();
	const port = routes.get(subdomain);

	if (!port) {
		res.writeHead(502, { 'Content-Type': 'text/plain' });
		res.end(`devproxy: no server registered for "${subdomain}.localhost"\nRegistered: ${[...routes.keys()].join(', ') || '(none)'}`);
		return;
	}

	// Forward the request to the target server
	const options = {
		hostname: '127.0.0.1',
		port,
		path: req.url,
		method: req.method,
		headers: {
			...req.headers,
			// Preserve original host for servers that check it
			'x-forwarded-host': host,
			'x-forwarded-for': req.socket.remoteAddress,
		},
	};

	const proxyReq = http.request(options, (proxyRes) => {
		res.writeHead(proxyRes.statusCode, proxyRes.headers);
		proxyRes.pipe(res, { end: true });
	});

	proxyReq.on('error', (err) => {
		res.writeHead(502, { 'Content-Type': 'text/plain' });
		res.end(`devproxy: upstream error for "${subdomain}.localhost:${port}" — ${err.message}`);
	});

	req.pipe(proxyReq, { end: true });
});

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
			routes.set(sub, cmd.port);
			const verb = existing ? 'updated' : 'registered';
			console.log(`[devproxy] ${verb}: ${sub}.localhost → 127.0.0.1:${cmd.port}`);
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
			for (const [k, v] of routes) obj[k] = v;
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
	console.log(`[devproxy] control socket: ${SOCKET_PATH}`);
});

// Start HTTP proxy
httpServer.listen(PROXY_PORT, '127.0.0.1', () => {
	console.log(`[devproxy] listening on 127.0.0.1:${PROXY_PORT}`);
	console.log(`[devproxy] ready — route *.localhost here`);
});
