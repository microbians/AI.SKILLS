/********************************************************
	DEVPROXY CLIENT — Drop-in local subdomain routing
	
	Import in any project's dev launcher to get a clean
	subdomain URL like "myproject.localhost" instead of
	"localhost:3001".
	
	Usage:
	  import { devproxy } from './lib/devproxy.js';
	  // ... create your server on some port ...
	  devproxy({ port: 3001 }); // subdomain from package.json "name"
	
	First run: auto-installs dnsmasq, resolver, LaunchDaemon.
	Subsequent runs: just registers and serves.
	
	@license MIT
********************************************************/

import { connect } from 'net';
import { existsSync, readFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
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

function readPackageName() {
	// Walk up from the calling module's directory to find package.json
	// Since we don't know the caller's path, use process.cwd()
	let dir = process.cwd();
	while (dir !== dirname(dir)) {
		const pkgPath = join(dir, 'package.json');
		if (existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
				return pkg.name || null;
			} catch {
				return null;
			}
		}
		dir = dirname(dir);
	}
	return null;
}

function askSubdomain() {
	// Ask the user for a subdomain via native macOS dialog
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
	} catch {
		// User cancelled
		return null;
	}
}

function isProxyRunning() {
	if (!existsSync(PID_FILE)) return false;
	try {
		const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
		if (isNaN(pid)) return false;
		process.kill(pid, 0); // signal 0 = check if alive
		return true;
	} catch {
		return false;
	}
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
				try {
					resolve(JSON.parse(buffer.slice(0, nl)));
				} catch (err) {
					reject(err);
				}
				socket.end();
			}
		});
		socket.on('error', reject);
		socket.setTimeout(3000, () => {
			socket.destroy();
			reject(new Error('Timeout'));
		});
	});
}

const PLIST_PATH = '/Library/LaunchDaemons/com.devproxy.proxy.plist';

function startProxy() {
	return new Promise((resolve, reject) => {
		// The proxy runs as a LaunchDaemon on port 80 (requires root).
		// Try to reload it via launchctl. If the plist exists, use osascript
		// to get admin privileges via native macOS dialog.
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

		// Wait for socket to appear (proxy is ready)
		let attempts = 0;
		const check = setInterval(() => {
			attempts++;
			if (existsSync(SOCKET_PATH)) {
				clearInterval(check);
				// Small extra delay to ensure socket is listening
				setTimeout(() => resolve(), 200);
			} else if (attempts > 50) { // 5 seconds
				clearInterval(check);
				reject(new Error('Proxy failed to start (socket not created after 5s)'));
			}
		}, 100);
	});
}

function ensureInstalled() {
	// Check if devproxy infrastructure is installed
	if (existsSync(INSTALLED_MARKER)) return true;

	// Check if install script exists
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
	// Check that proxy.js and install.sh exist in DEVPROXY_DIR
	// If not, this is a fresh machine — copy them from our bundled copies
	if (!existsSync(DEVPROXY_DIR)) {
		execSync(`mkdir -p "${DEVPROXY_DIR}"`);
	}

	// The proxy.js and install.sh should already be at DEVPROXY_DIR
	// (placed there by copying central/ files from the repo)
	// If they're missing, we can't proceed
	if (!existsSync(PROXY_JS)) {
		console.error('\n  devproxy: proxy.js not found at ' + PROXY_JS);
		console.error('  Extract the devproxy files to ~/.config/devproxy/ first.\n');
		return false;
	}
	return true;
}

// ═══════════════════ PUBLIC API ═══════════════════

/**
 * Register this project's dev server with devproxy.
 * 
 * @param {Object} opts
 * @param {number} opts.port - The port your dev server listens on
 * @param {string} [opts.subdomain] - Override subdomain (default: package.json name)
 */
export async function devproxy({ port, subdomain } = {}) {
	if (!port) {
		console.error('  devproxy: port is required');
		return;
	}

	// Resolve subdomain: explicit > package.json > ask user
	const sub = subdomain || readPackageName() || askSubdomain();
	if (!sub) {
		console.error('  devproxy: no subdomain provided (cancelled)');
		return;
	}

	// Ensure proxy infrastructure files exist
	if (!ensureProxyFiles()) return;

	// Ensure system-level components are installed (first time only)
	if (!ensureInstalled()) return;

	// Ensure proxy process is running
	if (!isProxyRunning()) {
		try {
			await startProxy();
		} catch (err) {
			console.error('  devproxy: failed to start proxy —', err.message);
			return;
		}
	}

	// Register our subdomain
	try {
		const res = await sendCommand({ action: 'register', subdomain: sub, port });
		if (res.ok) {
			console.log(`  http://${sub}.localhost\n`);
		} else {
			console.error('  devproxy: registration failed —', res.error);
		}
	} catch (err) {
		console.error('  devproxy: could not register —', err.message);
	}

	// Deregister on exit
	function deregister() {
		try {
			// Sync deregister — we're shutting down
			const socket = connect(SOCKET_PATH);
			socket.write(JSON.stringify({ action: 'deregister', subdomain: sub }) + '\n');
			socket.end();
		} catch {
			// Best-effort
		}
	}

	process.on('SIGINT', () => { deregister(); process.exit(0); });
	process.on('SIGTERM', () => { deregister(); process.exit(0); });
	process.on('exit', deregister);
}
