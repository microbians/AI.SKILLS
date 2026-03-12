#!/usr/bin/env node
/********************************************************
	DEVPROXY - Central Reverse Proxy
	
	Routes *.localhost requests to registered project servers.
	Listens directly on port 80 (no pfctl needed).
	Drops root privileges after binding to port 80.
	Non-.localhost traffic is ignored (connection reset).
	
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
import { existsSync, unlinkSync, writeFileSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const LISTEN_PORT = 80;
const SOCKET_PATH = join(__dirname, 'proxy.sock');
const PID_FILE = join(__dirname, 'proxy.pid');

// ═══════════════════ ROUTE TABLE ═══════════════════

const routes = new Map(); // subdomain → port

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
