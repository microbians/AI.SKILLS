#!/usr/bin/env node
/********************************************************
	DEVPROXY CLIENT — Zero-config local subdomain routing

	Works in two modes:

	1. CLI (any project — PHP, Node, Python, static):
	   $ devproxy                  # auto-detect everything from cwd
	   $ devproxy --port 8000      # override port
	   $ devproxy --subdomain foo  # override subdomain
	   $ devproxy list             # show all registered projects
	   $ devproxy stop foo         # stop a running server
	   $ devproxy remove foo       # remove project from registry

	2. Module (Node.js projects):
	   import { devproxy } from './lib/devproxy.js';
	   devproxy({ port: 3001 });

	Auto-detection:
	  - Subdomain: derived from directory name
	    - "LAB.Imager" → "imager", "MICRO.AutoMkt" → "automkt", "pepe" → "pepe"
	  - Type: composer.json/index.php → php, package.json → node, *.py → python
	  - Port: finds a free port starting from 8000 (php) or 3000 (node)

	@license MIT
********************************************************/

import { connect, createServer } from 'net';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, dirname, basename, resolve } from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const DEVPROXY_DIR = join(homedir(), '.config', 'devproxy');
const SOCKET_PATH = join(DEVPROXY_DIR, 'proxy.sock');
const PID_FILE = join(DEVPROXY_DIR, 'proxy.pid');
const PROXY_JS = join(DEVPROXY_DIR, 'proxy.js');
const INSTALL_SH = join(DEVPROXY_DIR, 'install.sh');
const INSTALLED_MARKER = join(DEVPROXY_DIR, '.installed');

// ═══════════════════ HELPERS ═══════════════════

function deriveSubdomain(dir) {
	const name = basename(dir);
	// "LAB.Imager" → "imager", "MICRO.AutoMkt" → "automkt"
	const part = name.includes('.') ? name.split('.').pop() : name;
	return part.toLowerCase().replace(/[^a-z0-9-]/g, '');
}

function detectProjectType(dir) {
	if (existsSync(join(dir, 'composer.json'))) return 'php';
	if (existsSync(join(dir, 'index.php'))) return 'php';
	if (existsSync(join(dir, 'public', 'index.php'))) return 'php';
	if (existsSync(join(dir, 'artisan'))) return 'php'; // Laravel
	if (existsSync(join(dir, 'package.json'))) return 'node';
	if (existsSync(join(dir, 'requirements.txt'))) return 'python';
	if (existsSync(join(dir, 'pyproject.toml'))) return 'python';
	try {
		const files = readdirSync(dir);
		if (files.some(f => f.endsWith('.py'))) return 'python';
		if (files.some(f => f.endsWith('.html'))) return 'static';
	} catch {}
	return 'static'; // fallback
}

function defaultBasePort(type) {
	if (type === 'php') return 8000;
	if (type === 'node') return 3000;
	if (type === 'python') return 8000;
	return 8080;
}

function isPortFree(port) {
	return new Promise((resolve) => {
		const srv = createServer();
		srv.once('error', () => resolve(false));
		srv.once('listening', () => { srv.close(); resolve(true); });
		srv.listen(port);
	});
}

async function findFreePort(base) {
	for (let i = 0; i <= 20; i++) {
		if (await isPortFree(base + i)) return base + i;
	}
	return base; // fallback
}

function readPackageName() {
	let dir = process.cwd();
	while (dir !== dirname(dir)) {
		const pkgPath = join(dir, 'package.json');
		if (existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
				return pkg.name || null;
			} catch { return null; }
		}
		dir = dirname(dir);
	}
	return null;
}

function askSubdomain() {
	try {
		const result = execSync(
			'osascript -e \'text returned of (display dialog '
			+ '"Enter the subdomain for this project.\\n\\n'
			+ 'Example: myproject → http://myproject.localhost" '
			+ 'default answer "" '
			+ 'with title "devproxy" '
			+ 'buttons {"Cancel", "OK"} default button "OK")\'',
			{ encoding: 'utf-8' }
		).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
		return result || null;
	} catch { return null; }
}

function isProxyRunning() {
	if (!existsSync(PID_FILE)) return false;
	try {
		const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
		if (isNaN(pid)) return false;
		process.kill(pid, 0);
		return true;
	} catch { return false; }
}

function sendCommand(cmd) {
	return new Promise((resolve, reject) => {
		if (!existsSync(SOCKET_PATH)) {
			reject(new Error('Socket not found'));
			return;
		}
		const socket = connect(SOCKET_PATH);
		let buffer = '';
		socket.on('connect', () => {
			socket.write(JSON.stringify(cmd) + '\n');
		});
		socket.on('data', (data) => {
			buffer += data.toString();
			const nl = buffer.indexOf('\n');
			if (nl !== -1) {
				try { resolve(JSON.parse(buffer.slice(0, nl))); }
				catch (err) { reject(err); }
				socket.end();
			}
		});
		socket.on('error', reject);
		socket.setTimeout(5000, () => {
			socket.destroy();
			reject(new Error('Timeout'));
		});
	});
}

const PLIST_PATH = '/Library/LaunchDaemons/com.devproxy.proxy.plist';

function startProxy() {
	return new Promise((resolve, reject) => {
		if (!existsSync(PLIST_PATH)) {
			reject(new Error('LaunchDaemon not installed — run install.sh first'));
			return;
		}
		try {
			execSync(
				`osascript -e 'do shell script `
				+ `"launchctl unload ${PLIST_PATH} 2>/dev/null; `
				+ `sleep 1; `
				+ `launchctl load ${PLIST_PATH}" `
				+ `with administrator privileges'`,
				{ stdio: 'ignore', timeout: 30000 }
			);
		} catch {
			reject(new Error('Could not start proxy (authentication cancelled or failed)'));
			return;
		}
		let attempts = 0;
		const check = setInterval(() => {
			attempts++;
			if (existsSync(SOCKET_PATH)) {
				clearInterval(check);
				setTimeout(() => resolve(), 200);
			} else if (attempts > 50) {
				clearInterval(check);
				reject(new Error('Proxy failed to start (socket not created after 5s)'));
			}
		}, 100);
	});
}

function ensureInstalled() {
	if (existsSync(INSTALLED_MARKER)) return true;
	if (!existsSync(INSTALL_SH)) {
		console.error('\n  devproxy: install.sh not found at ' + INSTALL_SH);
		console.error('  Run the devproxy setup first.\n');
		return false;
	}
	console.log('\n  devproxy: first-time setup — installing system components...\n');
	try {
		execSync(`bash "${INSTALL_SH}"`, { stdio: 'inherit' });
		return existsSync(INSTALLED_MARKER);
	} catch (err) {
		console.error('\n  devproxy: installation failed:', err.message);
		return false;
	}
}

function ensureProxyFiles() {
	if (!existsSync(DEVPROXY_DIR)) {
		execSync(`mkdir -p "${DEVPROXY_DIR}"`);
	}
	if (!existsSync(PROXY_JS)) {
		console.error('\n  devproxy: proxy.js not found at ' + PROXY_JS);
		console.error('  Extract the devproxy files to ~/.config/devproxy/ first.\n');
		return false;
	}
	return true;
}

async function ensureProxy() {
	if (!ensureProxyFiles()) return false;
	if (!ensureInstalled()) return false;
	if (!isProxyRunning()) {
		try {
			await startProxy();
		} catch (err) {
			console.error('  devproxy: failed to start proxy —', err.message);
			return false;
		}
	}
	return true;
}

// ═══════════════════ PUBLIC API (Module mode) ═══════════════════

/**
 * Register this project's dev server with devproxy.
 *
 * @param {Object} opts
 * @param {number} opts.port - The port your dev server listens on
 * @param {string} [opts.subdomain] - Override subdomain (default: package.json name)
 * @param {string} [opts.name] - Display name for the project
 */
export async function devproxy({ port, subdomain, name } = {}) {
	if (!port) {
		console.error('  devproxy: port is required');
		return;
	}

	const sub = subdomain || readPackageName() || askSubdomain();
	if (!sub) {
		console.error('  devproxy: no subdomain provided (cancelled)');
		return;
	}

	if (!(await ensureProxy())) return;

	try {
		const displayName = name || readPackageName() || sub;
		const res = await sendCommand({ action: 'register', subdomain: sub, port, name: displayName });
		if (res.ok) {
			console.log(`  http://${sub}.localhost\n`);
		} else {
			console.error('  devproxy: registration failed —', res.error);
		}
	} catch (err) {
		console.error('  devproxy: could not register —', err.message);
	}

	function deregister() {
		try {
			const socket = connect(SOCKET_PATH);
			socket.write(JSON.stringify({ action: 'deregister', subdomain: sub }) + '\n');
			socket.end();
		} catch {}
	}

	process.on('SIGINT', () => { deregister(); process.exit(0); });
	process.on('SIGTERM', () => { deregister(); process.exit(0); });
	process.on('exit', deregister);
}

// ═══════════════════ CLI MODE ═══════════════════

async function cli() {
	const args = process.argv.slice(2);
	const command = args[0] || 'register';

	// ── List ──
	if (command === 'list' || command === 'ls') {
		if (!(await ensureProxy())) process.exit(1);
		const res = await sendCommand({ action: 'list' });
		if (!res.ok) { console.error('Error:', res.error); process.exit(1); }

		const routes = res.routes || {};
		const entries = Object.entries(routes);
		if (entries.length === 0) {
			console.log('  No projects registered.');
		} else {
			console.log('');
			for (const [sub, info] of entries) {
				const status = info.running ? '\x1b[32m●\x1b[0m' : '\x1b[90m○\x1b[0m';
				const autoTag = info.autostart ? ' [auto]' : '';
				console.log(`  ${status} http://${sub}.localhost → :${info.port} (${info.name})${autoTag}`);
			}
			console.log('');
		}
		process.exit(0);
	}

	// ── Stop ──
	if (command === 'stop') {
		const sub = args[1];
		if (!sub) { console.error('Usage: devproxy stop <subdomain>'); process.exit(1); }
		if (!(await ensureProxy())) process.exit(1);
		const res = await sendCommand({ action: 'stop', subdomain: sub });
		console.log(res.ok ? `  ✓ Stopped ${sub}.localhost` : `  ✗ ${res.error}`);
		process.exit(res.ok ? 0 : 1);
	}

	// ── Remove ──
	if (command === 'remove' || command === 'rm') {
		const sub = args[1];
		if (!sub) { console.error('Usage: devproxy remove <subdomain>'); process.exit(1); }
		if (!(await ensureProxy())) process.exit(1);
		const res = await sendCommand({ action: 'remove-project', subdomain: sub });
		console.log(res.ok ? `  ✓ Removed ${sub}.localhost` : `  ✗ ${res.error}`);
		process.exit(res.ok ? 0 : 1);
	}

	// ── Start (explicit) ──
	if (command === 'start') {
		const sub = args[1];
		if (!sub) { console.error('Usage: devproxy start <subdomain>'); process.exit(1); }
		if (!(await ensureProxy())) process.exit(1);
		const res = await sendCommand({ action: 'start', subdomain: sub });
		console.log(res.ok ? `  ✓ Started ${sub}.localhost` : `  ✗ ${res.error}`);
		process.exit(res.ok ? 0 : 1);
	}

	// ── Register (default — auto-detect from cwd) ──
	if (command === 'register' || !['list', 'ls', 'stop', 'remove', 'rm', 'start', 'help'].includes(command)) {
		// Parse flags
		let subdomain = null;
		let port = null;
		let name = null;
		let type = null;
		let dir = process.cwd();

		for (let i = (command === 'register' ? 1 : 0); i < args.length; i++) {
			if (args[i] === '--subdomain' || args[i] === '-s') { subdomain = args[++i]; continue; }
			if (args[i] === '--port' || args[i] === '-p') { port = parseInt(args[++i], 10); continue; }
			if (args[i] === '--name' || args[i] === '-n') { name = args[++i]; continue; }
			if (args[i] === '--type' || args[i] === '-t') { type = args[++i]; continue; }
			if (args[i] === '--dir' || args[i] === '-d') { dir = resolve(args[++i]); continue; }
		}

		// Auto-detect
		if (!subdomain) subdomain = deriveSubdomain(dir);
		if (!type) type = detectProjectType(dir);
		if (!port) port = await findFreePort(defaultBasePort(type));
		if (!name) name = subdomain;

		if (!(await ensureProxy())) process.exit(1);

		const res = await sendCommand({
			action: 'register-project',
			subdomain,
			dir,
			type,
			port,
			name,
		});

		if (res.ok) {
			console.log(`\n  ✓ ${name} registered`);
			console.log(`    URL:  http://${subdomain}.localhost`);
			console.log(`    Dir:  ${dir}`);
			console.log(`    Type: ${type}`);
			console.log(`    Port: ${port}\n`);
		} else {
			console.error(`  ✗ ${res.error}`);
			process.exit(1);
		}
		process.exit(0);
	}

	// ── Help ──
	console.log(`
  devproxy — zero-config local subdomain routing

  Usage:
    devproxy                          Register current directory (auto-detect)
    devproxy --port 8000              Register with specific port
    devproxy --subdomain foo          Register with specific subdomain
    devproxy list                     Show all registered projects
    devproxy start <subdomain>        Start a project's server
    devproxy stop <subdomain>         Stop a project's server
    devproxy remove <subdomain>       Remove a project from registry
    devproxy help                     Show this help

  Flags:
    -s, --subdomain <name>    Override subdomain
    -p, --port <number>       Override port
    -n, --name <name>         Display name
    -t, --type <type>         Project type (php, node, python, static)
    -d, --dir <path>          Project directory (default: cwd)
`);
	process.exit(0);
}

// ═══════════════════ ENTRY POINT ═══════════════════

// Detect if running as CLI (executed directly) vs imported as module
const __filename = fileURLToPath(import.meta.url);
const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(__filename);

if (isDirectRun) {
	cli().catch((err) => {
		console.error('  devproxy error:', err.message);
		process.exit(1);
	});
}
