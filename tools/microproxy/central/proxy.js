#!/usr/bin/env node
/********************************************************
	DEVPROXY - Central Reverse Proxy

	Routes *.localhost requests to running or registered project servers.
	Listens on port 80 of every interface, which macOS allows without root,
	and closes any connection that does not come from this Mac. Also answers
	DNS for *.localhost on port 53 (same rule), so no dnsmasq is needed.
	Non-.localhost traffic is ignored (connection reset).

	Features:
	  - Dynamic registration via Unix socket (Node projects)
	  - Persistent project registry (projects.json) for auto-start
	  - Auto-starts servers on demand (PHP, Node, etc.)
	  - Kills idle servers after inactivity timeout

	Protocol (Unix socket, newline-delimited JSON):
	  → { "action": "register", "subdomain": "myapp", "port": 3001, "name": "My App" }
	  ← { "ok": true }
	  → { "action": "register-project", "subdomain": "myapp", "dir": "/path/to/project", "type": "php", "port": 3001 }
	  ← { "ok": true }
	  → { "action": "deregister", "subdomain": "myapp" }
	  ← { "ok": true }
	  → { "action": "list" }
	  ← { "ok": true, "routes": {...}, "projects": {...} }

	@license MIT
********************************************************/

import http from 'http';
import { createServer as createNetServer, connect as netConnect } from 'net';
import { createSocket } from 'dgram';
import { spawn, execFile } from 'child_process';
import { existsSync, unlinkSync, writeFileSync, readFileSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { deriveSubdomain } from './devproxy-cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const LISTEN_PORT = 80;
const SOCKET_PATH = join(__dirname, 'proxy.sock');
const PID_FILE = join(__dirname, 'proxy.pid');
const PROJECTS_FILE = join(__dirname, 'projects.json');

// How long (ms) before an auto-started server is killed for inactivity
const IDLE_TIMEOUT = 15 * 60 * 1000; // 15 minutes

// Robust PATH for spawned processes (LaunchDaemon has minimal PATH)
const FULL_PATH = [
	'/opt/homebrew/bin', '/opt/homebrew/sbin',
	'/usr/local/bin', '/usr/local/sbin',
	'/usr/bin', '/usr/sbin', '/bin', '/sbin',
	process.env.PATH || '',
].join(':');

// ═══════════════════ ROUTE TABLE ═══════════════════

const routes = new Map();    // subdomain → { port, name }
const projects = new Map();  // subdomain → { dir, type, port, command, name }
const managed = new Map();   // subdomain → { process, lastAccess, port }

// ═══════════════════ PROJECTS PERSISTENCE ═══════════════════

function loadProjects() {
	if (!existsSync(PROJECTS_FILE)) return;
	try {
		const data = JSON.parse(readFileSync(PROJECTS_FILE, 'utf-8'));
		for (const [sub, info] of Object.entries(data)) {
			projects.set(sub, info);
			// Pre-register route so proxy knows about it (server may not be running yet)
			if (!routes.has(sub)) {
				routes.set(sub, { port: info.port, name: info.name || sub, autostart: true });
			}
		}
		console.log(`[devproxy] loaded ${projects.size} project(s) from projects.json`);
	} catch (err) {
		console.error(`[devproxy] failed to load projects.json: ${err.message}`);
	}
}

function saveProjects() {
	const obj = {};
	for (const [k, v] of projects) obj[k] = v;
	try {
		writeFileSync(PROJECTS_FILE, JSON.stringify(obj, null, 2) + '\n');
	} catch (err) {
		console.error(`[devproxy] failed to save projects.json: ${err.message}`);
	}
}

// ═══════════════════ AUTO-START ═══════════════════

function detectCommand(project) {
	if (project.command) return project.command;

	const { dir, type, port } = project;

	if (type === 'php') {
		// Detect document root: public/ if exists, else dir itself
		const publicDir = join(dir, 'public');
		const docRoot = existsSync(publicDir) ? publicDir : dir;
		return { cmd: 'php', args: ['-S', `127.0.0.1:${port}`, '-t', docRoot] };
	}

	if (type === 'node') {
		// Check for common entry points
		const pkgPath = join(dir, 'package.json');
		if (existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
				if (pkg.scripts?.dev) {
					return { cmd: 'npm', args: ['run', 'dev'], env: { PORT: String(port) } };
				}
				if (pkg.scripts?.start) {
					return { cmd: 'npm', args: ['start'], env: { PORT: String(port) } };
				}
			} catch {}
		}
		// Fallback: look for common files
		for (const entry of ['start.js', 'server.js', 'index.js', 'app.js']) {
			if (existsSync(join(dir, entry))) {
				return { cmd: 'node', args: [entry], env: { PORT: String(port) } };
			}
		}
	}

	if (type === 'python') {
		return { cmd: 'python3', args: ['-m', 'http.server', String(port)], env: {} };
	}

	if (type === 'static') {
		// Use PHP as a simple static server
		return { cmd: 'php', args: ['-S', `127.0.0.1:${port}`, '-t', dir] };
	}

	return null;
}

function startServer(subdomain) {
	const project = projects.get(subdomain);
	if (!project) return false;

	// Already managed and running?
	const existing = managed.get(subdomain);
	if (existing && !existing.process.killed) {
		existing.lastAccess = Date.now();
		return true;
	}

	const commandInfo = detectCommand(project);
	if (!commandInfo) {
		console.error(`[devproxy] cannot determine start command for ${subdomain} (type: ${project.type})`);
		return false;
	}

	const { cmd, args, env: extraEnv } = commandInfo;
	console.log(`[devproxy] auto-starting ${subdomain}: ${cmd} ${args.join(' ')} (port ${project.port})`);

	const child = spawn(cmd, args, {
		cwd: project.dir,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, PATH: FULL_PATH, HOME: process.env.HOME || '', ...extraEnv },
		detached: false,
	});

	// Log stdout/stderr with prefix
	const prefix = `[${subdomain}]`;
	child.stdout?.on('data', (d) => {
		for (const line of d.toString().split('\n').filter(Boolean)) {
			console.log(`${prefix} ${line}`);
		}
	});
	child.stderr?.on('data', (d) => {
		for (const line of d.toString().split('\n').filter(Boolean)) {
			console.error(`${prefix} ${line}`);
		}
	});

	child.on('exit', (code) => {
		console.log(`[devproxy] ${subdomain} server exited (code ${code})`);
		managed.delete(subdomain);
	});

	child.on('error', (err) => {
		console.error(`[devproxy] ${subdomain} server error: ${err.message}`);
		managed.delete(subdomain);
	});

	managed.set(subdomain, {
		process: child,
		lastAccess: Date.now(),
		port: project.port,
	});

	// Update route to point to this port
	routes.set(subdomain, { port: project.port, name: project.name || subdomain, autostart: true });

	return true;
}

function stopServer(subdomain) {
	const info = managed.get(subdomain);
	if (!info) return false;
	try {
		info.process.kill('SIGTERM');
		console.log(`[devproxy] stopped ${subdomain} server`);
	} catch {}
	managed.delete(subdomain);
	return true;
}

// ═══════════════════ IDLE REAPER ═══════════════════

setInterval(() => {
	const now = Date.now();
	for (const [sub, info] of managed) {
		if (now - info.lastAccess > IDLE_TIMEOUT) {
			console.log(`[devproxy] killing idle server: ${sub} (inactive ${Math.round((now - info.lastAccess) / 60000)}min)`);
			stopServer(sub);
		}
	}
}, 60000); // check every minute

// ═══════════════════ LIVE DISCOVERY ═══════════════════

// A server started by hand (npm run dev, php artisan serve, rails s…) needs no
// registration: the proxy finds the process listening on a TCP port whose
// working directory is the project folder (or inside it) and routes
// <folder>.localhost to that port, on whichever address it listens.
const LSOF = '/usr/sbin/lsof';
const live = new Map(); // subdomain → Promise<{ host, port } | null>

function lsof(args) {
	return new Promise((resolve) => {
		execFile(LSOF, args, { timeout: 5000 }, (err, out) => resolve(out || ''));
	});
}

// "*:3000" / "127.0.0.1:5173" / "[::1]:5173" / "[::]:8000" → where to connect.
function listenAddress(name) {
	const m = name.match(/^(.*):(\d+)$/);
	if (!m) return null;
	const addr = m[1];
	const host = addr === '*' ? '127.0.0.1'
		: addr === '[::]' ? '::1'
		: addr.startsWith('[') ? addr.slice(1, -1)
		: addr;
	return { host, port: Number(m[2]) };
}

// How many folders up from cwd the one named after the subdomain sits; -1 if none.
function folderDepth(cwd, subdomain) {
	for (let dir = cwd, depth = 0; dir !== dirname(dir); dir = dirname(dir), depth++) {
		if (deriveSubdomain(dir) === subdomain) return depth;
	}
	return -1;
}

async function scanListeners(subdomain) {
	const listeners = [];
	let pid = 0;
	for (const line of (await lsof(['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'])).split('\n')) {
		if (line[0] === 'p') pid = Number(line.slice(1));
		if (line[0] !== 'n' || pid === process.pid) continue;
		const address = listenAddress(line.slice(1));
		if (address) listeners.push({ pid, ...address });
	}
	if (listeners.length === 0) return null;

	const cwdOf = new Map();
	const pids = [...new Set(listeners.map(l => l.pid))].join(',');
	for (const line of (await lsof(['-a', '-d', 'cwd', '-Fpn', '-p', pids])).split('\n')) {
		if (line[0] === 'p') pid = Number(line.slice(1));
		if (line[0] === 'n') cwdOf.set(pid, line.slice(1));
	}

	// Closest folder first (project/frontend beats project), then lowest port.
	const best = listeners
		.map(l => ({ ...l, depth: cwdOf.has(l.pid) ? folderDepth(cwdOf.get(l.pid), subdomain) : -1 }))
		.filter(l => l.depth >= 0)
		.sort((a, b) => a.depth - b.depth || a.port - b.port)[0];
	return best ? { host: best.host, port: best.port } : null;
}

// Cached until a connection to it fails; a miss is never cached.
function discover(subdomain) {
	let found = live.get(subdomain);
	if (!found) {
		found = scanListeners(subdomain).then((target) => {
			if (!target) live.delete(subdomain);
			return target;
		});
		live.set(subdomain, found);
	}
	return found;
}

// A live server wins; otherwise a registered route (Node module or autostart project).
async function targetFor(subdomain) {
	const found = await discover(subdomain);
	if (found) return found;
	const route = routes.get(subdomain);
	return route ? { host: '127.0.0.1', port: route.port } : null;
}

// ═══════════════════ HTTP SERVER ═══════════════════

// "myapp.localhost" → "myapp"
function subdomainOf(host) {
	const match = (host || '').match(/^([a-z0-9_-]+)\.localhost(:\d+)?$/i);
	return match ? match[1].toLowerCase() : null;
}

const httpServer = http.createServer((req, res) => {
	const host = req.headers.host || '';
	const subdomain = subdomainOf(host);

	if (!subdomain) {
		req.socket.destroy();
		return;
	}

	// Buffer request body for retries
	const bodyChunks = [];
	req.on('data', (chunk) => bodyChunks.push(chunk));
	req.on('end', async () => {
		const target = await targetFor(subdomain);

		if (!target) {
			// Check if it's a known project that needs auto-start
			if (projects.has(subdomain)) {
				startServer(subdomain);
				// Give the server a moment to boot, then retry
				res.writeHead(503, {
					'Content-Type': 'text/html; charset=utf-8',
					'Retry-After': '2',
					'Refresh': '2',
				});
				res.end(startingPage(subdomain));
				return;
			}

			res.writeHead(502, { 'Content-Type': 'text/plain' });
			res.end(`devproxy: no server running or registered for "${subdomain}.localhost"\nStart the server from a folder named "${subdomain}" (or "XXX.${subdomain}").\nRegistered: ${[...routes.keys()].join(', ') || '(none)'}`);
			return;
		}

		// Track activity for managed servers
		const info = managed.get(subdomain);
		if (info) info.lastAccess = Date.now();

		forwardWithRetry(req, res, subdomain, target, host, Buffer.concat(bodyChunks), 0);
	});
});

// Port 80 is open on every interface (no root needed), so only this Mac may use it.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
httpServer.on('connection', (socket) => {
	if (!LOOPBACK.has(socket.remoteAddress)) socket.destroy();
});

// WebSockets (hot reload, live apps): hand the raw connection to the same target.
httpServer.on('upgrade', async (req, socket, head) => {
	const subdomain = subdomainOf(req.headers.host);
	const target = subdomain && await targetFor(subdomain);
	if (!target) {
		socket.destroy();
		return;
	}
	const upstream = netConnect(target.port, target.host, () => {
		const headers = [];
		for (let i = 0; i < req.rawHeaders.length; i += 2) headers.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
		upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers.join('\r\n')}\r\n\r\n`);
		if (head.length) upstream.write(head);
		socket.pipe(upstream).pipe(socket);
	});
	upstream.on('error', () => { live.delete(subdomain); socket.destroy(); });
	socket.on('error', () => upstream.destroy());
});

// ═══════════════════ DNS (*.localhost → this Mac) ═══════════════════

// /etc/resolver/localhost sends every *.localhost lookup to 127.0.0.1:53; this
// answers it, so apps that do not special-case .localhost (node, php, python…)
// reach the proxy too. Port 53 on all interfaces needs no root; only this Mac
// gets answers. Anything that is not *.localhost is refused.
const DNS_PORT = 53;
const dnsServer = createSocket({ type: 'udp6', ipv6Only: false });

function dnsAnswer(query) {
	// Question name: length-prefixed labels from byte 12 up to a zero byte
	const labels = [];
	let i = 12;
	while (i < query.length && query[i] !== 0) {
		labels.push(query.toString('ascii', i + 1, i + 1 + query[i]));
		i += query[i] + 1;
	}
	const questionEnd = i + 5; // zero byte + type + class
	if (questionEnd > query.length) return null;
	const type = query.readUInt16BE(i + 1);
	const name = labels.join('.').toLowerCase();
	const ours = name === 'localhost' || name.endsWith('.localhost');
	const rdata = !ours ? null
		: type === 1 ? Buffer.from([127, 0, 0, 1])                            // A
		: type === 28 ? Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]) // AAAA
		: null;

	const header = Buffer.alloc(12);
	query.copy(header, 0, 0, 2);                                                  // same id
	header.writeUInt16BE(0x8400 | (query.readUInt16BE(2) & 0x0100) | (ours ? 0 : 5), 2); // answer, authoritative, RD echoed; REFUSED if not ours
	header.writeUInt16BE(1, 4);                                                   // one question
	header.writeUInt16BE(rdata ? 1 : 0, 6);                                       // answers
	const question = query.subarray(12, questionEnd);
	if (!rdata) return Buffer.concat([header, question]);

	const answer = Buffer.alloc(12);
	answer.writeUInt16BE(0xc00c, 0);       // name: pointer to the question
	answer.writeUInt16BE(type, 2);
	answer.writeUInt16BE(1, 4);            // class IN
	answer.writeUInt32BE(60, 6);           // TTL
	answer.writeUInt16BE(rdata.length, 10);
	return Buffer.concat([header, question, answer, rdata]);
}

dnsServer.on('message', (msg, rinfo) => {
	if (!LOOPBACK.has(rinfo.address) || msg.length < 17) return;
	const reply = dnsAnswer(msg);
	if (reply) dnsServer.send(reply, rinfo.port, rinfo.address);
});
dnsServer.on('error', (err) => console.error(`[devproxy] DNS on port ${DNS_PORT}: ${err.message}`));

// ═══════════════════ RETRY + AUTO-START ON FAILURE ═══════════════════

const RETRY_DELAYS = [500, 1000, 2000, 3000]; // more retries for auto-started servers

function forwardWithRetry(req, res, subdomain, target, host, body, attempt) {
	const options = {
		hostname: target.host,
		port: target.port,
		path: req.url,
		method: req.method,
		headers: {
			...req.headers,
			'x-forwarded-host': host,
			'x-forwarded-for': req.socket.remoteAddress,
			'content-length': body.length,
		},
	};

	const proxyReq = http.request(options, (proxyRes) => {
		res.writeHead(proxyRes.statusCode, proxyRes.headers);
		proxyRes.pipe(res, { end: true });
	});

	proxyReq.on('error', (err) => {
		const isRetryable = err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET';
		live.delete(subdomain); // the server moved or stopped: look again on the retry

		// If server not running and we know this project, auto-start it
		if (err.code === 'ECONNREFUSED' && attempt === 0 && projects.has(subdomain)) {
			const alreadyManaged = managed.has(subdomain);
			if (!alreadyManaged) {
				startServer(subdomain);
			}
		}

		if (isRetryable && attempt < RETRY_DELAYS.length) {
			const delay = RETRY_DELAYS[attempt];
			setTimeout(async () => {
				const next = await targetFor(subdomain) || target;
				forwardWithRetry(req, res, subdomain, next, host, body, attempt + 1);
			}, delay);
			return;
		}

		// All retries exhausted
		const retried = attempt > 0 ? ` (after ${attempt} retries)` : '';
		console.error(`[devproxy] upstream error: ${subdomain}.localhost → ${target.host}:${target.port} — ${err.message}${retried}`);
		res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
		res.end(errorPage(subdomain, target.port, err.message, attempt));
	});

	proxyReq.end(body);
}

// ═══════════════════ HTML PAGES ═══════════════════

function startingPage(subdomain) {
	const domain = `${subdomain}.localhost`;
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>devproxy — starting ${domain}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
         background: #1a1a2e; color: #e0e0e0; display: flex; justify-content: center; align-items: center;
         min-height: 100vh; padding: 2rem; }
  .card { background: #16213e; border: 1px solid #0f3460; border-radius: 12px; padding: 2.5rem;
          max-width: 520px; width: 100%; box-shadow: 0 8px 32px rgba(0,0,0,.4); text-align: center; }
  h1 { font-size: 1.1rem; color: #53a8b6; margin-bottom: 1rem; font-weight: 600; }
  .spinner { display: inline-block; width: 32px; height: 32px; border: 3px solid #0f3460;
             border-top-color: #53a8b6; border-radius: 50%; animation: spin 1s linear infinite; margin-bottom: 1rem; }
  @keyframes spin { to { transform: rotate(360deg); } }
  p { color: #a0a0b8; font-size: .9rem; }
</style>
</head>
<body>
<div class="card">
  <div class="spinner"></div>
  <h1>Starting ${domain}...</h1>
  <p>The server is booting up. This page will refresh automatically.</p>
</div>
</body>
</html>`;
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
      <li>The port <code>${port}</code> changed</li>
    </ul>
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

		if (cmd.action === 'register-project') {
			if (!cmd.subdomain || !cmd.dir || !cmd.type || !cmd.port) {
				return JSON.stringify({ ok: false, error: 'Missing subdomain, dir, type, or port' });
			}
			const sub = cmd.subdomain.toLowerCase();
			const project = {
				dir: cmd.dir,
				type: cmd.type,
				port: cmd.port,
				name: cmd.name || sub,
			};
			if (cmd.command) project.command = cmd.command;
			projects.set(sub, project);
			routes.set(sub, { port: cmd.port, name: project.name, autostart: true });
			saveProjects();
			console.log(`[devproxy] project registered: ${sub}.localhost → ${cmd.dir} (${cmd.type}, port ${cmd.port})`);
			return JSON.stringify({ ok: true, subdomain: sub, url: `http://${sub}.localhost` });
		}

		if (cmd.action === 'deregister') {
			if (!cmd.subdomain) {
				return JSON.stringify({ ok: false, error: 'Missing subdomain' });
			}
			const sub = cmd.subdomain.toLowerCase();
			const had = routes.delete(sub);
			// Also stop managed server if running
			stopServer(sub);
			if (had) console.log(`[devproxy] deregistered: ${sub}.localhost`);
			return JSON.stringify({ ok: true, removed: had });
		}

		if (cmd.action === 'remove-project') {
			if (!cmd.subdomain) {
				return JSON.stringify({ ok: false, error: 'Missing subdomain' });
			}
			const sub = cmd.subdomain.toLowerCase();
			stopServer(sub);
			routes.delete(sub);
			const had = projects.delete(sub);
			if (had) saveProjects();
			console.log(`[devproxy] project removed: ${sub}.localhost`);
			return JSON.stringify({ ok: true, removed: had });
		}

		if (cmd.action === 'start') {
			if (!cmd.subdomain) {
				return JSON.stringify({ ok: false, error: 'Missing subdomain' });
			}
			const sub = cmd.subdomain.toLowerCase();
			if (!projects.has(sub)) {
				return JSON.stringify({ ok: false, error: `Unknown project: ${sub}` });
			}
			const started = startServer(sub);
			return JSON.stringify({ ok: started, subdomain: sub });
		}

		if (cmd.action === 'stop') {
			if (!cmd.subdomain) {
				return JSON.stringify({ ok: false, error: 'Missing subdomain' });
			}
			const sub = cmd.subdomain.toLowerCase();
			const stopped = stopServer(sub);
			return JSON.stringify({ ok: stopped });
		}

		if (cmd.action === 'list') {
			const routesObj = {};
			for (const [k, v] of routes) {
				routesObj[k] = {
					port: v.port,
					name: v.name,
					running: managed.has(k) && !managed.get(k).process.killed,
					autostart: !!v.autostart,
				};
			}
			const projectsObj = {};
			for (const [k, v] of projects) projectsObj[k] = v;
			return JSON.stringify({ ok: true, routes: routesObj, projects: projectsObj });
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
	socket.on('error', () => {});
});

// ═══════════════════ STARTUP ═══════════════════

function cleanup() {
	try { unlinkSync(SOCKET_PATH); } catch {}
	try { unlinkSync(PID_FILE); } catch {}
}

function shutdown() {
	console.log('\n[devproxy] shutting down...');
	// Stop all managed servers
	for (const [sub] of managed) {
		stopServer(sub);
	}
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

// Load persisted projects
loadProjects();

// Start control socket
controlServer.listen(SOCKET_PATH, () => {
	chmodSync(SOCKET_PATH, 0o777);
	console.log(`[devproxy] control socket: ${SOCKET_PATH}`);
});

// Start HTTP server on port 80 (all interfaces: macOS binds that without root;
// 127.0.0.1:80 alone would need it). Remote connections are closed above.
httpServer.listen(LISTEN_PORT, () => {
	console.log(`[devproxy] listening on *:${LISTEN_PORT} (local connections only)`);
	console.log(`[devproxy] ready — ${projects.size} project(s) loaded`);
});

// DNS for *.localhost (all interfaces, same rule as port 80; local queries only)
dnsServer.bind(DNS_PORT, '::', () => {
	console.log(`[devproxy] DNS on *:${DNS_PORT} (*.localhost → 127.0.0.1 / ::1, local queries only)`);
});
