# AI.SKILLS

Skills, plugins, and tools for AI coding agents (OpenCode, Claude Code).

A collection of drop-in components that give AI agents persistent memory, safer coding habits, auto-generated documentation, and better local development workflows.

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  AI.SKILLS                                                      │
│                                                                 │
│  plugins/          hooks + engine + skill, own install.sh       │
│    - secretary/              Local LLM context summarizer       │
│                              + recall-on-demand ("remember?")   │
│    - safe-edit/              sed -i replacement: diff preview,  │
│                              backups + auto-prune (Node CLI)    │
│    - code-index/             Incremental symbol index +         │
│                              relational edge graph (SQLite)     │
│                                                                 │
│  skills/           instructions only (SKILL.md + references)    │
│    - gfx-perf/               Measured perf work: JS, Canvas2D,  │
│                              WebGPU                             │
│    - ascii-art-diagrams/     Unicode diagram formatting rules   │
│    - defensive-development/  Verify-first coding practices      │
│    - project-structure/      Auto-gen directory structure docs  │
│    - project-api/            Auto-gen API reference docs        │
│    - secure-coding/          Security + data-integrity rules    │
│                                                                 │
│  tools/            standalone programs                          │
│    - microproxy/             <folder>.localhost for any server  │
│    - claude-launcher/        VS Code extension (Activity Bar +  │
│                              Status Bar launcher for Claude)    │
│                                                                 │
│  claude-md/                  The global CLAUDE.md               │
│                                                                 │
│  boilerplate/                Project template + instructions    │
│                                                                 │
│  others/ (local only)                                           │
│    - microbrain/             Persistent SQLite memory system    │
│    - block-destructive/      Block destructive Bash commands    │
│    - opencodemlx/            Local AI coding assistant (MLX)    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Table of Contents

- [Plugins](#plugins)
  - [TheSecretary](#thesecretary) ⭐
  - [SafeEdit](#safeedit)
  - [CodeIndex](#codeindex)
- [Skills](#skills)
  - [GFXPerf](#gfxperf)
  - [Defensive Development](#defensive-development)
  - [ASCII Art Diagrams](#ascii-art-diagrams)
  - [Project Structure](#project-structure)
  - [Project API](#project-api)
  - [Secure Coding](#secure-coding)
- [Others](#others)
  - [Microbrain](#microbrain)
  - [Block Destructive](#block-destructive)
- [Tools](#tools)
  - [Microproxy](#microproxy)
  - [Claude Launcher](#claude-launcher)
- [OpenCode MLX](#opencode-mlx)
- [Boilerplate](#boilerplate)
- [Installation](#installation)
- [Compatibility](#compatibility)
- [Changelog](#changelog)
- [License](#license)

---

## Plugins

Change how Claude Code itself works: hooks that run on every session, an engine, and a skill with the rules. Each one has its own `install.sh`.


### TheSecretary

> [`plugins/secretary/`](plugins/secretary/)

Local LLM-powered conversation summarizer for Claude Code. Preserves context across `/clear` and session restarts using a small local model (Llama-3.2-3B-4bit, MLX), and auto-injects relevant past context when you ask "do you remember...?" (also "¿recuerdas...?" in Spanish).

```
┌───────────────────────────────────────────────────────┐
│                                                       │
│  TheSecretary                                         │
│                                                       │
│  Claude Code ──▶ Hooks ──▶ Local LLM + regex          │
│                                  │                    │
│                                  ▼                    │
│                            ┌───────────┐              │
│                            │ SQLite DB │              │
│                            │ summaries │              │
│                            │ memories  │              │
│                            │ notes     │              │
│                            │ reminders │              │
│                            └─────┬─────┘              │
│                                  │                    │
│  "do you remember X?" ───────────▶ search & inject    │
│  /clear               ───────────▶ restore context    │
│                                                       │
└───────────────────────────────────────────────────────┘
```

**Key features:**
- **Per-project storage (memory travels with the folder)** — each project keeps its own SQLite DB + bullets cache inside the project at `<projectRoot>/.claude/the-secretary/`; copy or sync the folder anywhere and its memory goes with it. Only items marked `global` live in the shared DB at `~/.claude/the-secretary/`. Legacy global data is migrated automatically (non-destructively) the first time a project opens
- **Verbatim conversation index (v2.5.0)** — every user/assistant message is read straight from Claude Code's transcripts by every hook (its own cursor, so no turn is skipped), stored whole in 800-char chunks with pasted screenshots saved to `images/`, and kept after Claude Code deletes the transcript. Search fuses FTS5 (literal) and sqlite-vec (meaning) with reciprocal rank fusion; exact matches always first. Upgrade: `index-turns --rebuild` once per project
- **Handoff wait after `/clear` (v2.8.0)** — an async SessionStart hook waits for the previous session's handoff and wakes Claude with it, so no first prompt is needed; a status line shows the wait
- **Local hooks (v2.9.0)** — machine-specific behaviour lives in `~/.claude/the-secretary/local/`, which `install.sh` never overwrites
- **`secretary` launcher (v2.13.0)** — start Claude with `secretary` (same arguments as `claude`); past the context limit the session is trimmed and reopened by itself with the prompt you just sent. `-limit 80` sets that session's limit in thousands
- **Status line (v2.14.0–v2.16.0)** — an animated `( ∵ᴖ ᴗ ᴖ∵ ) Secretary` face that never shifts the line, a context bar against the limit (`56K/500K`), model and effort, cost, 5 h / 7 d plan usage, prompt-cache minutes left and the account
- **Pick the summarizing AI from the chat (v2.11.0)** — `/secretary ai local | apple | claude [model] [--account <name | email | folder>]`; with several Claude accounts, `--account` finds one by config folder, email (with or without `@`) or a fragment of either
- **Recall-on-demand** — detects recall-style prompts (`do you remember`, `do you recall`, `remember when`, plus `¿recuerdas?` / `te acuerdas?` in Spanish) via UserPromptSubmit hook and auto-injects matching snippets from cache + DB before Claude replies
- **Chunked summarization + immediate LLM call** — conversation is broken into bounded chunks (every `summarize_every_n` tool calls, minimum `min_new_chars` of new content), each chunk is sent to the local LLM right away for a fresh summary, then stored with an incremental `chunk_index` in SQLite and appended to the per-project `.md` cache. This keeps every LLM call small and fast, prevents context blow-up, and ensures no long conversation is ever summarized in a single oversized request
- **Consolidation + compaction pass** — on session end / restore, chunks are consolidated into a single summary; if the merged summary exceeds the size budget, a second LLM pass compacts it under 3500 chars while preserving critical info
- Per-project pre-generated cache `.md` files for fast SessionStart restores
- PreCompact hook warns before Claude Code's native compaction, suggests `/clear` to use local summaries instead
- SessionStart hook injects saved summaries on `/clear`, `startup`, or `resume`
- Memories, notes, reminders with regex detection + bilingual date parsing (EN/ES)
- Global scope: memories, notes, and reminders can be shared across all projects
- SQLite storage for persistent summaries across sessions (per-project DB + attached global DB, unified `all_items` view)
- Configurable: model, summarization frequency (`summarize_every_n`), min content threshold (`min_new_chars`), token limits, remote LLM support

**Includes:** `summarize.mjs`, `secretary.mjs` (launcher, linked to `~/.local/bin/secretary`), `embed.py`, `start-llm.sh`, `config.json`, `inject-claude-md.mjs`, `hooks.json`, `statusline.json`, `install.sh`, `claude-md-snippet.md`, `skill/SKILL.md` (behavior rules skill, installed to `~/.claude/skills/secretary/`)

**Install path:** `~/.claude/the-secretary/` (engine, config, LLM; auto-migrates from legacy `~/.claude/summarizer/` on re-install). Project data lives in each project's `.claude/the-secretary/`.

**Requirements:** macOS/Linux, Node.js 18+, llama-server (llama.cpp) or MLX in PATH, ~1–15 GB disk for the summary model (sized by RAM; none with `provider: claude_cli`). Optional semantic search: a venv with `mlx-embeddings` (Apple Silicon, ~600 MB model) — see `plugins/secretary/INSTALL.md`

---

### SafeEdit

> [`plugins/safe-edit/`](plugins/safe-edit/)

Safer replacement for `sed -i`, `perl -i`, and `awk -i inplace` in Claude Code sessions. Ships as a Node CLI plus a `PreToolUse` hook that **blocks the dangerous commands** and points the agent at the safer one.

- **Dry-run by default** — shows a unified diff; `--apply` is opt-in
- **Backups to `.safe-edit-backups/<timestamp>/`** with auto-prune (default: keep 7 days, max 20 batches)
- **Literal match by default**, `--regex` opt-in (with `$1`/`$2`/`$&` backrefs)
- **Multiple globs in one invocation**
- **Hook only blocks WRITES** — read-only sed/awk/perl (`cat | sed`, `awk '{print}'`, `sed -n`) still work

**Includes:** `src/safe-edit.mjs`, `src/block-inplace-edit.mjs`, `hooks.json`, `install.sh`, `skill/SKILL.md`, `claude-md-snippet.md`

**Install path:** `~/.claude/safe-edit/` (CLI + hook), `~/.claude/skills/safe-edit/` (behavior rules).

**Requirements:** Node.js 18+, npm.

---

### CodeIndex

> [`plugins/code-index/`](plugins/code-index/)

A fast, incremental **symbol index** so the agent can answer *"where is `X` defined?"*, *"what references it?"*, and *"how does this project wire together?"* in milliseconds instead of reading thousands of files or spawning search agents on every change. Thin layer over **universal-ctags** (symbol extraction, ~150 languages) + **SQLite** (`node:sqlite`, symbols + a relational edge graph, queried in ms).

- **Per-project**, stored at `<project-root>/.claude/codeindex.db` (git root, else cwd)
- **Incremental** — only files whose content hash changed are re-parsed; a no-op reindex touches zero files
- **Auto-fresh** — a `SessionStart` hook reindexes each session; manual `index` / `index --full` available
- **Symbol commands:** `where`, `refs`, `file`, `grep`, `stats`, `index`
- **Relational thread** (deterministic edge graph, no LLM): `callers` (who uses a symbol), `deps` (what a file imports + calls into), `arch` (module dependency map), `flow` (up/downstream of a module)
- **Also indexes** JS embedded in PHP/HTML templates; non-git projects fall back to a scoped file scan
- **Shortcut, not a replacement** — ctags indexes definitions; `refs` augments with a ripgrep textual scan

**Includes:** `src/codeindex.mjs`, `src/reindex-hook.mjs`, `hooks.json`, `install.sh`, `skill/SKILL.md`, `src/claude-md-snippet.md`

**Install path:** `~/.claude/codeindex/` (engine + hook), `~/.claude/skills/code-index/` (behavior rules).

**Requirements:** Node.js 22+ (built-in `node:sqlite`), universal-ctags (`brew install universal-ctags`).

---

## Skills

Skill files (`.md`) that teach the agent specific behaviors and workflows. Drop them into `.claude/skills/` or `.opencode/skills/` and the agent picks them up automatically.


### GFXPerf

> [`skills/gfx-perf/`](skills/gfx-perf/)

A skill for performance work on **graphics code in the browser** — JavaScript hot loops, Canvas2D and WebGPU. A method and a set of rules, not a tool: it makes the agent measure properly before and after, find the slow layer before touching it, and write down what was tried.

- **The loop:** reproduce and count → baseline → locate (script, garbage collection, state changes, fill rate, GPU) → change one thing → measure interleaved → keep or delete → write it down
- **Measuring:** a real browser on the real display (never headless), a button starts it, warm-up, a plain loop (never inside `requestAnimationFrame`), the median, variants interleaved, numbers shown on the page
- **JavaScript:** allocate nothing per frame — arrays, typed arrays and objects created once and reused —, do less before doing it faster, one shape per object and one kind per array
- **Canvas2D:** group by style, one path for many shapes, static layers cached, no readback in the frame
- **WebGPU:** pipelines, bind groups and buffers created once; one upload per buffer per frame; few draw calls and passes; fragments are the bill
- **Also ships:** a measuring harness for a page with a Run button, the findings log's format, and a script that downloads the WebGPU and WGSL specifications for local search

**Includes:** `skill/SKILL.md`, `skill/references/` (`javascript.md`, `canvas2d.md`, `webgpu.md`, `measuring.md`), `skill/templates/` (`measure.js`, `findings.md`), `skill/scripts/fetch-specs.sh`, `src/claude-md-snippet.md`, `install.sh`

**Install path:** `~/.claude/skills/gfx-perf/` (or a project's `.claude/skills/gfx-perf/` with `--project`).


### Defensive Development

> [`skills/defensive-development/`](skills/defensive-development/)

A set of verification-first coding practices that prevent the most common AI agent mistakes: inventing property names, forgetting imports, calling methods that don't exist, and breaking code during refactors.

```
┌───────────────────────────────────────────────────────────────┐
│                                                               │
│  DEFENSIVE DEVELOPMENT                                        │
│                                                               │
│  Protocol: READ → MAP → LIST → PRESENT → WAIT → EXECUTE       │
│                                                               │
│  Before editing     Read the file first, verify API names     │
│  Before deleting    Confirmation based on line count          │
│  Before refactoring Grep ALL references across codebase       │
│  Before debugging   Add logs first, then change code          │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

**Key features:**
- READ-VERIFY protocol for every file operation
- API discovery rules: find properties, constructors, getters/setters before using them
- Safe refactoring: grep all references (code, tests, docs, config, comments)
- Deletion thresholds: 1-10 proceed, 11-50 explain, 51-100 justify, 100+ break down
- Debug first: add logs before changing code

**Includes:** `SKILL.md`, `README.md`

---

### ASCII Art Diagrams

> [`skills/ascii-art-diagrams/`](skills/ascii-art-diagrams/)

Rules for the agent to generate consistent, well-formatted ASCII diagrams using Unicode box-drawing characters.

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│  Boxes     Equal-length lines, correct corners          │
│  Trees     │ spacers between siblings                   │
│  Arrows    Own line, never inline with text             │
│  Titles    ─── separators (not ═══)                     │
│  Font      Fira Code recommended, line-height 1         │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

**Includes:** `SKILL.md`, `README.md`

---

### Project Structure

> [`skills/project-structure/`](skills/project-structure/)

Self-healing skill that auto-generates and maintains a `.claude/structure.md` file documenting the project's directory tree, key files, their purposes, and relationships.

```
┌───────────────────────────────────────────────────────────┐
│                                                           │
│  PROJECT STRUCTURE SKILL                                  │
│                                                           │
│  1. Agent detects .claude/structure.md is missing         │
│     - Scans codebase with find + file analysis            │
│     - Builds annotated directory tree                     │
│     - Writes organized docs to .claude/structure.md       │
│                                                           │
│  2. Self-healing: regenerates when outdated               │
│                                                           │
└───────────────────────────────────────────────────────────┘
```

**Includes:** `SKILL.md`, `README.md`

---

### Project API

> [`skills/project-api/`](skills/project-api/)

Self-healing skill that auto-generates and maintains a `.claude/api.md` reference documenting the project's public API: classes with methods, inheritance hierarchies, constructor parameters, and exported functions.

```
┌───────────────────────────────────────────────────────────┐
│                                                           │
│  PROJECT API SKILL                                        │
│                                                           │
│  Extracts:                                                │
│  - Class hierarchies (Parent -> Child)                    │
│  - Methods, constructors, getters/setters                 │
│  - Standalone exported functions with parameters          │
│                                                           │
│  Output: .claude/api.md                                   │
│  Self-healing: regenerates when missing or stale          │
│                                                           │
└───────────────────────────────────────────────────────────┘
```

**Includes:** `SKILL.md`, `README.md`

---

### Secure Coding

> [`skills/secure-coding/`](skills/secure-coding/)

Security and data-integrity rules for server-side code. Distilled from a real audit that found a one-click admin-takeover CSRF, a `..` that reached a recursive delete, and three separate bugs that destroyed user content. Every rule is shown twice — **PHP** (classic server app) and **TypeScript / Next.js** (App Router, Drizzle) — because the same failure wears different clothes in each stack.

```
┌───────────────────────────────────────────────────────────┐
│                                                           │
│  FAIL CLOSED — missing info is never permission to act    │
│                                                           │
│  Writes    Empty payload never overwrites stored data     │
│  Auth      Unmapped action = strictest permission         │
│  CSRF      GET read-only, enforced by allowlist           │
│  Paths     Validate, resolve, verify containment          │
│  SQL       Allowlist identifiers, sync with live schema   │
│  Escape    Per-context: HTML is not JS is not URL         │
│                                                           │
│  Every rule maps to a bug that actually existed           │
│                                                           │
└───────────────────────────────────────────────────────────┘
```

Also covers the auditing method itself: fan out over independent vectors, verify by reading the code before reporting, and reproduce before believing — a draft-leak finding tested false at first only because the database had no drafts.

**Includes:** `SKILL.md`, `README.md`

---

## Others

Full-featured plugins with runtime logic that hook into the agent's lifecycle events.


### Microbrain

> [`others/microbrain/`](others/microbrain/)

Persistent SQLite memory system for OpenCode. A single TypeScript file that registers custom tools and lifecycle hooks directly in the agent runtime.

```
┌───────────────────────────────────────────────────────────┐
│                  MICROBRAIN ARCHITECTURE                  │
├───────────────────────────────────────────────────────────┤
│                                                           │
│  PLUGIN (.opencode/plugins/microbrain.ts)                 │
│  - session.created: auto-load high-importance memories    │
│  - session.compacting: extract + save (LLM/heuristic)     │
│  - registers custom tools:                                │
│      memory_search   FTS5 full-text search                │
│      memory_save     insert/update with validation        │
│      memory_delete   delete memories by ID                │
│      memory_stats    overview of stored knowledge         │
│                                                           │
│  STORAGE                                                  │
│  - .opencode/memory.db (SQLite + FTS5)                    │
│                                                           │
│  OPTIONAL LLM                                             │
│  - .opencode/models/qwen2.5-0.5b-instruct-q4_k_m.gguf     │
│    (used for extraction on compaction, ~500MB)            │
│                                                           │
└───────────────────────────────────────────────────────────┘
```

**Key features:**
- Auto-loads the 8 most important memories at session start
- Auto-extracts learnings before context compaction (LLM or heuristic fallback)
- FTS5 full-text search with filters by type, file, importance
- Auto-deduplication (updates if subject matches)
- Six memory types: `error`, `api`, `decision`, `pattern`, `context`, `preference`
- Bilingual pattern matching (English + Spanish)

**Includes:** `others/microbrain/plugins/microbrain.ts`, `others/microbrain/plugins/README.md`, `INSTALL.md`, `package.json.example`

**Requirements:** OpenCode with plugin support, Bun runtime, optionally Node.js >= 18 for LLM extraction

---

### Block Destructive

> [`others/block-destructive/`](others/block-destructive/)

A Claude Code `PreToolUse` hook that blocks destructive Bash commands — `rm -rf`, `git reset --hard`, `DROP TABLE`, `--no-verify`, and more — even in auto / bypass-permissions mode. Includes an `# approved` escape hatch for intentional destructive operations.

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  BLOCK-DESTRUCTIVE                                               │
│                                                                  │
│  Claude runs:     rm -rf /path/to/something                      │
│        │                                                         │
│        ▼                                                         │
│  Hook inspects:   matches "rm -rf" pattern                       │
│        │                                                         │
│        ▼                                                         │
│  Decision:        deny  →  Claude must re-plan or ask the user   │
│                                                                  │
│  Escape hatch:    rm -rf /path # approved    →  allowed          │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

**What it blocks:**
- Filesystem: `rm -rf`, `mkfs`, `dd if=…`, writes to `/dev/sd*|disk*|nvme*`
- Git: `reset --hard`, `push --force`, `clean -f`, `branch -D`, `checkout .`, `stash drop/clear`, any `--no-verify`
- SQL: `DROP TABLE/DATABASE/SCHEMA`, `TRUNCATE`, `DELETE`/`UPDATE` without `WHERE`
- DB CLIs: `dropdb`, mongo `dropDatabase()`/`deleteMany({})`, redis `FLUSHDB`/`FLUSHALL`

**Escape hatch:** append `# approved` to any command to skip all checks.

**Install:** `bash install.sh` (auto-merges hook into `~/.claude/settings.json`)

**Includes:** `src/block-destructive.sh`, `src/hooks.json`, `install.sh`, `INSTALL.md`, `README.md`

**Requirements:** `jq`, `node` (for installer), Claude Code

---

## Tools

Standalone programs for development workflows. They work without the agent; some ship a skill to control them.


### Microproxy

> [`tools/microproxy/`](tools/microproxy/)

Zero-config local subdomain routing with auto-start for any project type (PHP, Node, Python, static).

```
┌───────────────────────────────────────────────────────────┐
│                                                           │
│  MICROPROXY                                               │
│                                                           │
│  Browser -> myapp.localhost:80                            │
│          -> microproxy (ports 80 + 53, user, no root)     │
│          -> routes by Host header                         │
│          -> auto-starts server if not running             │
│          -> 127.0.0.1:PORT (your dev server)              │
│                                                           │
├───────────────────────────────────────────────────────────┤
│                                                           │
│  FEATURES                                                 │
│  - Finds servers started by hand (folder = subdomain)     │
│  - Auto-detect project type (PHP, Node, Python, static)   │
│  - Auto-start servers on first request                    │
│  - Persistent registry survives reboots                   │
│  - Idle cleanup after 15min inactivity                    │
│  - CLI tool: devproxy list/start/stop/remove              │
│                                                           │
└───────────────────────────────────────────────────────────┘
```

**Includes:** `central/proxy.js`, `client/devproxy.js`, `central/install.sh`, `INSTALL.md`, `README.md`

**Requirements:** macOS, Node.js 18+

---

### Claude Launcher

> [`tools/claude-launcher/`](tools/claude-launcher/)

VS Code extension that adds one-click launchers for Claude Code in the Activity Bar (left) and the Status Bar (bottom). Opens Claude as an editor tab (not the terminal panel) with an optional `--dangerously-skip-permissions` flag, and keeps a live counter of open sessions.

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│  CLAUDE LAUNCHER (VS Code extension)                    │
│                                                         │
│  Activity Bar  ──▶  icon     ──▶  opens Claude tab      │
│  Status Bar    ──▶  Claude   ──▶  opens Claude tab      │
│                                                         │
│  Internally uses vscode.window.createTerminal with      │
│    location = TerminalLocation.Editor                   │
│    shellArgs = claude --dangerously-skip-permissions    │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

**Includes:** `extension.js`, `package.json`, `icon.svg`, `claude-terminal-launcher-0.1.0.vsix`, `INSTALL.md`, `README.md`, `LICENSE`

**Install:** `code --install-extension claude-terminal-launcher-0.1.0.vsix`

**Requirements:** VS Code 1.85+, Claude Code CLI (`claude`) in PATH

---

## OpenCode MLX

> [`opencodemlx/`](opencodemlx/)

Local AI coding assistant powered by Apple Silicon. Runs Qwen3.5-4B with TurboQuant KV cache compression for fast, private inference on-device.

```
┌───────────────────────────────────────────────────────┐
│                                                       │
│  OpenCode MLX + TurboQuant                            │
│                                                       │
│  ┌─────────────────────────────────────────────────┐  │
│  │  OpenCode (TUI)                                 │  │
│  │  /v1/chat/completions + tool calling            │  │
│  ├─────────────────────────────────────────────────┤  │
│  │  MLX + TurboQuant Server (localhost:8899)       │  │
│  │  Qwen3.5-4B-MLX-8bit, KV cache 3-6x compress    │  │
│  │  Tool calling, document/codebase pre-loading    │  │
│  ├─────────────────────────────────────────────────┤  │
│  │  Apple Silicon GPU (Metal)                      │  │
│  └─────────────────────────────────────────────────┘  │
│                                                       │
└───────────────────────────────────────────────────────┘
```

**Key features:**
- ~78 tok/s prefill, ~42 tok/s decode on M4 Pro
- Up to 262K token context with TurboQuant 4-bit KV cache compression
- OpenAI-compatible API with streaming and tool calling
- Pre-load codebases or documents into KV cache for instant queries
- One-command installer with Python virtualenv

**Includes:** `server.py`, `install.sh`, `start-server.sh`, `stop-server.sh`, `status.sh`

**Requirements:** macOS with Apple Silicon, Python 3.11+, ~10 GB disk, 16 GB+ RAM (64 GB+ for full 256K context)

---

## Boilerplate

> [`boilerplate/`](boilerplate/)

Project template with configuration files and instructions. No pre-installed components -- you choose what to install.

```
┌───────────────────────────────────────────────────────────┐
│                                                           │
│  BOILERPLATE                                              │
│                                                           │
│  - AGENTS.md      Agent instructions template             │
│  - .gitignore     Standard ignores for agent projects     │
│  - tasks/         Planning docs folder                    │
│  - SETUP.md       Step-by-step install guide              │
│                                                           │
│  Placeholders: {{PROJECT_NAME}}, {{TECH_STACK}}, {{PORT}} │
│                                                           │
└───────────────────────────────────────────────────────────┘
```

**Quick start:**
```bash
cp boilerplate/AGENTS.md /path/to/your/project/
cp boilerplate/.gitignore /path/to/your/project/
mkdir -p /path/to/your/project/.opencode/skills
mkdir -p /path/to/your/project/.opencode/plugins
ln -s .opencode .claude
# Install skills/plugins you need (see boilerplate/SETUP.md)
```

See [`boilerplate/SETUP.md`](boilerplate/SETUP.md) for the full guide.

---

## Installation

Each component has its own installation docs. General pattern:

```bash
# Skills -- copy to your project's .claude/skills/ or .opencode/skills/
mkdir -p /path/to/project/.claude/skills
cp -r skills/defensive-development /path/to/project/.claude/skills/

# Plugins -- copy to .opencode/plugins/
mkdir -p /path/to/project/.opencode/plugins
cp others/microbrain/plugins/microbrain.ts /path/to/project/.opencode/plugins/

# Symlink for Claude Code compatibility
cd /path/to/project && ln -s .opencode .claude
```

Or use the [boilerplate](#boilerplate) to get everything set up at once.

---

## Compatibility

```
┌──────────────┬────────────────────────────────────────────────┐
│  Platform    │  Support                                       │
├──────────────┼────────────────────────────────────────────────┤
│  OpenCode    │  Native (.opencode/skills/ and /plugins/)      │
│  Claude Code │  Via .claude/ symlink to .opencode/            │
│  macOS       │  Full support (tools require lsof, pfctl)      │
│  Linux       │  Skills and plugins work. Tools are macOS-only │
└──────────────┴────────────────────────────────────────────────┘
```

---

## Changelog

| Date       | Change                                                                                      |
|------------|---------------------------------------------------------------------------------------------|
| 2026-10-30 | TheSecretary v2.16.0: status line face `( ∵ᴖ ᴗ ᴖ∵ )` with blinks and gestures, always the same width; shorter context bar; launcher documented in the install steps |
| 2026-10-30 | TheSecretary v2.15.0: status line starts with an animated `(·_·) Secretary` face that blinks and now and then plays a short gesture without shifting the line |
| 2026-10-30 | TheSecretary v2.14.0: status line shows context against the limit (`56K/500K`), model and effort, cost, 5 h / 7 d plan usage, prompt-cache minutes left and the account |
| 2026-10-30 | TheSecretary v2.13.0: `secretary` launcher — start with `secretary` (same arguments as `claude`) and a trimmed session reopens by itself with the prompt just sent; status line shows the account |
| 2026-10-28 | TheSecretary v2.11.0: `/secretary ai` shows or switches the summarizing AI (`local`, `apple`, `claude [model]`) and, with `--account`, which Claude account the CLI bills (by folder, email or fragment); the skill is renamed `the-secretary` → `secretary`; off-project sessions get one `OFF-PROJECT:` line instead of the handoff. GFXPerf v1.2.0. CLAUDE.Global v1.4.0: The Secretary section marker bumped to `secretary` v2.11.0 |
| 2026-10-16 | TheSecretary v2.10.0: after `/clear`, restore injects the verbatim end of the previous conversation (~5000 chars) so Claude can tell whether it broke off mid-task; the "Memory recovered" notification waits for the previous handoff to land. CLAUDE.Global v1.3.3: The Secretary section marker bumped to v2.10.0 |
| 2026-10-11 | Add GFXPerf v1.0.0: performance method and rules for graphics code in the browser (JavaScript, Canvas2D, WebGPU), with a measuring harness, a findings log format and a WebGPU / WGSL specification fetcher |
| 2026-10-10 | TheSecretary v2.9.8: short LLM answers (intents, ids to forget, notification blurb) are no longer discarded as empty summaries; docs brought in line with the code (model table by RAM, hook table, installer steps). CLAUDE.Global v1.3.2: two rules added (read what an edit refers to first; hover-revealed controls toggle `visibility`) |
| 2026-10-09 | TheSecretary v2.8.0–v2.9.7: handoff wait after `/clear` (async `await-handoff --rewake` hook + status line), local hooks folder, idle reaper for the shared LLM server, `claude_cli` provider no longer spawns itself, recall and "where were we" questions answered from the skill and the handoff — see `TheSecretary/README.md` changelog |
| 2026-09-25 | TheSecretary v2.5.0: transcript as source of truth — index reads transcripts with its own cursor from every hook (pure-chat turns were dropped), full turns in 800-char chunks, pasted screenshots persisted, `index-turns --rebuild`; search fuses FTS5 + vectors (RRF, exact-first, dedupe), vector floor 0.62 → 0.5; INSTALL.md rewritten (hooks from `hooks.json`, embedding venv, upgrade steps) |
| 2026-07-22 | TheSecretary: per-project storage — DB + bullets cache move into `<projectRoot>/.claude/the-secretary/` so memory travels with the folder; global DB keeps only `global` items (attached via unified `all_items` view); filesystem-based project-root resolution; automatic non-destructive migration from the old global DB and legacy cache |
| 2026-07-09 | CLAUDE.Global: restructure behavior rules as terse headline + enforcement detail        |
| 2026-06-22 | CodeIndex: relational edge graph (`callers`/`deps`/`arch`/`flow`), JS embedded in PHP/HTML templates, hardened non-git fallback + OOM/large-line guards |
| 2026-06-22 | Add CodeIndex plugin: incremental symbol index with signatures + doc hints (`where`/`refs`/`file`/`grep`/`stats`) |
| 2026-04-22 | TheSecretary: chunked LLM summarization — conversation split into bounded chunks (every N tool calls / min M chars), each chunk sent to the local LLM immediately for a fresh summary, stored with incremental `chunk_index` in SQLite + per-project `.md` cache. Consolidation pass merges chunks on session end; second LLM pass compacts if merged summary exceeds size budget. Keeps every call small, prevents context blow-up, no oversized single-shot summaries |
| 2026-04-22 | TheSecretary: use Llama-3.2-3B-4bit (MLX) on all chips, drop chip-based model gating         |
| 2026-04-22 | TheSecretary: optimize startup for low-power machines (M1 base)                              |
| 2026-04-20 | TheSecretary: English context blurb in session-end notification                              |
| 2026-04-17 | TheSecretary: recall-on-demand — UserPromptSubmit hook auto-injects context when user asks "do you remember?" (EN) or "¿recuerdas?" (ES), with cache-first + DB fallback search |
| 2026-04-17 | Add claude-launcher tool: VS Code extension with Activity Bar + Status Bar launchers for Claude Code |
| 2026-04-17 | Add block-destructive plugin: PreToolUse hook to block dangerous Bash commands with `# approved` escape hatch |
| 2026-04-16 | TheSecretary: per-project pre-generated cache to speed up SessionStart restores              |
| 2026-04-05 | devproxy: auto-start servers, persistent project registry, CLI tool, multi-language support  |
| 2026-04-05 | TheSecretary: global scope for memories, notes, and reminders across all projects            |
| 2026-04-01 | Add OpenCode MLX: local AI coding assistant with TurboQuant on Apple Silicon                  |
| 2026-03-30 | Add TheSecretary: local LLM context summarizer for Claude Code                               |
| 2026-03-18 | devproxy: retry with backoff, styled error page, route naming support                       |
| 2026-03-18 | ASCII skill: add character count verification rule (Rule 8)                                 |
| 2026-03-12 | devproxy: replace pfctl with LaunchDaemon listening directly on port 80                     |
| 2026-03-12 | Restructure microlocalhostproxy into central/client modules with install script             |
| 2026-03-10 | Unify all tree structures to Unicode characters and fix box widths                          |
| 2026-03-10 | Rewrite all READMEs with ASCII art diagrams using Unicode box-drawing characters            |
| 2026-03-10 | Initial release: skills, plugins, tools, and boilerplate for AI coding agents               |

---

## License

MIT
