# Meslo Code

A fork of [Meslo LG](https://github.com/andreberg/Meslo-Font) (itself a customized Menlo) tuned for code:

- **Menlo's line spacing.** Meslo LG S adds 200 units per line; Meslo Code restores Menlo's exact vertical metrics, so it sits on screen like the macOS default.
- **Programming ligatures** from [Fira Code](https://github.com/tonsky/FiraCode), merged with [Ligaturizer](https://github.com/ToxicFrog/Ligaturizer): `->` `=>` `<-` `!=` `===` `<=` `>=` `|>` `::` `&&` `||` `/*` `*/` `//` `...` and ~140 more. The individual characters keep Meslo's design.
- **Nerd Fonts icons** from [Nerd Fonts](https://github.com/ryanoasis/nerd-fonts) 3.5.1 (complete set): Powerline, Powerline Extra, Devicons, Codicons, Octicons, Font Awesome, Material Design, Seti-UI, Font Logos, Pomicons, Weather Icons, IEC power symbols. Shell prompts (Starship, Powerlevel10k, oh-my-posh), `eza`/`lsd` file icons and editor file trees render out of the box.
- **Four styles:** Regular, Bold, Italic, Bold Italic.

Family name: **`Meslo Code`**.

```
MesloCode/
  MesloCode-{Regular,Bold,Italic,BoldItalic}.ttf     desktop fonts
  web/
    meslo-code.css                                   @font-face rules
    MesloCode-<style>.woff2                          full web font (~1.2 MB)
    MesloCode-<style>-latin.woff2                    Latin + ligatures, no icons (~36 KB)
MesloCode.zip      everything above + licenses, for download
LICENSES/          license texts of every component
build/             build script (reproduces MesloCode/ from pinned sources)
index.html         landing page (GitHub Pages)
assets/            landing page files
test.txt           ligature and icon test sheet
```

## Install

### macOS

Double-click each `.ttf` in `MesloCode/` and press **Install**, or from a terminal:

```bash
cp MesloCode/*.ttf ~/Library/Fonts/
```

### Linux

```bash
mkdir -p ~/.local/share/fonts
cp MesloCode/*.ttf ~/.local/share/fonts/
fc-cache -f
```

### Windows

Select the four `.ttf` files in `MesloCode\`, right-click, **Install** (or **Install for all users**).

Restart any application that was open during the install so it picks up the new font.

## Use

### VS Code

`settings.json`:

```json
"editor.fontFamily": "'Meslo Code', Menlo, monospace",
"editor.fontLigatures": true,
"terminal.integrated.fontFamily": "'Meslo Code', Menlo, monospace",
"terminal.integrated.fontLigatures.enabled": true
```

The integrated terminal does not inherit the editor font, so set both. Ligatures are off by default in VS Code. If the font does not change, run **Developer: Reload Window**.

### Terminals

| Terminal | Font | Ligatures |
| --- | --- | --- |
| iTerm2 | Settings → Profiles → Text → Font: `Meslo Code` | Check **Use ligatures** |
| Ghostty | `font-family = Meslo Code` | On by default |
| kitty | `font_family Meslo Code` | On by default |
| WezTerm | `font = wezterm.font 'Meslo Code'` | On by default |
| Alacritty | `font.normal.family = "Meslo Code"` | Not supported |
| macOS Terminal | Settings → Profiles → Text → Font | Not supported |

### JetBrains IDEs

Settings → Editor → Font: `Meslo Code`, check **Enable ligatures**.

### Web pages

Copy `MesloCode/web/` next to your site and link the stylesheet:

```html
<link rel="stylesheet" href="web/meslo-code.css">
<style>
  code, pre { font-family: "Meslo Code", Menlo, monospace; }
</style>
```

Each style ships twice: a `-latin` file (~36 KB: Latin text, box drawing, every ligature) and the full file (~1.2 MB, adds the Nerd Fonts icons). `meslo-code.css` declares both with `unicode-range`, so a page without icons downloads only the small files. Ligatures are on by default in browsers; `font-variant-ligatures: none` turns them off.

## Test

Open `test.txt` with the font set. Arrows and operators should join into single shapes and the icon rows should show symbols, not empty boxes.

## Build

Requires `fontforge` (`brew install fontforge`), `git`, `curl` and `unzip`.

```bash
./build/build.sh
```

The script downloads pinned versions of Meslo LG 1.2.1, Ligaturizer (with Fira Code) and the Nerd Fonts patcher 3.5.1 into `build/.cache/` (not tracked), then for each style:

1. sets Menlo's vertical metrics on Meslo LG S,
2. adds the Fira Code ligatures,
3. adds the Nerd Fonts icons without replacing existing glyphs,
4. rewrites the name table (family `Meslo Code`, copyright and license notices),

and writes the result to `MesloCode/`. With `fonttools` and `brotli` installed (`pip install fonttools brotli`) it also writes the web fonts and the landing page subset; finally it packs `MesloCode.zip`. Bump `VERSION` in `build.sh` when the output changes.

## License

Meslo Code is distributed under the **SIL Open Font License 1.1**, required by the Fira Code ligatures it includes. The notices of every component are kept as their licenses require:

| Component | License | File |
| --- | --- | --- |
| Bitstream Vera (base design) and Arev glyphs | Bitstream Vera Fonts License | `LICENSES/Bitstream-Vera-Arev.txt` |
| Meslo LG (André Berg) | Apache License 2.0 | `LICENSES/Apache-2.0-Meslo.txt` |
| Fira Code ligatures | SIL OFL 1.1 | `LICENSES/OFL-1.1-FiraCode.txt` |
| Nerd Fonts icons and patcher | SIL OFL 1.1 / MIT, plus per-icon-set licenses | `LICENSES/NerdFonts.txt` |

As the Bitstream Vera license requires, the family name contains neither "Bitstream" nor "Vera". The name "Menlo" is not used. The font may be sold only as part of a larger software package, never by itself.

## Acknowledgements

Meslo Code is assembled, not drawn from scratch. Thanks to:

- **Jim Lyles, Bitstream** — Bitstream Vera Sans Mono, the original design every glyph descends from.
- **Tavmjong Bah** — Arev fonts, extending Vera with Greek, Cyrillic and many more glyphs.
- **The DejaVu project** — years of extending and maintaining the Vera family in the open.
- **Apple** — Menlo, whose proportions and line spacing Meslo Code matches. Menlo itself is not included.
- **André Berg** — [Meslo LG](https://github.com/andreberg/Meslo-Font), the customized Menlo this font is built on.
- **Nikita Prokopov and the Fira Code authors** — [Fira Code](https://github.com/tonsky/FiraCode), source of the programming ligatures.
- **Ilya Skriblovsky, ToxicFrog and contributors** — [Ligaturizer](https://github.com/ToxicFrog/Ligaturizer), which grafts Fira Code's ligatures onto other fonts.
- **Ryan L McIntyre and the Nerd Fonts contributors** — [Nerd Fonts](https://github.com/ryanoasis/nerd-fonts) and its font patcher, plus the authors of every icon set it bundles.
- **George Williams and the FontForge team** — [FontForge](https://fontforge.org), which runs every build step.
- **The fontTools maintainers** — [fontTools](https://github.com/fonttools/fonttools), used for the web subsets and woff2 files.
