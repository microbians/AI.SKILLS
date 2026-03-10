# Defensive Development Skill

Skill for defensive development: verify before acting.

## What is it

A set of practices to avoid common programming errors:
- Read before editing
- Verify APIs before using
- Confirm before deleting
- Grep before refactoring

**Philosophy:** "Verify then trust" — never assume, always verify.

## Features

- **READ → VERIFY Protocol:** Read → Map → List → Present → Wait → Execute → Verify
- **API Discovery:** How to find properties, constructors, getters/setters
- **Safe Refactoring:** Grep all references before renaming
- **Deletion Thresholds:** Confirmation required based on line count
- **Debug First:** Logs before changing code

## Installation

```bash
mkdir -p .claude/skills
unzip defensive-development-skill.zip -d .claude/skills/
```

## Key Rules

### Before editing
```bash
# Read the file first
cat src/file.js

# Verify property name
grep -n "propertyName" src/
```

### Before deleting
| Lines | Action |
|-------|--------|
| 1-10 | Proceed (explain) |
| 11-50 | Explain + confirm |
| 51-100 | Detailed justification |
| 100+ | Break into smaller operations |

### Before refactoring
```bash
# Grep ALL references
grep -rn "oldName" .
# Include: code, tests, docs, config, comments
```

## Common Errors Prevented

- Inventing property names that don't exist
- Forgetting imports
- Confusing constructor options with setters
- Calling methods that don't exist
- Incorrect parameter order

## Requirements

- Claude Code with skills support

## License

MIT
