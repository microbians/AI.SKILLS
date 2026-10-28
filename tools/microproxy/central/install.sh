#!/bin/bash
#################################################################
# DEVPROXY - One-time installation script
#
# Installs everything needed for *.localhost subdomain routing:
#   1. /etc/resolver/localhost — sends *.localhost lookups to 127.0.0.1:53,
#      where the proxy itself answers (no dnsmasq)
#   2. LaunchAgent "microproxy" — runs proxy.js at login, as the user
#      (macOS lets a user bind ports 80 and 53 on all interfaces; the
#      proxy only answers this Mac)
#
# Removes what earlier versions installed: the root LaunchDaemon and the
# dnsmasq service (dnsmasq itself stays installed).
#
# Also cleans up legacy pfctl-based installations if present.
#
# Uses native macOS SecurityAgent dialog for authentication.
# No terminal required — works from any context.
#
# @license MIT
#################################################################

set -euo pipefail

DEVPROXY_DIR="$HOME/.config/devproxy"
PROXY_JS="$DEVPROXY_DIR/proxy.js"
RESOLVER_DIR="/etc/resolver"
RESOLVER_PATH="/etc/resolver/localhost"

# LaunchAgent (runs node proxy.js as the user, no root)
PLIST_LABEL="com.devproxy.proxy"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
GUI_DOMAIN="gui/$(id -u)"

# Legacy root LaunchDaemon (versions that bound 127.0.0.1:80 as root)
LEGACY_DAEMON_PLIST="/Library/LaunchDaemons/${PLIST_LABEL}.plist"

# Legacy pfctl files to clean up
LEGACY_PFCTL_PLIST="/Library/LaunchDaemons/com.devproxy.pfctl.plist"
LEGACY_PF_ANCHOR="/etc/pf.anchors/com.devproxy"
LEGACY_SUDOERS="/etc/sudoers.d/devproxy"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
skip() { echo -e "  ${YELLOW}—${NC} $1 (already done)"; }
fail() { echo -e "  ${RED}✗${NC} $1"; exit 1; }

# Run a command as root via native macOS SecurityAgent dialog
run_as_admin() {
	local cmd="$1"
	local escaped
	escaped=$(printf '%s' "$cmd" | sed 's/\\/\\\\/g; s/"/\\"/g')
	osascript -e "do shell script \"${escaped}\" with administrator privileges" 2>/dev/null
}

echo ""
echo "  devproxy installer"
echo "  ===================="
echo ""

# ═══════════════════ FILES ═══════════════════

# Run from the repo (bash tools/microproxy/central/install.sh): copy the
# proxy, its CLI (proxy.js imports it) and this installer into place first.
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
CLIENT_JS="$SRC_DIR/../client/devproxy.js"
DEST_CLI="$DEVPROXY_DIR/devproxy-cli.js"
mkdir -p "$DEVPROXY_DIR"
if [ "$SRC_DIR" != "$DEVPROXY_DIR" ] && [ -f "$SRC_DIR/proxy.js" ]; then
	cp "$SRC_DIR/proxy.js" "$SRC_DIR/package.json" "$SRC_DIR/install.sh" "$DEVPROXY_DIR/"
	ok "proxy copied to $DEVPROXY_DIR"
fi
if [ -f "$CLIENT_JS" ]; then
	cp "$CLIENT_JS" "$DEST_CLI"
	chmod +x "$DEST_CLI"
	ok "CLI copied to $DEST_CLI"
fi

if [ ! -f "$PROXY_JS" ] || [ ! -f "$DEST_CLI" ]; then
	fail "proxy.js or devproxy-cli.js missing in $DEVPROXY_DIR — run install.sh from the repo (tools/microproxy/central/)"
fi

echo "  This will configure local subdomain routing (*.localhost)."
echo "  Missing dependencies will be installed automatically."
echo ""

# ═══════════════════ 0a. NODE.JS ═══════════════════

if ! command -v node &>/dev/null; then
	echo "  [0a] Node.js"
	echo "  Installing Node.js via official macOS installer..."
	NODE_PKG_URL="https://nodejs.org/dist/v22.14.0/node-v22.14.0.pkg"
	NODE_PKG_TMP="/tmp/node-installer.pkg"
	curl -fsSL "$NODE_PKG_URL" -o "$NODE_PKG_TMP"
	run_as_admin "installer -pkg ${NODE_PKG_TMP} -target /"
	rm -f "$NODE_PKG_TMP"
	if command -v node &>/dev/null; then
		ok "Node.js $(node -v) installed"
	else
		export PATH="/usr/local/bin:$PATH"
		if command -v node &>/dev/null; then
			ok "Node.js $(node -v) installed"
		else
			fail "Node.js installation failed"
		fi
	fi
fi

# ═══════════════════ COLLECT ADMIN TASKS ═══════════════════
# Build a single script with all commands that need root.
# The user sees ONE native macOS auth dialog for everything.

echo ""
echo "  Preparing system changes..."

ADMIN_SCRIPT=""

# ── Stop the dnsmasq service earlier versions set up: it holds port 53 ──
# Only while it runs with our line in its config; the dnsmasq package is left alone.
if command -v brew &>/dev/null && grep -q "^address=/localhost/127.0.0.1$" "$(brew --prefix)/etc/dnsmasq.conf" 2>/dev/null \
	&& brew services list 2>/dev/null | grep -q '^dnsmasq .*started'; then
	ADMIN_SCRIPT+="$(brew --prefix)/bin/brew services stop dnsmasq 2>/dev/null || true; "
	ok "will stop the old dnsmasq service (the proxy answers DNS now)"
fi

# ── resolver ──
echo "  [1/2] macOS resolver"
if [ -f "$RESOLVER_PATH" ] && grep -q "nameserver 127.0.0.1" "$RESOLVER_PATH" 2>/dev/null; then
	skip "resolver already configured"
else
	ADMIN_SCRIPT+="mkdir -p ${RESOLVER_DIR}; "
	ADMIN_SCRIPT+="echo 'nameserver 127.0.0.1' > ${RESOLVER_PATH}; "
fi

# ── Clean up legacy pfctl installation ──
echo ""
echo "  Cleaning up legacy pfctl (if present)..."

# Unload and remove legacy pfctl LaunchDaemon
if [ -f "$LEGACY_PFCTL_PLIST" ]; then
	ADMIN_SCRIPT+="launchctl unload ${LEGACY_PFCTL_PLIST} 2>/dev/null || true; "
	ADMIN_SCRIPT+="rm -f ${LEGACY_PFCTL_PLIST}; "
	ok "will remove legacy pfctl LaunchDaemon"
else
	skip "no legacy pfctl LaunchDaemon"
fi

# Remove pfctl anchor file
if [ -f "$LEGACY_PF_ANCHOR" ]; then
	ADMIN_SCRIPT+="rm -f ${LEGACY_PF_ANCHOR}; "
	ok "will remove pfctl anchor file"
else
	skip "no pfctl anchor file"
fi

# Remove devproxy entries from pf.conf (rdr-anchor and load anchor lines)
if grep -q "com.devproxy" /etc/pf.conf 2>/dev/null; then
	ADMIN_SCRIPT+="cp /etc/pf.conf /etc/pf.conf.devproxy-cleanup-backup; "
	ADMIN_SCRIPT+="sed -i '' '/com\\.devproxy/d' /etc/pf.conf; "
	# Flush any active pfctl rules for our anchor
	ADMIN_SCRIPT+="/sbin/pfctl -a com.devproxy -F all 2>/dev/null || true; "
	ok "will clean pf.conf of devproxy entries"
else
	skip "pf.conf already clean"
fi

# Remove legacy sudoers rule (was for pfctl)
if [ -f "$LEGACY_SUDOERS" ]; then
	ADMIN_SCRIPT+="rm -f ${LEGACY_SUDOERS}; "
	ok "will remove legacy pfctl sudoers rule"
else
	skip "no legacy sudoers rule"
fi

# ── Remove the old root LaunchDaemon (it would hold port 80 at boot) ──
if [ -f "$LEGACY_DAEMON_PLIST" ]; then
	ADMIN_SCRIPT+="launchctl unload ${LEGACY_DAEMON_PLIST} 2>/dev/null || true; "
	ADMIN_SCRIPT+="rm -f ${LEGACY_DAEMON_PLIST}; "
	ADMIN_SCRIPT+="kill \$(cat ${DEVPROXY_DIR}/proxy.pid 2>/dev/null) 2>/dev/null || true; "
	ok "will remove the old root LaunchDaemon"
fi

# ═══════════════════ EXECUTE WITH ONE AUTH DIALOG ═══════════════════

if [ -n "$ADMIN_SCRIPT" ]; then
	echo ""
	echo "  Requesting authentication..."
	echo ""

	if run_as_admin "$ADMIN_SCRIPT"; then
		ok "system changes applied"
	else
		fail "authentication cancelled or failed"
	fi
else
	skip "no system changes needed"
fi

# ── LaunchAgent for proxy.js on ports 80 + 53 (user, no root) ──
echo ""
echo "  [2/2] LaunchAgent (proxy on ports 80 and 53)"

# Resolve the full path to node
NODE_PATH="$(which node)"

# macOS lists a background item by the name of the program it runs: start
# node through a launcher named "microproxy" so it does not show as "node".
LAUNCHER="$DEVPROXY_DIR/microproxy"
cat > "$LAUNCHER" <<'LAUNCHEREOF'
#!/bin/bash
# Started by the LaunchAgent with node's path as $1; named so macOS shows "microproxy".
exec "$1" "$(dirname "$0")/proxy.js"
LAUNCHEREOF
chmod +x "$LAUNCHER"

mkdir -p "$(dirname "$PLIST_PATH")"
cat > "$PLIST_PATH" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${PLIST_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${LAUNCHER}</string>
		<string>${NODE_PATH}</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>${DEVPROXY_DIR}/proxy.log</string>
	<key>StandardErrorPath</key>
	<string>${DEVPROXY_DIR}/proxy.log</string>
	<key>WorkingDirectory</key>
	<string>${DEVPROXY_DIR}</string>
</dict>
</plist>
PLISTEOF
ok "LaunchAgent written: $PLIST_PATH"

# (Re)load it: bootout fails harmlessly when it was not loaded. It returns
# before launchd has finished unloading, and bootstrap fails (error 5) until
# then, so wait for the service to be gone.
launchctl bootout "${GUI_DOMAIN}/${PLIST_LABEL}" 2>/dev/null || true
kill "$(cat "${DEVPROXY_DIR}/proxy.pid" 2>/dev/null)" 2>/dev/null || true
for _ in $(seq 1 50); do
	launchctl print "${GUI_DOMAIN}/${PLIST_LABEL}" &>/dev/null || break
	sleep 0.2
done
launchctl bootstrap "$GUI_DOMAIN" "$PLIST_PATH"
ok "LaunchAgent loaded"

# ═══════════════════ CLAUDE SKILL (/microproxy on|off|…) ═══════════════════

SKILL_SRC="$SRC_DIR/../skill/SKILL.md"
if [ -f "$SKILL_SRC" ]; then
	mkdir -p "$HOME/.claude/skills/microproxy"
	cp "$SKILL_SRC" "$HOME/.claude/skills/microproxy/SKILL.md"
	ok "Claude skill installed: /microproxy"
fi

# ═══════════════════ CLI TOOL ═══════════════════

echo "  [+] CLI tool"

# Create symlink in /usr/local/bin for global access
SYMLINK_PATH="/usr/local/bin/devproxy"
if [ -L "$SYMLINK_PATH" ] && [ "$(readlink "$SYMLINK_PATH")" = "$DEST_CLI" ]; then
	skip "symlink already exists at $SYMLINK_PATH"
else
	# This needs admin since /usr/local/bin may require root
	if [ -d "/usr/local/bin" ]; then
		run_as_admin "ln -sf ${DEST_CLI} ${SYMLINK_PATH}"
		ok "symlink created: devproxy → $DEST_CLI"
	else
		run_as_admin "mkdir -p /usr/local/bin && ln -sf ${DEST_CLI} ${SYMLINK_PATH}"
		ok "symlink created: devproxy → $DEST_CLI"
	fi
fi

echo ""

# ═══════════════════ VERIFY ═══════════════════

echo ""
echo "  Verifying..."

# Test DNS resolution
if dig +short test.localhost @127.0.0.1 2>/dev/null | grep -q "127.0.0.1"; then
	ok "DNS: test.localhost → 127.0.0.1"
else
	echo -e "  ${YELLOW}!${NC} DNS check inconclusive (may need a few seconds)"
fi

# Test proxy is listening on port 80
sleep 2
if lsof -i :80 -sTCP:LISTEN 2>/dev/null | grep -q "node"; then
	ok "proxy: listening on port 80"
else
	echo -e "  ${YELLOW}!${NC} proxy not yet detected on port 80 (may need a moment to start)"
fi

# Test proxy responds
PROXY_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" -H "Host: test.localhost" http://127.0.0.1:80/ 2>/dev/null || echo "000")
if [ "$PROXY_RESPONSE" = "502" ]; then
	ok "proxy: responding (502 = no server registered, expected)"
elif [ "$PROXY_RESPONSE" != "000" ]; then
	ok "proxy: responding (HTTP $PROXY_RESPONSE)"
else
	echo -e "  ${YELLOW}!${NC} proxy not responding yet (daemon may need a moment)"
fi

echo ""
echo -e "  ${GREEN}Installation complete!${NC}"
echo ""
echo "  The proxy runs as a LaunchAgent (starts at login, no root)."
echo "  It listens on port 80 and only answers this Mac."
echo ""
echo "  Usage: start any project's server as usual; its folder name"
echo "  becomes the subdomain. Example: ~/Code/myapp → myapp.localhost"
echo ""

# Write marker so client knows installation is done
touch "$DEVPROXY_DIR/.installed"
ok "installation marker written"
echo ""
