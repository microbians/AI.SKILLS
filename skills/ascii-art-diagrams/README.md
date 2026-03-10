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
- **Trees:** `│` for vertical continuation, `+──` for branches, 4-space indent
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
│        │  Cache is NOT invalidated during          │
│  NOTE  │  batch operations!                        │
│        │  Results may be stale until refresh.      │
└────────┴──────────────────────────────────────────┘
```

## Installation

```bash
mkdir -p .claude/skills/ascii-art-diagrams
cp SKILL.md README.md /path/to/project/.claude/skills/ascii-art-diagrams/
```

## Requirements

- Claude Code or OpenCode with skills support
- Monospace font (Fira Code recommended)

## License

MIT
