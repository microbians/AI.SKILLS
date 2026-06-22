# AI.SKILLS

Skills, plugins, and tools for AI coding agents (OpenCode, Claude Code).

A collection of drop-in components that give AI agents persistent memory, safer coding habits, auto-generated documentation, and better local development workflows.

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  AI.SKILLS                                                      │
│                                                                 │
│  TheSecretary/               Local LLM context summarizer       │
│                              + recall-on-demand ("remember?")   │
│                                                                 │
│  SafeEdit/                   sed -i replacement: diff preview,  │
│                              backups + auto-prune (Node CLI)    │
│                                                                 │
│  skills/                                                        │
│    - ascii-art-diagrams/     Unicode diagram formatting rules   │
│    - defensive-development/  Verify-first coding practices      │
│    - project-structure/      Auto-gen directory structure docs  │
│    - project-api/            Auto-gen API reference docs        │
│                                                                 │
│  others/                                                        │
│    - microbrain/             Persistent SQLite memory system    │
│    - block-destructive/      Block destructive Bash commands    │
│                                                                 │
│  utilities/                                                     │
│    - microlocalhostproxy/    Zero-config subdomain + auto-start │
│    - claude-launcher/        VS Code extension (Activity Bar +  │
│                              Status Bar launcher for Claude)    │
│                                                                 │
│  opencodemlx/                Local AI coding assistant (MLX)    │
│                                                                 │
│  boilerplate/                Project template + instructions    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Table of Contents

- [TheSecretary](#thesecretary) ⭐
- [SafeEdit](#safeedit)
- [Skills](#skills)
  - [Defensive Development](#defensive-development)
  - [ASCII Art Diagrams](#ascii-art-diagrams)
  - [Project Structure](#project-structure)
  - [Project API](#project-api)
- [Others](#others)
  - [Microbrain](#microbrain)
  - [Block Destructive](#block-destructive)
- [Utilities](#utilities)
  - [Microlocalhostproxy](#microlocalhostproxy)
  - [Claude Launcher](#claude-launcher)
- [OpenCode MLX](#opencode-mlx)
- [Boilerplate](#boilerplate)
- [Installation](#installation)
- [Compatibility](#compatibility)
- [Changelog](#changelog)
- [License](#license)

---

## TheSecretary

> [`TheSecretary/`](TheSecretary/)

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
- **Recall-on-demand** — detects recall-style prompts (`do you remember`, `do you recall`, `remember when`, plus `¿recuerdas?` / `te acuerdas?` in Spanish) via UserPromptSubmit hook and auto-injects matching snippets from cache + DB before Claude replies
- **Chunked summarization + immediate LLM call** — conversation is broken into bounded chunks (every `summarize_every_n` tool calls, minimum `min_new_chars` of new content), each chunk is sent to the local LLM right away for a fresh summary, then stored with an incremental `chunk_index` in SQLite and appended to the per-project `.md` cache. This keeps every LLM call small and fast, prevents context blow-up, and ensures no long conversation is ever summarized in a single oversized request
- **Consolidation + compaction pass** — on session end / restore, chunks are consolidated into a single summary; if the merged summary exceeds the size budget, a second LLM pass compacts it under 3500 chars while preserving critical info
- Per-project pre-generated cache `.md` files for fast SessionStart restores
- PreCompact hook warns before Claude Code's native compaction, suggests `/clear` to use local summaries instead
- SessionStart hook injects saved summaries on `/clear`, `startup`, or `resume`
- Memories, notes, reminders with regex detection + bilingual date parsing (EN/ES)
- Global scope: memories, notes, and reminders can be shared across all projects
- SQLite storage for persistent summaries across sessions
- Configurable: model, summarization frequency (`summarize_every_n`), min content threshold (`min_new_chars`), token limits, remote LLM support

**Includes:** `summarize.mjs`, `start-llm.sh`, `config.json`, `hooks.json`, `install.sh`, `claude-md-snippet.md`, `skill/SKILL.md` (behavior rules skill, installed to `~/.claude/skills/the-secretary/`)

**Install path:** `~/.claude/the-secretary/` (auto-migrates from legacy `~/.claude/summarizer/` on re-install).

**Requirements:** macOS/Linux, Node.js 18+, llama-server (llama.cpp) or MLX in PATH, ~2GB disk for the GGUF model

---

## SafeEdit

> [`SafeEdit/`](SafeEdit/)

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

## CodeIndex

> [`CodeIndex/`](CodeIndex/)

A fast, incremental **symbol index** so the agent can answer *"where is `X` defined?"* and *"what references it?"* in milliseconds instead of reading thousands of files or spawning search agents on every change. Thin layer over **universal-ctags** (symbol extraction, ~150 languages) + **SQLite** (`node:sqlite`, queried in ms).

- **Per-project**, stored at `<project-root>/.claude/codeindex.db` (git root, else cwd)
- **Incremental** — only files whose content hash changed are re-parsed; a no-op reindex touches zero files
- **Auto-fresh** — a `SessionStart` hook reindexes each session; manual `index` / `index --full` available
- **Commands:** `where`, `refs`, `file`, `grep`, `stats`, `index`
- **Shortcut, not a replacement** — ctags indexes definitions; `refs` augments with a ripgrep textual scan

**Includes:** `src/codeindex.mjs`, `src/reindex-hook.mjs`, `hooks.json`, `install.sh`, `skill/SKILL.md`, `src/claude-md-snippet.md`

**Install path:** `~/.claude/codeindex/` (engine + hook), `~/.claude/skills/code-index/` (behavior rules).

**Requirements:** Node.js 22+ (built-in `node:sqlite`), universal-ctags (`brew install universal-ctags`).

---

## Skills

Skill files (`.md`) that teach the agent specific behaviors and workflows. Drop them into `.claude/skills/` or `.opencode/skills/` and the agent picks them up automatically.


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

## Utilities

Standalone utilities for development workflows. Not tied to the agent's skill system.


### Microlocalhostproxy

> [`utilities/microlocalhostproxy/`](utilities/microlocalhostproxy/)

Zero-config local subdomain routing with auto-start for any project type (PHP, Node, Python, static).

```
┌───────────────────────────────────────────────────────────┐
│                                                           │
│  DEVPROXY                                                 │
│                                                           │
│  Browser -> myapp.localhost:80                            │
│          -> devproxy (port 80 LaunchDaemon)               │
│          -> routes by Host header                         │
│          -> auto-starts server if not running             │
│          -> 127.0.0.1:PORT (your dev server)              │
│                                                           │
├───────────────────────────────────────────────────────────┤
│                                                           │
│  FEATURES                                                 │
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

> [`utilities/claude-launcher/`](utilities/claude-launcher/)

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
