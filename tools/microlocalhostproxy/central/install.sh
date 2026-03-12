#!/bin/bash
#################################################################
# DEVPROXY - One-time installation script
#
# Installs everything needed for *.localhost subdomain routing:
#   1. dnsmasq (via Homebrew) — resolves *.localhost → 127.0.0.1
#   2. /etc/resolver/localhost — tells macOS to use dnsmasq
#   3. pfctl anchor — redirects port 80 → 8080 on loopback
#   4. LaunchDaemon — loads pfctl rule at boot
#   5. sudoers rule — allows pfctl without password
#
# Uses native macOS SecurityAgent dialog for authentication.
# No terminal required — works from any context.
#
# @license MIT
#################################################################

set -euo pipefail

DEVPROXY_DIR="$HOME/.config/devproxy"
PROXY_PORT=8080
ANCHOR_NAME="com.devproxy"
PLIST_PATH="/Library/LaunchDaemons/com.devproxy.pfctl.plist"
SUDOERS_PATH="/etc/sudoers.d/devproxy"
RESOLVER_DIR="/etc/resolver"
RESOLVER_PATH="/etc/resolver/localhost"
PF_ANCHOR_PATH="/etc/pf.anchors/com.devproxy"

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
if [ ! -f "$DEVPROXY_DIR/proxy.js" ]; then
	fail "proxy.js not found at $DEVPROXY_DIR/proxy.js"
fi

echo "  This will configure local subdomain routing (*.localhost)."
echo "  Missing dependencies will be installed automatically."
echo ""

# ═══════════════════ 0a. NODE.JS ═══════════════════

if ! command -v node &>/dev/null; then
	echo "  [0a] Node.js"
	echo "  Installing Node.js via official macOS installer..."
	# The official .pkg is a universal binary (arm64 + x86_64)
	NODE_PKG_URL="https://nodejs.org/dist/v22.14.0/node-v22.14.0.pkg"
	NODE_PKG_TMP="/tmp/node-installer.pkg"
	curl -fsSL "$NODE_PKG_URL" -o "$NODE_PKG_TMP"
	# Install via native macOS installer (shows its own auth dialog)
	run_as_admin "installer -pkg ${NODE_PKG_TMP} -target /"
	rm -f "$NODE_PKG_TMP"
	# Verify
	if command -v node &>/dev/null; then
		ok "Node.js $(node -v) installed"
	else
		# Node pkg installs to /usr/local/bin — add to PATH for this session
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
	# Add Homebrew to PATH for this session (Apple Silicon vs Intel)
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

echo "  [1/5] dnsmasq"

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
# This way the user sees ONE native macOS auth dialog for everything.

echo ""
echo "  Preparing system changes..."

ADMIN_SCRIPT=""
ADMIN_NEEDED=false

# ── dnsmasq service (needs sudo for brew services) ──
ADMIN_SCRIPT+="$(brew --prefix)/bin/brew services restart dnsmasq 2>/dev/null || true; "

# ── resolver ──
if [ -f "$RESOLVER_PATH" ] && grep -q "nameserver 127.0.0.1" "$RESOLVER_PATH" 2>/dev/null; then
	: # skip
else
	ADMIN_NEEDED=true
	ADMIN_SCRIPT+="mkdir -p ${RESOLVER_DIR}; "
	ADMIN_SCRIPT+="echo 'nameserver 127.0.0.1' > ${RESOLVER_PATH}; "
fi

# ── pfctl anchor file ──
ANCHOR_CONTENT="rdr pass on lo0 inet proto tcp from any to 127.0.0.1 port 80 -> 127.0.0.1 port ${PROXY_PORT}"

if [ -f "$PF_ANCHOR_PATH" ] && grep -q "$PROXY_PORT" "$PF_ANCHOR_PATH" 2>/dev/null; then
	: # skip
else
	ADMIN_NEEDED=true
	ADMIN_SCRIPT+="echo '${ANCHOR_CONTENT}' > ${PF_ANCHOR_PATH}; "
fi

# ── pf.conf modification ──
if grep -q "^rdr-anchor \"$ANCHOR_NAME\"" /etc/pf.conf 2>/dev/null; then
	: # skip
else
	ADMIN_NEEDED=true
	# Insert rdr-anchor after last existing rdr-anchor line (order matters in pf.conf),
	# and append load anchor at the end. Uses sed for reliability through osascript.
	ADMIN_SCRIPT+="cp /etc/pf.conf /etc/pf.conf.devproxy-backup; "
	ADMIN_SCRIPT+="sed -i '' '/^rdr-anchor \"com.apple/a\\
rdr-anchor \"${ANCHOR_NAME}\"
' /etc/pf.conf; "
	ADMIN_SCRIPT+="echo 'load anchor \"${ANCHOR_NAME}\" from \"${PF_ANCHOR_PATH}\"' >> /etc/pf.conf; "
fi

# ── Load pfctl rules ──
ADMIN_SCRIPT+="/sbin/pfctl -f /etc/pf.conf 2>/dev/null || true; "
ADMIN_SCRIPT+="/sbin/pfctl -e 2>/dev/null || true; "

# ── LaunchDaemon ──
if [ -f "$PLIST_PATH" ]; then
	: # skip
else
	ADMIN_NEEDED=true
	PLIST_CONTENT='<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>com.devproxy.pfctl</string>
	<key>ProgramArguments</key>
	<array>
		<string>/sbin/pfctl</string>
		<string>-e</string>
		<string>-f</string>
		<string>/etc/pf.conf</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
</dict>
</plist>'
	# Write plist via heredoc in the admin script
	ADMIN_SCRIPT+="cat > ${PLIST_PATH} << 'PLISTEOF'
${PLIST_CONTENT}
PLISTEOF
"
	ADMIN_SCRIPT+="launchctl load ${PLIST_PATH} 2>/dev/null || true; "
fi

# ── sudoers ──
CURRENT_USER="$(whoami)"
if [ -f "$SUDOERS_PATH" ]; then
	: # skip
else
	ADMIN_NEEDED=true
	ADMIN_SCRIPT+="echo '${CURRENT_USER} ALL=(root) NOPASSWD: /sbin/pfctl' > ${SUDOERS_PATH}; "
	ADMIN_SCRIPT+="chmod 0440 ${SUDOERS_PATH}; "
	ADMIN_SCRIPT+="visudo -c -f ${SUDOERS_PATH} 2>/dev/null || rm -f ${SUDOERS_PATH}; "
fi

# ═══════════════════ EXECUTE WITH ONE AUTH DIALOG ═══════════════════

if [ -n "$ADMIN_SCRIPT" ]; then
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

# ═══════════════════ REPORT RESULTS ═══════════════════

echo ""

# [2/5] resolver
echo "  [2/5] macOS resolver"
if [ -f "$RESOLVER_PATH" ] && grep -q "nameserver 127.0.0.1" "$RESOLVER_PATH" 2>/dev/null; then
	ok "resolver: *.localhost → dnsmasq"
else
	fail "resolver not configured"
fi

# [3/5] pfctl
echo "  [3/5] pfctl redirect"
if [ -f "$PF_ANCHOR_PATH" ] && grep -q "$PROXY_PORT" "$PF_ANCHOR_PATH" 2>/dev/null; then
	ok "pfctl anchor: port 80 → $PROXY_PORT"
else
	fail "pfctl anchor not created"
fi

if grep -q "^rdr-anchor \"$ANCHOR_NAME\"" /etc/pf.conf 2>/dev/null; then
	ok "pf.conf references anchor"
else
	fail "pf.conf not updated"
fi

# [4/5] LaunchDaemon
echo "  [4/5] LaunchDaemon"
if [ -f "$PLIST_PATH" ]; then
	ok "LaunchDaemon installed"
else
	fail "LaunchDaemon not created"
fi

# [5/5] sudoers
echo "  [5/5] sudoers"
if [ -f "$SUDOERS_PATH" ]; then
	ok "sudoers rule: pfctl without password"
else
	echo -e "  ${YELLOW}!${NC} sudoers rule not installed (pfctl will require password)"
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

# Test pfctl rules loaded
if sudo -n pfctl -a "$ANCHOR_NAME" -s nat 2>/dev/null | grep -q "$PROXY_PORT"; then
	ok "pfctl: redirect active"
else
	echo -e "  ${YELLOW}!${NC} pfctl rule check inconclusive"
fi

echo ""
echo -e "  ${GREEN}Installation complete!${NC}"
echo ""
echo "  Usage: any project's dev launcher that imports devproxy"
echo "  will automatically register its subdomain."
echo "  Example: myapp.localhost → your dev server"
echo ""

# Write marker so client knows installation is done
touch "$DEVPROXY_DIR/.installed"
ok "installation marker written"
echo ""
