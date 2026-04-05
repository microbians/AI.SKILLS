# ASCII Art Diagrams Skill

Rules for creating consistent, well-formatted ASCII diagrams with Unicode box-drawing characters.

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│  ASCII ART DIAGRAMS                                     │
│                                                         │
│  Boxes     Equal-length lines, correct corners          │
│  Trees     │ spacers between siblings                   │
│  Arrows    Own line, never inline with text             │
│  Titles    ─── separators (not ═══)                     │
│  Font      Fira Code recommended, line-height 1         │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

## What is it

A formatting guide that teaches the agent to generate perfect ASCII diagrams. No installation or runtime needed -- it's a set of rules loaded as a skill.

## Features

- **Boxes:** Equal-length lines, Unicode corners (`┌ ┐ └ ┘`), 2-space padding
- **Trees:** `│` for vertical continuation, `├──`/`└──` for branches, 4-space indent
- **Arrows:** `▼ ▲ ◀ ▶` on their own line, `──▶──` for horizontal connectors
- **Flow charts:** Boxes connected with `│` and `▼`, side branches for YES/NO
- **Shade blocks:** `░ ▒ ▓ █` for grids, heatmaps, coverage diagrams
- **Note boxes:** Labeled sections with `┌────────┬──────┐` style

## Examples

```
┌───────────────────────────┐
│                           │
│  Box with equal lines     │
│  All lines same length    │
│                           │
└───────────────────────────┘
```

```
src/
│
├── components/
│   │
│   ├── Button.js
│   │
│   └── Input.js
│
└── utils/
```

```
┌────────┬──────────────────────────────────────────┐
│        │  Cache is NOT invalidated during         │
│  NOTE  │  batch operations!                       │
│        │  Results may be stale until refresh.     │
└────────┴──────────────────────────────────────────┘
```

## Installation

### 1. Project skill (per-project)

```bash
mkdir -p .claude/skills/ascii-art-diagrams
cp SKILL.md README.md /path/to/project/.claude/skills/ascii-art-diagrams/
```

### 2. Global verification rule (recommended)

Add this to `~/.claude/CLAUDE.md` so the agent **always** verifies ASCII art in every project:

```markdown
## ASCII Art Diagrams — MANDATORY Verification

**ALWAYS** after editing, creating, or modifying ANY ASCII box-drawing content
(diagrams, tables, boxes using │, ┌, ┐, └, ┘, ├, ┤, ─):

1. Run `wc -m` on every line of the diagram to verify all lines have the same character count
2. If any line differs, fix it BEFORE committing
3. Do NOT skip this step. Do NOT assume it's correct. ALWAYS verify with `wc -m`.
4. NEVER use tree-drawing characters (├──, └──, │) mixed with text inside box borders —
   they cause visual misalignment in GitHub monospace fonts even when `wc -m` matches

This applies to ALL files: READMEs, INSTALL.md, SKILL.md, any markdown with ASCII art.
```

Without the global rule, the agent only applies ASCII formatting when the skill is installed in the current project. With it, verification happens everywhere.

## Requirements

- Claude Code or OpenCode with skills support
- Monospace font (Fira Code recommended)

## License

MIT
