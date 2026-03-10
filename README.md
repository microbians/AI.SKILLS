# AI.SKILLS

Skills, plugins, and tools for AI coding agents (OpenCode, Claude Code).

A collection of drop-in components that give AI agents persistent memory, safer coding habits, auto-generated documentation, and better local development workflows.

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│  AI.SKILLS                                                          │
│                                                                     │
│  skills/                                                            │
│  ├── ascii-art-diagrams/       Unicode diagram formatting rules     │
│  ├── defensive-development/    Verify-first coding practices        │
│  ├── project-structure/        Auto-gen directory structure docs    │
│  └── project-api/              Auto-gen API reference docs          │
│                                                                     │
│  plugins/                                                           │
│  └── microbrain/               Persistent SQLite memory system      │
│                                                                     │
│  tools/                                                             │
│  └── microlocalhostproxy/      Smart port + subdomain routing       │
│                                                                     │
│  boilerplate/                  Project template + instructions      │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Table of Contents

- [Skills](#skills)
  - [Defensive Development](#defensive-development)
  - [ASCII Art Diagrams](#ascii-art-diagrams)
  - [Project Structure](#project-structure)
  - [Project API](#project-api)
- [Plugins](#plugins)
  - [Microbrain](#microbrain)
- [Tools](#tools)
  - [Microlocalhostproxy](#microlocalhostproxy)
- [Boilerplate](#boilerplate)
- [Installation](#installation)
- [Compatibility](#compatibility)
- [License](#license)

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
┌───────────────────────────────────────────────────────────────┐
│                                                               │
│  PROJECT STRUCTURE SKILL                                      │
│                                                               │
│  1. Agent detects .claude/structure.md is missing             │
│     │                                                         │
│     ├── Scans codebase with find + file analysis              │
│     │                                                         │
│     ├── Builds annotated directory tree                       │
│     │                                                         │
│     └── Writes organized docs to .claude/structure.md         │
│                                                               │
│  2. Self-healing: regenerates when outdated                   │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

**Includes:** `SKILL.md`, `README.md`

---

### Project API

> [`skills/project-api/`](skills/project-api/)

Self-healing skill that auto-generates and maintains a `.claude/api.md` reference documenting the project's public API: classes with methods, inheritance hierarchies, constructor parameters, and exported functions.

```
┌───────────────────────────────────────────────────────────────┐
│                                                               │
│  PROJECT API SKILL                                            │
│                                                               │
│  Extracts:                                                    │
│  +── Class hierarchies (Parent → Child)                       │
│  +── Methods, constructors, getters/setters                   │
│  +── Standalone exported functions with parameters            │
│                                                               │
│  Output: .claude/api.md                                       │
│  Self-healing: regenerates when missing or after major changes│
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

**Includes:** `SKILL.md`, `README.md`

---

## Plugins

Full-featured plugins with runtime logic that hook into the agent's lifecycle events.


### Microbrain

> [`plugins/microbrain/`](plugins/microbrain/)

Persistent SQLite memory system for OpenCode. A single TypeScript file that registers custom tools and lifecycle hooks directly in the agent runtime.

```
┌───────────────────────────────────────────────────────────────┐
│                     MICROBRAIN ARCHITECTURE                   │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│  PLUGIN (.opencode/plugins/microbrain.ts)                     │
│  +── session.created  → auto-load high-importance memories    │
│  +── session.compacting → extract + save (LLM/heuristic)      │
│  +── registers custom tools:                                  │
│      +── memory_search  → FTS5 full-text search               │
│      +── memory_save    → insert/update with validation       │
│      +── memory_delete  → delete memories by ID               │
│      +── memory_stats   → overview of stored knowledge        │
│                                                               │
│  STORAGE                                                      │
│  +── .opencode/memory.db (SQLite + FTS5)                      │
│                                                               │
│  OPTIONAL LLM                                                 │
│  +── .opencode/models/qwen2.5-0.5b-instruct-q4_k_m.gguf       │
│      (used for extraction on compaction, ~500MB)              │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

**Key features:**
- Auto-loads the 8 most important memories at session start
- Auto-extracts learnings before context compaction (LLM or heuristic fallback)
- FTS5 full-text search with filters by type, file, importance
- Auto-deduplication (updates if subject matches)
- Six memory types: `error`, `api`, `decision`, `pattern`, `context`, `preference`
- Bilingual pattern matching (English + Spanish)

**Includes:** `plugins/microbrain.ts`, `plugins/README.md`, `INSTALL.md`, `package.json.example`

**Requirements:** OpenCode with plugin support, Bun runtime, optionally Node.js >= 18 for LLM extraction

---

## Tools

Standalone utilities for development workflows. Not tied to the agent's skill system.


### Microlocalhostproxy

> [`tools/microlocalhostproxy/`](tools/microlocalhostproxy/)

Smart port resolution and local subdomain routing for Node.js dev servers on macOS.

```
┌───────────────────────────────────────────────────────────────┐
│                                                               │
│  MICROLOCALHOSTPROXY                                          │
│                                                               │
│  Browser → myapp.localhost:80                                 │
│         → pfctl redirect → 127.0.0.1:8080                     │
│         → devproxy (central proxy) → routes by Host header    │
│         → 127.0.0.1:3001 (your dev server)                    │
│                                                               │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│  PORT RESOLUTION                                              │
│  +── Port free         → use it directly                      │
│  +── Occupied by US    → kill old process, reuse port         │
│  +── Occupied by OTHER → find next free port (up to +20)      │
│                                                               │
│  PATTERNS                                                     │
│  +── Pattern A: Single server (Next.js, Vite, Express)        │
│  +── Pattern B: Multi-process (frontend + backend)            │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

**Includes:** `microlocalhostproxy.md` (full docs, code, templates), `README.md`

**Requirements:** macOS, Node.js 18+

---

## Boilerplate

> [`boilerplate/`](boilerplate/)

Project template with configuration files and instructions. No pre-installed components -- you choose what to install.

```
┌───────────────────────────────────────────────────────────────┐
│                                                               │
│  BOILERPLATE                                                  │
│                                                               │
│  +── AGENTS.md      Agent instructions template               │
│  +── .gitignore     Standard ignores for agent projects       │
│  +── tasks/         Planning docs folder                      │
│  +── SETUP.md       Step-by-step install guide                │
│                                                               │
│  Placeholders: {{PROJECT_NAME}}, {{TECH_STACK}}, {{PORT}}     │
│                                                               │
└───────────────────────────────────────────────────────────────┘
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
cp plugins/microbrain/plugins/microbrain.ts /path/to/project/.opencode/plugins/

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

## License

MIT
