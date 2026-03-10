# AI.SKILLS

Skills, plugins, and tools for AI coding agents (OpenCode, Claude Code).

A collection of drop-in components that give AI agents persistent memory, safer coding habits, auto-generated documentation, and better local development workflows.

---

## Table of Contents

- [Skills](#skills)
  - [Microbrain (skill)](#microbrain-skill)
  - [Defensive Development](#defensive-development)
  - [ASCII Art Diagrams](#ascii-art-diagrams)
  - [Project Structure](#project-structure)
  - [Project API](#project-api)
- [Plugins](#plugins)
  - [Microbrain (plugin)](#microbrain-plugin)
- [Tools](#tools)
  - [Microlocalhostproxy](#microlocalhostproxy)
- [Boilerplate](#boilerplate)
- [Installation](#installation)
- [Compatibility](#compatibility)
- [License](#license)

---

## Skills

Skill files (`.md`) that teach the agent specific behaviors and workflows. Drop them into `.claude/skills/` or `.opencode/skills/` and the agent picks them up automatically.

### Microbrain (skill)

> [`boilerplate/.opencode/skills/microbrain/`](boilerplate/.opencode/skills/microbrain/)

Reactive SQLite memory system that runs as a skill with a PreCompact hook. The agent stores learnings (bug fixes, API patterns, design decisions, user preferences) in a local SQLite database with FTS5 full-text search. Memories survive context compaction and are loaded automatically at the start of every session.

**Key features:**
- SQLite database with full-text search (FTS5) for instant recall
- PreCompact hook that extracts learnings before context is compacted, using a local LLM (Qwen 2.5 0.5B, ~500MB) or heuristic pattern matching as fallback
- Six memory types: `error`, `api`, `decision`, `pattern`, `context`, `preference`
- Five importance levels for prioritized recall
- Session tracking with summaries
- Self-installing: the agent detects a missing database and sets it up

**Includes:** `SKILL.md`, `INSTALL.md`, `README.md`, `install.sh`, `hooks/pre-compact.js`, `package.json`

---

### Defensive Development

> [`skills/defensive-development/`](skills/defensive-development/)

A set of verification-first coding practices that prevent the most common AI agent mistakes: inventing property names, forgetting imports, calling methods that don't exist, and breaking code during refactors.

**Key features:**
- **READ-VERIFY protocol:** Read -> Map -> List -> Present -> Wait -> Execute -> Verify
- **API discovery rules:** how to find properties, constructors, getters/setters before using them
- **Safe refactoring:** grep all references (code, tests, docs, config, comments) before renaming
- **Deletion thresholds:** confirmation required based on line count (1-10 proceed, 11-50 explain, 51-100 justify, 100+ break into smaller operations)
- **Debug first:** add logs before changing code

**Includes:** `SKILL.md`, `README.md`

---

### ASCII Art Diagrams

> [`skills/ascii-art-diagrams/`](skills/ascii-art-diagrams/)

Rules for the agent to generate consistent, well-formatted ASCII diagrams using Unicode box-drawing characters. Ensures boxes have equal-length lines, trees use proper spacers, arrows sit on their own line, and formatting stays consistent across the project.

**Key features:**
- Box drawing with equal-length lines and correct corners (`+---+`, `|   |`)
- File trees with `|` spacers between siblings and empty lines after root
- Arrows on their own line, never inline with text
- Titles use `---` separators
- Optimized for Fira Code / monospace fonts at line-height 1

**Includes:** `SKILL.md`, `README.md`

---

### Project Structure

> [`skills/project-structure/`](skills/project-structure/)

Self-healing skill that auto-generates and maintains a `.claude/structure.md` file documenting the project's directory tree, key files, their purposes, and relationships. The agent runs it on the first session or whenever the structure seems outdated.

**Key features:**
- Generates annotated directory tree via `find` and file analysis
- Excludes `node_modules`, `dist`, `build`, dotfiles
- Identifies entry points, configs, and test directories
- Self-healing: regenerates when missing or outdated
- Works with any JavaScript/TypeScript project

**Includes:** `SKILL.md`, `README.md`

---

### Project API

> [`skills/project-api/`](skills/project-api/)

Self-healing skill that auto-generates and maintains a `.claude/api.md` reference documenting the project's public API: classes with methods, inheritance hierarchies, constructor parameters, and exported functions.

**Key features:**
- Extracts class hierarchies (`Parent -> Child`)
- Lists methods, constructors, getters/setters per class
- Catalogs standalone exported functions with parameters
- Self-healing: regenerates when missing or after major code changes
- Uses `grep`/`awk` to scan `*.js` and `*.ts` files

**Includes:** `SKILL.md`, `README.md`

---

## Plugins

Full-featured plugins with runtime logic that hook into the agent's lifecycle events.

### Microbrain (plugin)

> [`plugins/microbrain/`](plugins/microbrain/)

The plugin version of Microbrain for OpenCode's plugin system. A single TypeScript file that registers custom tools and lifecycle hooks directly in the agent runtime, without needing external scripts or shell hooks.

**Key features:**
- **`session.created` event:** auto-loads the 8 most important memories and injects them as context
- **`session.compacting` event:** extracts learnings via local LLM or heuristic fallback and saves to SQLite before compaction
- **`memory_search` tool:** FTS5 full-text search with filters by type, file, importance
- **`memory_save` tool:** save learnings with validation, auto-deduplication (updates if subject matches)
- **`memory_delete` tool:** delete memories by ID
- **`memory_stats` tool:** overview of stored knowledge (counts by type, importance, recent entries)
- Automatic database creation with schema, triggers, and FTS indexes
- Input sanitization for LLM (strips control tokens, HTML tags, non-printable characters)

**Includes:** `plugins/microbrain.ts`, `plugins/README.md`, `INSTALL.md`, `package.json.example`

**Requirements:** OpenCode with plugin support, Bun runtime, optionally Node.js >= 18 for LLM extraction

---

## Tools

Standalone utilities for development workflows. Not tied to the agent's skill system.

### Microlocalhostproxy

> [`tools/microlocalhostproxy/`](tools/microlocalhostproxy/)

Smart port resolution and local subdomain routing for Node.js dev servers on macOS. Solves two problems: port conflicts between projects, and remembering port numbers.

**Port resolution:**
1. Port free -- uses it directly
2. Port occupied by THIS project -- kills the old process, reuses the port
3. Port occupied by ANOTHER project -- finds the next free port (up to +20)

Detection uses `lsof` to get the PID on the port, then checks if its working directory is inside the current project root.

**Devproxy (optional):** Routes `myproject.localhost` -> `localhost:PORT` via a central reverse proxy daemon at `~/.config/devproxy/`. First run auto-installs dnsmasq + pfctl rules. Subsequent runs just register the subdomain. Works in Safari, Chrome, Firefox -- no `/etc/hosts` editing.

**Two patterns included:**
- **Pattern A:** Single server (Next.js, Vite, Express)
- **Pattern B:** Multi-process (frontend + backend on separate ports)

Also includes AGENTS.md templates for both patterns and gotchas documentation.

**Includes:** `microlocalhostproxy.md` (full docs, code, templates), `README.md`

**Requirements:** macOS, Node.js 18+

---

## Boilerplate

> [`boilerplate/`](boilerplate/)

Ready-to-use project template with all skills pre-configured. Copy into any new project and start working with a fully equipped AI agent.

**What's included:**
- **AGENTS.md** -- Agent instructions template with placeholders (`{{PROJECT_NAME}}`, `{{TECH_STACK}}`, `{{PORT}}`, etc.)
- **`.opencode/skills/`** -- All 5 skills pre-installed (microbrain, defensive-development, project-structure, project-api, ascii-art-diagrams)
- **`.opencode/settings.json`** -- PreCompact hook configured for automatic memory extraction
- **`.opencode/commands/`** -- Empty directory for custom slash commands
- **`.gitignore`** -- Standard ignores for agent-powered projects (`.claude/`, `.opencode/`, `.env`, `node_modules/`, etc.)
- **`tasks/`** -- Planning docs folder
- **`SETUP.md`** -- Step-by-step setup guide

**Quick start:**
```bash
# Copy to your project
cp -r boilerplate/.opencode /path/to/your/project/
cp boilerplate/AGENTS.md /path/to/your/project/
cp boilerplate/.gitignore /path/to/your/project/

# Symlink for Claude Code compatibility
cd /path/to/your/project && ln -s .opencode .claude

# Initialize microbrain
.opencode/skills/microbrain/install.sh --with-llm

# Customize AGENTS.md (replace {{placeholders}})
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
cp plugins/microbrain/plugins/microbrain.ts /path/to/project/.opencode/plugins/

# Symlink for Claude Code compatibility
cd /path/to/project && ln -s .opencode .claude
```

Or use the [boilerplate](#boilerplate) to get everything at once.

---

## Compatibility

| Platform | Support |
|----------|---------|
| **OpenCode** | Native via `.opencode/skills/` and `.opencode/plugins/` |
| **Claude Code** | Via `.claude/` symlink to `.opencode/` |
| **macOS** | Full support. Tools require macOS (lsof, pfctl, dnsmasq) |
| **Linux** | Skills and plugins work. Tools (microlocalhostproxy) are macOS-only |

---

## License

MIT
