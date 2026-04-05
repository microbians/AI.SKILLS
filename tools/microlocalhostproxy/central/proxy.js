#!/usr/bin/env node
/********************************************************
	DEVPROXY - Central Reverse Proxy

	Routes *.localhost requests to registered project servers.
	Listens directly on port 80 (no pfctl needed).
	Drops root privileges after binding to port 80.
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
import { createServer as createNetServer } from 'net';
import { spawn } from 'child_process';
import { existsSync, unlinkSync, writeFileSync, readFileSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

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

// ═══════════════════ HTTP SERVER ═══════════════════

const httpServer = http.createServer((req, res) => {
	const host = req.headers.host || '';
	// Extract subdomain: "myapp.localhost" → "myapp"
	const match = host.match(/^([a-z0-9_-]+)\.localhost(:\d+)?$/i);

	if (!match) {
		req.socket.destroy();
		return;
	}

	const subdomain = match[1].toLowerCase();
	const route = routes.get(subdomain);

	if (!route) {
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
		res.end(`devproxy: no server registered for "${subdomain}.localhost"\nRegistered: ${[...routes.keys()].join(', ') || '(none)'}`);
		return;
	}

	// Track activity for managed servers
	const info = managed.get(subdomain);
	if (info) info.lastAccess = Date.now();

	// Buffer request body for retries
	const bodyChunks = [];
	req.on('data', (chunk) => bodyChunks.push(chunk));
	req.on('end', () => {
		const body = Buffer.concat(bodyChunks);
		forwardWithRetry(req, res, subdomain, route, host, body, 0);
	});
});

// ═══════════════════ RETRY + AUTO-START ON FAILURE ═══════════════════

const RETRY_DELAYS = [500, 1000, 2000, 3000]; // more retries for auto-started servers

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
			'content-length': body.length,
		},
	};

	const proxyReq = http.request(options, (proxyRes) => {
		res.writeHead(proxyRes.statusCode, proxyRes.headers);
		proxyRes.pipe(res, { end: true });
	});

	proxyReq.on('error', (err) => {
		const isRetryable = err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET';

		// If server not running and we know this project, auto-start it
		if (err.code === 'ECONNREFUSED' && attempt === 0 && projects.has(subdomain)) {
			const alreadyManaged = managed.has(subdomain);
			if (!alreadyManaged) {
				startServer(subdomain);
			}
		}

		if (isRetryable && attempt < RETRY_DELAYS.length) {
			const delay = RETRY_DELAYS[attempt];
			setTimeout(() => {
				forwardWithRetry(req, res, subdomain, route, host, body, attempt + 1);
			}, delay);
			return;
		}

		// All retries exhausted
		const retried = attempt > 0 ? ` (after ${attempt} retries)` : '';
		console.error(`[devproxy] upstream error: ${subdomain}.localhost:${route.port} — ${err.message}${retried}`);
		res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
		res.end(errorPage(subdomain, route.port, err.message, attempt));
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

	console.log(`[devproxy] ready — ${projects.size} project(s) loaded`);
});
