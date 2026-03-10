# Project Structure Skill

Auto-generates and maintains project directory structure documentation.

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
│  Philosophy: "Always know where you are"                      │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

## What is it

A self-healing skill that scans your codebase and generates a `.claude/structure.md` file documenting the directory tree, key files, their purposes, and relationships.

## Features

- **Directory tree with descriptions:** Annotated file tree
- **Key file identification:** Entry points, configs, main modules
- **Relationship mapping:** How directories relate to each other
- **Self-healing:** Auto-regenerates when missing or outdated
- **Auto-installing:** Runs on first session in a project

## Output

Generates `.claude/structure.md` with:
- Full directory tree with purpose annotations
- Key files and their roles
- Project organization summary

## Installation

```bash
mkdir -p .claude/skills/project-structure
cp SKILL.md README.md /path/to/project/.claude/skills/project-structure/
```

## Requirements

- Claude Code or OpenCode with skills support
- `bash`, `find`, `grep` (standard Unix tools)

## License

MIT
