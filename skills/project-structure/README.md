# Project Structure Skill

Auto-generates and maintains project directory structure documentation.

## What is it

A self-healing skill that scans your codebase and generates a `.claude/structure.md` file documenting the directory tree, key files, their purposes, and relationships.

**Philosophy:** "Always know where you are" -- instant understanding of any codebase.

## Features

- **Directory tree with descriptions** -- annotated file tree
- **Key file identification** -- entry points, configs, main modules
- **Relationship mapping** -- how directories relate to each other
- **Self-healing** -- auto-regenerates when missing or outdated
- **Auto-installing** -- runs on first session in a project

## Installation

```bash
mkdir -p .claude/skills/project-structure
cp SKILL.md /path/to/project/.claude/skills/project-structure/
```

## How it works

1. Agent detects `.claude/structure.md` is missing or outdated
2. Runs a bash generation script using `find` and file analysis
3. Builds an annotated directory tree (excludes `node_modules`, `dist`, etc.)
4. Identifies key files (configs, entry points, tests)
5. Writes organized documentation to `.claude/structure.md`

## Output

Generates `.claude/structure.md` with:
- Full directory tree with purpose annotations
- Key files and their roles
- Project organization summary

## Requirements

- Claude Code or OpenCode with skills support
- `bash`, `find`, `grep` (standard Unix tools)

## License

MIT
