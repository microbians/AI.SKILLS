#!/usr/bin/env bash
# Builds Meslo Code into ../MesloCode/ from pinned upstream sources.
# Needs: fontforge (brew install fontforge), git, curl, unzip.
set -euo pipefail

VERSION="1.0.0"
MESLO_COMMIT="09a431d546d211130352c28eb0466e5d7d5aeaf0"   # andreberg/Meslo-Font, Meslo LG v1.2.1
LIGATURIZER_COMMIT="c4065187a544a8fab40826fc91db1c6180a2d342" # ToxicFrog/Ligaturizer (Fira Code e9943d2)
NERD_FONTS_VERSION="3.5.1"                                   # ryanoasis/nerd-fonts font-patcher

HERE="$(cd "$(dirname "$0")" && pwd)"
CACHE="$HERE/.cache"
WORK="$CACHE/work"
OUT="$HERE/../MesloCode"
STYLES=(Regular Bold Italic BoldItalic)

command -v fontforge >/dev/null || { echo "fontforge not found (brew install fontforge)"; exit 1; }
mkdir -p "$CACHE" "$OUT"
rm -rf "$WORK" && mkdir -p "$WORK"/{metrics,liga,nerd}

# 1. Sources
if [ ! -d "$CACHE/meslo" ]; then
  curl -fsSL -o "$CACHE/meslo.zip" \
    "https://raw.githubusercontent.com/andreberg/Meslo-Font/$MESLO_COMMIT/dist/v1.2.1/Meslo%20LG%20v1.2.1.zip"
  unzip -q -o "$CACHE/meslo.zip" -d "$CACHE/meslo"
fi
if [ ! -d "$CACHE/Ligaturizer" ]; then
  git clone -q https://github.com/ToxicFrog/Ligaturizer.git "$CACHE/Ligaturizer"
  git -C "$CACHE/Ligaturizer" checkout -q "$LIGATURIZER_COMMIT"
  git -C "$CACHE/Ligaturizer" submodule update -q --init --depth 1 fonts/fira
fi
if [ ! -d "$CACHE/nerd-fonts" ]; then
  curl -fsSL -o "$CACHE/FontPatcher.zip" \
    "https://github.com/ryanoasis/nerd-fonts/releases/download/v$NERD_FONTS_VERSION/FontPatcher.zip"
  unzip -q -o "$CACHE/FontPatcher.zip" -d "$CACHE/nerd-fonts"
fi
MESLO_DIR="$CACHE/meslo/Meslo LG v1.2.1"

for style in "${STYLES[@]}"; do
  echo "== $style"
  # 2. Menlo line spacing
  fontforge -lang=py -script "$HERE/meslo_code.py" metrics \
    "$MESLO_DIR/MesloLGS-$style.ttf" "$WORK/metrics/MesloLGS-$style.ttf" >/dev/null 2>&1
  # 3. Fira Code ligatures
  (cd "$CACHE/Ligaturizer" && fontforge -lang=py -script ligaturize.py \
    "$WORK/metrics/MesloLGS-$style.ttf" --output-dir="$WORK/liga" \
    --output-name="Meslo Code" --prefix="" >/dev/null 2>&1)
  # 4. Nerd Fonts icons (existing glyphs are kept)
  (cd "$CACHE/nerd-fonts" && fontforge -script font-patcher --complete --careful \
    --makegroups -1 --name "Meslo Code $style" --outputdir "$WORK/nerd" \
    "$WORK/liga/MesloCode-$style.ttf" >/dev/null 2>&1)
  # 5. Clean name table
  fontforge -lang=py -script "$HERE/meslo_code.py" names \
    "$WORK/nerd/MesloCode-$style.ttf" "$OUT/MesloCode-$style.ttf" "$VERSION" >/dev/null 2>&1
done

ls -la "$OUT"

# 6. Web fonts (needs fonttools + brotli: pip install fonttools brotli)
#    MesloCode/web/          full woff2 + Latin-only woff2 (meslo-code.css picks per character)
#    assets/fonts/           landing page subset: Latin + the icons the page shows
FONTTOOLS="${FONTTOOLS:-fonttools}"
LATIN="U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+2074,U+20AC,U+2122,U+2190-21FF,U+2200-22FF,U+2500-259F,U+25A0-25FF,U+FEFF,U+FFFD"
LANDING_ICONS="U+E0A0-E0A2,U+E0B0-E0B7,U+E0BC-E0BF,U+E725,U+E702,U+F418,U+F113,U+F126,U+F417,U+F41B,U+EA68,U+F1D3,U+F15B,U+F07B,U+F07C,U+E5FF,U+F016,U+F0C5,U+F15C,U+F1C9,U+F489,U+F00C,U+F00D,U+F071,U+F05A,U+F058,U+F057,U+F110,U+F017,U+F0E7,U+E711,U+F17C,U+E718,U+E73C,U+E74E,U+E7A8,U+E60B,U+E627,U+E737,U+F308,U+E7A1,U+E77F,U+E61F,U+E62B,U+E795,U+F120,U+F121,U+F0AD,U+F013,U+F002,U+F019,U+F17A,U+F0AC,U+E8DA,U+F004"
# Status line faces and Claude Code chrome drawn on the Secretary landing
LANDING_ICONS="$LANDING_ICONS,U+029A,U+1D16-1D17,U+2313,U+233D-233E,U+2611,U+273B,U+2749,U+276E-276F"
if command -v "$FONTTOOLS" >/dev/null; then
  WEB="$OUT/web" SITE="$HERE/../assets/fonts"
  mkdir -p "$WEB" "$SITE"
  subset() { "$FONTTOOLS" subset "$1" --output-file="$2" --flavor=woff2 --unicodes="$3" \
    --layout-features='*' --no-hinting --desubroutinize 2>/dev/null; }
  for style in "${STYLES[@]}"; do
    ttf="$OUT/MesloCode-$style.ttf"
    "$FONTTOOLS" ttLib.woff2 compress -o "$WEB/MesloCode-$style.woff2" "$ttf" >/dev/null
    subset "$ttf" "$WEB/MesloCode-$style-latin.woff2" "$LATIN"
    subset "$ttf" "$SITE/MesloCode-$style.woff2" "$LATIN,$LANDING_ICONS"
  done
  ls -la "$WEB" "$SITE"
else
  echo "fonttools not found (pip install fonttools brotli): web fonts skipped"
fi

# 7. Download bundle for the landing page
(cd "$HERE/.." && rm -f MesloCode.zip && zip -qr MesloCode.zip MesloCode LICENSES README.md -x '*.DS_Store' && ls -la MesloCode.zip)
