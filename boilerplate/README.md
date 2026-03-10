# Agent Boilerplate

Project template for AI coding agents (OpenCode, Claude Code). Contains only configuration templates and instructions -- no pre-installed components. You choose what to install.

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

## Quick start

```bash
# 1. Copy to your project
cp AGENTS.md /path/to/your/project/
cp .gitignore /path/to/your/project/
cp -r tasks /path/to/your/project/

# 2. Create agent directories
cd /path/to/your/project
mkdir -p .opencode/skills .opencode/plugins .opencode/commands
ln -s .opencode .claude

# 3. Install skills/plugins you need (see SETUP.md)

# 4. Customize AGENTS.md (replace {{placeholders}})
```

See [SETUP.md](SETUP.md) for the full guide including how to install each skill and plugin.

## Customization

```
┌──────────────────────────┬────────────────────────────────────┐
│  Placeholder             │  Description                       │
├──────────────────────────┼────────────────────────────────────┤
│  {{PROJECT_NAME}}        │  Your project name                 │
│  {{PROJECT_DESCRIPTION}} │  What the project does             │
│  {{TECH_STACK_FRONTEND}} │  Frontend tech (e.g. Next.js)      │
│  {{TECH_STACK_BACKEND}}  │  Backend tech (e.g. Express)       │
│  {{PORT_BACKEND}}        │  Backend port number               │
│  {{PORT_FRONTEND}}       │  Frontend port number              │
└──────────────────────────┴────────────────────────────────────┘
```

## License

MIT
