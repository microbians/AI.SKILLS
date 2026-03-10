# Defensive Development Skill

Verification-first coding practices for AI agents. Verify before acting.

```
┌───────────────────────────────────────────────────────────────┐
│                                                               │
│  DEFENSIVE DEVELOPMENT                                        │
│                                                               │
│  Protocol: READ → MAP → LIST → PRESENT → WAIT → EXECUTE      │
│                                                               │
│  +── Before editing      Read the file, verify API names      │
│  +── Before deleting     Confirmation based on line count     │
│  +── Before refactoring  Grep ALL references across codebase  │
│  +── Before debugging    Add logs first, then change code     │
│                                                               │
│  Philosophy: "Verify then trust"                              │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

## What is it

A set of practices that prevent the most common AI agent mistakes: inventing property names that don't exist, forgetting imports, calling non-existent methods, and breaking code during refactors.

## Features

- **READ-VERIFY protocol:** Read → Map → List → Present → Wait → Execute → Verify
- **API discovery:** How to find properties, constructors, getters/setters before using them
- **Safe refactoring:** Grep all references (code, tests, docs, config, comments) before renaming
- **Deletion thresholds:** Confirmation required based on line count
- **Debug first:** Logs before changing code

## Deletion Thresholds

```
┌─────────────┬─────────────────────────────────────────┐
│  Lines      │  Action                                  │
├─────────────┼─────────────────────────────────────────┤
│  1-10       │  Proceed (explain)                       │
│  11-50      │  Explain + confirm                       │
│  51-100     │  Detailed justification                  │
│  100+       │  Break into smaller operations           │
└─────────────┴─────────────────────────────────────────┘
```

## Common Errors Prevented

- Inventing property names that don't exist
- Forgetting imports
- Confusing constructor options with setters
- Calling methods that don't exist
- Incorrect parameter order

## Installation

```bash
mkdir -p .claude/skills/defensive-development
cp SKILL.md README.md /path/to/project/.claude/skills/defensive-development/
```

## Requirements

- Claude Code or OpenCode with skills support

## License

MIT
