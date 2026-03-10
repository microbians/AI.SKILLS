# ASCII Art Diagrams Skill

Skill for creating consistent and well-formatted ASCII diagrams.

## What is it

A set of rules for the agent to generate perfect ASCII diagrams:
- Boxes with equal-length lines
- File trees with spacers
- Arrows on separate lines
- Consistent formatting

## Features

- **Boxes:** Equal-length lines, correct corners
- **Trees:** `│` spacers between siblings, empty lines after root
- **Arrows:** On their own line, never inline with text
- **Titles:** Use `───` (not `═══`)
- **Font:** Fira Code recommended, line-height 1

## Installation

```bash
mkdir -p .claude/skills
unzip ascii-art-diagrams-skill.zip -d .claude/skills/
```

## Usage

The agent automatically applies these rules when creating:
- Architecture diagrams
- Directory trees
- Flowcharts
- Note/warning boxes
- Tables with borders

## Example

```
┌─────────────────────────────────────┐
│  Box with equal-length lines        │
├─────────────────────────────────────┤
│  All lines have 37 characters       │
└─────────────────────────────────────┘
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

## Requirements

- Claude Code with skills support
- Monospace font (Fira Code recommended)

## License

MIT
