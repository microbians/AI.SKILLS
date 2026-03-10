# Project API Skill

Auto-generates and maintains project API documentation.

## What is it

A self-healing skill that extracts classes, functions, exports, and inheritance hierarchies from your codebase and generates a `.claude/api.md` reference file.

**Philosophy:** "Know the API before you code" -- instant reference without reading all source files.

## Features

- **Class hierarchy extraction** -- inheritance chains (`Parent -> Child`)
- **Method signatures** -- constructor params, public methods, getters/setters
- **Function exports** -- standalone functions with parameters
- **Self-healing** -- auto-regenerates when missing or outdated
- **Auto-installing** -- runs on first session or after major code changes

## Installation

```bash
mkdir -p .claude/skills/project-api
cp SKILL.md /path/to/project/.claude/skills/project-api/
```

## How it works

1. Agent detects `.claude/api.md` is missing or outdated
2. Runs a bash generation script that scans `*.js` and `*.ts` files
3. Extracts classes, methods, constructors, exports via grep/awk
4. Writes organized documentation to `.claude/api.md`
5. Agent uses this as a quick reference during coding

## Output

Generates `.claude/api.md` with:
- Class hierarchy diagram
- Classes with methods, constructors, and inheritance
- Standalone exported functions
- Parameter signatures

## Requirements

- Claude Code or OpenCode with skills support
- `bash`, `grep`, `awk` (standard Unix tools)

## License

MIT
