#!/bin/bash
#################################################################
# DEVPROXY - One-time installation script
#
# Installs everything needed for *.localhost subdomain routing:
#   1. dnsmasq (via Homebrew) — resolves *.localhost → 127.0.0.1
#   2. /etc/resolver/localhost — tells macOS to use dnsmasq
#   3. LaunchDaemon — runs proxy.js on port 80 at boot (as root,
#      proxy drops privileges after binding)
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

# New LaunchDaemon (runs node proxy.js as root)
PLIST_LABEL="com.devproxy.proxy"
PLIST_PATH="/Library/LaunchDaemons/${PLIST_LABEL}.plist"

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

# ═══════════════════ PREFLIGHT ═══════════════════

# Check proxy.js exists
if [ ! -f "$PROXY_JS" ]; then
	fail "proxy.js not found at $PROXY_JS"
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

# ═══════════════════ 0b. HOMEBREW ═══════════════════

if ! command -v brew &>/dev/null; then
	echo "  [0b] Homebrew"
	echo "  Installing Homebrew (this may take a minute)..."
	NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
	if [ -f "/opt/homebrew/bin/brew" ]; then
		eval "$(/opt/homebrew/bin/brew shellenv)"
	elif [ -f "/usr/local/bin/brew" ]; then
		eval "$(/usr/local/bin/brew shellenv)"
	fi
	if command -v brew &>/dev/null; then
		ok "Homebrew installed"
	else
		fail "Homebrew installation failed"
	fi
fi

# ═══════════════════ 1. DNSMASQ ═══════════════════

echo "  [1/3] dnsmasq"

if brew list dnsmasq &>/dev/null; then
	skip "dnsmasq already installed"
else
	echo "  Installing dnsmasq..."
	brew install dnsmasq >/dev/null 2>&1
	ok "dnsmasq installed"
fi

# Configure dnsmasq for *.localhost → 127.0.0.1
DNSMASQ_CONF="$(brew --prefix)/etc/dnsmasq.conf"
DNSMASQ_LINE="address=/localhost/127.0.0.1"

if grep -q "^${DNSMASQ_LINE}$" "$DNSMASQ_CONF" 2>/dev/null; then
	skip "dnsmasq already configured for *.localhost"
else
	echo "" >> "$DNSMASQ_CONF"
	echo "# devproxy: resolve *.localhost to loopback" >> "$DNSMASQ_CONF"
	echo "$DNSMASQ_LINE" >> "$DNSMASQ_CONF"
	ok "dnsmasq configured for *.localhost"
fi

# ═══════════════════ COLLECT ADMIN TASKS ═══════════════════
# Build a single script with all commands that need root.
# The user sees ONE native macOS auth dialog for everything.

echo ""
echo "  Preparing system changes..."

ADMIN_SCRIPT=""

# ── dnsmasq service (needs sudo for brew services) ──
ADMIN_SCRIPT+="$(brew --prefix)/bin/brew services restart dnsmasq 2>/dev/null || true; "

# ── resolver ──
echo "  [2/3] macOS resolver"
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
	ok "will clean pf.conf of devproxy entries"
else
	skip "pf.conf already clean"
fi

# Flush any active pfctl rules for our anchor
ADMIN_SCRIPT+="/sbin/pfctl -a com.devproxy -F all 2>/dev/null || true; "

# Remove legacy sudoers rule (was for pfctl)
if [ -f "$LEGACY_SUDOERS" ]; then
	ADMIN_SCRIPT+="rm -f ${LEGACY_SUDOERS}; "
	ok "will remove legacy pfctl sudoers rule"
else
	skip "no legacy sudoers rule"
fi

# ── LaunchDaemon for proxy.js on port 80 ──
echo ""
echo "  [3/3] LaunchDaemon (proxy on port 80)"

# Resolve the full path to node
NODE_PATH="$(which node)"

if [ -f "$PLIST_PATH" ]; then
	# Check if existing plist points to the right proxy.js
	if grep -q "$PROXY_JS" "$PLIST_PATH" 2>/dev/null; then
		skip "LaunchDaemon already installed"
	else
		# Plist exists but points to wrong path — recreate
		ADMIN_SCRIPT+="launchctl unload ${PLIST_PATH} 2>/dev/null || true; "
		ADMIN_SCRIPT+="rm -f ${PLIST_PATH}; "
		ok "will update LaunchDaemon with correct paths"
	fi
fi

# Create the plist if it doesn't exist (or was just removed for update)
# The LaunchDaemon runs proxy.js as root; the proxy drops privileges after binding port 80
if [ ! -f "$PLIST_PATH" ] || ! grep -q "$PROXY_JS" "$PLIST_PATH" 2>/dev/null; then
	PLIST_CONTENT="<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
	<key>Label</key>
	<string>${PLIST_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${NODE_PATH}</string>
		<string>${PROXY_JS}</string>
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
</plist>"

	ADMIN_SCRIPT+="cat > ${PLIST_PATH} << 'PLISTEOF'
${PLIST_CONTENT}
PLISTEOF
"
	ADMIN_SCRIPT+="chmod 644 ${PLIST_PATH}; "
	ADMIN_SCRIPT+="chown root:wheel ${PLIST_PATH}; "
fi

# Always stop any existing proxy process and (re)load the daemon
ADMIN_SCRIPT+="launchctl unload ${PLIST_PATH} 2>/dev/null || true; "
# Kill any manually-started proxy process
ADMIN_SCRIPT+="kill \$(cat ${DEVPROXY_DIR}/proxy.pid 2>/dev/null) 2>/dev/null || true; "
ADMIN_SCRIPT+="sleep 1; "
ADMIN_SCRIPT+="launchctl load ${PLIST_PATH} 2>/dev/null || true; "

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
echo "  The proxy runs as a LaunchDaemon (auto-starts at boot)."
echo "  It listens on port 80, then drops root privileges."
echo ""
echo "  Usage: any project's dev launcher that imports devproxy"
echo "  will automatically register its subdomain."
echo "  Example: myapp.localhost → your dev server"
echo ""

# Write marker so client knows installation is done
touch "$DEVPROXY_DIR/.installed"
ok "installation marker written"
echo ""
