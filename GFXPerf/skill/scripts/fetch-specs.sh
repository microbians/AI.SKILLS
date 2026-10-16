#!/usr/bin/env sh
# gfx-perf — download the WebGPU and WGSL specifications for local search.
#
# The files are the sources the W3C documents are built from (Bikeshed, plain
# text with markup): complete and greppable. Kept in ~/.cache/gfx-perf/specs/
# (override with GFX_PERF_SPECS) and refreshed when older than 30 days, or at
# once with --force.
#
#   sh fetch-specs.sh [--force]
#   grep -n "maxBindGroups" ~/.cache/gfx-perf/specs/webgpu.bs

set -e

DEST="${GFX_PERF_SPECS:-$HOME/.cache/gfx-perf/specs}"
BASE="https://raw.githubusercontent.com/gpuweb/gpuweb/main"
FORCE=0
[ "$1" = "--force" ] && FORCE=1

mkdir -p "$DEST"

# name  path-in-the-repository
fetch() {
	file="$DEST/$1"
	if [ "$FORCE" = 0 ] && [ -s "$file" ] && [ -z "$(find "$file" -mtime +30 2>/dev/null)" ]; then
		echo "  $1: present ($(wc -c < "$file" | tr -d ' ') bytes)"
		return 0
	fi
	# Downloaded apart and moved into place only when whole, so a failed
	# download never replaces a good copy
	if curl -fsSL --max-time 60 -o "$file.part" "$BASE/$2" && [ -s "$file.part" ]; then
		mv "$file.part" "$file"
		echo "  $1: downloaded ($(wc -c < "$file" | tr -d ' ') bytes)"
	else
		rm -f "$file.part"
		if [ -s "$file" ]; then
			echo "  $1: download failed — keeping the copy already there" >&2
		else
			echo "  $1: download failed and there is no copy" >&2
			return 1
		fi
	fi
}

echo "WebGPU and WGSL specifications in $DEST"
status=0
fetch webgpu.bs spec/index.bs || status=1
fetch wgsl.bs wgsl/index.bs || status=1
exit $status
