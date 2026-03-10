# Project API Skill

Auto-generates and maintains project API documentation.

```
┌───────────────────────────────────────────────────────────────┐
│                                                               │
│  PROJECT API SKILL                                            │
│                                                               │
│  1. Agent detects .claude/api.md is missing or outdated       │
│     │                                                         │
│     ├── Scans *.js and *.ts files via grep/awk                │
│     │                                                         │
│     ├── Extracts classes, methods, exports, hierarchies       │
│     │                                                         │
│     └── Writes organized reference to .claude/api.md          │
│                                                               │
│  2. Self-healing: regenerates after major code changes        │
│                                                               │
│  Philosophy: "Know the API before you code"                   │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

## What is it

A self-healing skill that extracts classes, functions, exports, and inheritance hierarchies from your codebase and generates a `.claude/api.md` reference file.

## Features

- **Class hierarchy extraction:** Inheritance chains (`Parent → Child`)
- **Method signatures:** Constructor params, public methods, getters/setters
- **Function exports:** Standalone functions with parameters
- **Self-healing:** Auto-regenerates when missing or outdated
- **Auto-installing:** Runs on first session or after major code changes

## Output

Generates `.claude/api.md` with:
- Class hierarchy diagram
- Classes with methods, constructors, and inheritance
- Standalone exported functions
- Parameter signatures

## Installation

```bash
mkdir -p .claude/skills/project-api
cp SKILL.md README.md /path/to/project/.claude/skills/project-api/
```

## Requirements

- Claude Code or OpenCode with skills support
- `bash`, `grep`, `awk` (standard Unix tools)

## License

MIT
