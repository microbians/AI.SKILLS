# Meslo Code — a monospaced font for code

> Meslo Code: Menlo's line spacing, Fira Code ligatures and 10,611 Nerd Fonts icons. Free and open source (SIL OFL 1.1).

Page: https://microbians.github.io/AI.SKILLS/fonts/ · Download: https://github.com/microbians/AI.SKILLS/raw/main/fonts/MesloCode.zip (11 MB, ttf + woff2) · Source: https://github.com/microbians/AI.SKILLS/tree/main/fonts

## What it is

- **Base design:** Meslo LG S (a customized Menlo) with Menlo's vertical metrics restored: ascent 1901, descent 483, line height 2384 units (1.164 em) instead of Meslo LG S's 2584 (1.262 em). Every character is 1233 units wide, like Menlo.
- **Ligatures:** ~140 programming ligatures from Fira Code, each drawn across the cells of the characters it replaces, so `->` still takes two columns.
- **Icons:** the complete Nerd Fonts 3.5.1 set (10,611 icons: Powerline, Devicons, Codicons, Octicons, Font Awesome, Material Design and more).
- **Styles:** Regular, Bold, Italic, Bold Italic. Desktop `.ttf` and web `.woff2` with a ready `@font-face` stylesheet.

## Install

- **macOS:** double-click each file and press Install, or `cp MesloCode/*.ttf ~/Library/Fonts/`
- **Linux:** `mkdir -p ~/.local/share/fonts && cp MesloCode/*.ttf ~/.local/share/fonts/ && fc-cache -f`
- **Windows:** select the four `.ttf` files, right-click, Install.

VS Code (the terminal does not inherit the editor font; ligatures are off by default):

```json
"editor.fontFamily": "'Meslo Code', Menlo, monospace",
"editor.fontLigatures": true,
"terminal.integrated.fontFamily": "'Meslo Code', Menlo, monospace",
"terminal.integrated.fontLigatures.enabled": true
```

Terminals: iTerm2 (Profiles → Text, Use ligatures), Ghostty (`font-family = Meslo Code`), kitty (`font_family Meslo Code`), WezTerm (`wezterm.font 'Meslo Code'`); Terminal.app: font only, no ligatures.

Web: copy `MesloCode/web/` next to your site; pages without icons download only the 36 KB Latin files.

```html
<link rel="stylesheet" href="web/meslo-code.css">
<style> code, pre { font-family: "Meslo Code", Menlo, monospace; } </style>
```

## Credits and license

SIL Open Font License 1.1. Includes Bitstream Vera (Jim Lyles, Bitstream), Arev and DejaVu extensions, Meslo LG by André Berg (Apache 2.0), Fira Code by Nikita Prokopov and contributors (SIL OFL 1.1), Ligaturizer, and Nerd Fonts by Ryan L McIntyre and contributors. Built with FontForge and fontTools. Matches Apple's Menlo proportions; Menlo itself is not included.

Version 1.0.0 (2026-11-06).
