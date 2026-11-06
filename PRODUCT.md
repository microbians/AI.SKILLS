# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Static HTML/CSS/JS per landing, no build step, served by GitHub Pages from this repo (`microbians/AI.SKILLS`). Each landing lives beside the thing it presents (`fonts/index.html`, `plugins/secretary/index.html`).

## Users

Developers in general (not only Claude Code users), arriving from GitHub, a link or a search. They want to know in seconds what the thing is, whether it is worth installing, and how to install it.

## Product Purpose

AI.SKILLS is a collection of drop-in components for AI coding agents and the developer's own environment. Two pieces get their own landing:

- **Meslo Code** — a free monospaced font for code: Meslo LG with Menlo's exact line spacing, Fira Code programming ligatures and the full Nerd Fonts icon set, in Regular, Bold, Italic and Bold Italic. Success: the visitor downloads and installs the `.ttf` files.
- **The Secretary** — a local memory for Claude Code: stores every conversation verbatim, keeps one flat index of what is worth remembering, writes a handoff at the end of each session so the next one resumes without re-explaining, and answers recall questions ("do you remember…?") with literal + semantic search. Runs on a local LLM; nothing leaves the machine. Success: the visitor runs `bash install.sh`.

## Positioning

- Meslo Code: the Menlo look and line spacing developers already know from macOS, plus ligatures and icons, under an open license (Menlo itself cannot be redistributed or modified).
- The Secretary: the transcript is the source of truth; summaries are a layer on top, and every accuracy rule was measured on real sessions (fabricated paths 26 → 10 → 1 → 0, repetition loops ~1% detected and trimmed). Memory travels with the project folder and is never committed.

## Operating Context

- Meslo Code is used in code editors (VS Code, JetBrains) and terminals (iTerm2, Ghostty, kitty, WezTerm). Ligatures must be enabled per app.
- The Secretary runs as Claude Code hooks on macOS or Linux with Node ≥ 18 and a local LLM backend (MLX on Apple Silicon, or llama.cpp), or the `claude_cli` provider on a Claude Max subscription.

## Capabilities and Constraints

- Meslo Code: 4 styles, ~13,900 glyphs each, ~150 Fira Code ligatures, Nerd Fonts 3.5.1 complete set. License SIL OFL 1.1 with Bitstream Vera, Apache 2.0 (Meslo) and Nerd Fonts notices. The name "Menlo" must not be used as the font's name; it may be named as the reference the font matches.
- The Secretary: MIT license. Install with `bash install.sh` from `plugins/secretary/`. Optional semantic index needs an extra venv.

## Brand Commitments

- Landing copy is in English, like the rest of the repo.
- Each landing gets its own visual direction (user asked to be surprised); no shared template is required.

## Evidence on Hand

- Real measurements in `plugins/secretary/README.md` (benchmarks, fabricated-path counts, search tables, status line sample).
- The font files themselves in `fonts/MesloCode/`, which the landing can load to demonstrate itself.
- No testimonials, user counts, stars or press exist. Do not invent them.

## Product Principles

1. Show the thing working instead of describing it: the font sets its own page; The Secretary shows real recall and handoff output.
2. Install is one step away from the first viewport.
3. Claims are measured or absent.
4. Local and private by default is a fact to state, not a slogan to decorate.
