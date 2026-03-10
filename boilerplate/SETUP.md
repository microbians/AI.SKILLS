# Agent Boilerplate - Setup Guide

## What Is This?

A template for new projects that work with AI coding agents (OpenCode, Claude Code). Contains only configuration templates and instructions -- no pre-installed skills or plugins. You choose what to install from the [AI.SKILLS](https://github.com/microbians/AI.SKILLS) repo.

---

## Setup

### Step 1: Copy Boilerplate Files to Your Project

```bash
cp AGENTS.md /path/to/your/project/
cp .gitignore /path/to/your/project/
cp -r tasks /path/to/your/project/
```

### Step 2: Create Agent Directories

```bash
cd /path/to/your/project
mkdir -p .opencode/skills .opencode/plugins .opencode/commands

# Symlink for Claude Code compatibility
ln -s .opencode .claude
```

### Step 3: Install Skills and Plugins

Pick what you need from the AI.SKILLS repo:

```bash
# Skills -- copy SKILL.md (and README.md if present) into .opencode/skills/<name>/
cp -r /path/to/AI.SKILLS/skills/defensive-development .opencode/skills/
cp -r /path/to/AI.SKILLS/skills/ascii-art-diagrams .opencode/skills/
cp -r /path/to/AI.SKILLS/skills/project-structure .opencode/skills/
cp -r /path/to/AI.SKILLS/skills/project-api .opencode/skills/

# Microbrain plugin -- copy the .ts file and install dependencies
cp /path/to/AI.SKILLS/plugins/microbrain/plugins/microbrain.ts .opencode/plugins/
cat > .opencode/package.json << 'EOF'
{
  "dependencies": {
    "@opencode-ai/plugin": "^1.2.0",
    "node-llama-cpp": "^3.15.1"
  }
}
EOF

# (Optional) Download LLM model for microbrain (~500MB)
mkdir -p .opencode/models
cd .opencode
npx huggingface-cli download Qwen/Qwen2.5-0.5B-Instruct-GGUF \
  qwen2.5-0.5b-instruct-q4_k_m.gguf \
  --local-dir ./models --local-dir-use-symlinks False
```

### Step 4: Customize AGENTS.md

Edit `AGENTS.md` and replace the placeholders:
- `{{PROJECT_NAME}}` -- Your project name
- `{{PROJECT_DESCRIPTION}}` -- What the project does
- `{{TECH_STACK_FRONTEND}}` -- Frontend tech (or remove section)
- `{{TECH_STACK_BACKEND}}` -- Backend tech (or remove section)
- `{{PORT_BACKEND}}` / `{{PORT_FRONTEND}}` -- Your ports

Update the skills table to reflect what you actually installed.

---

## Available Components

### Skills

| Skill | What it does |
|-------|-------------|
| `defensive-development` | Verification-first coding practices (read before edit, grep before refactor) |
| `ascii-art-diagrams` | Rules for consistent ASCII diagrams with Unicode box-drawing characters |
| `project-structure` | Auto-generates and maintains project directory structure docs |
| `project-api` | Auto-generates and maintains project API/exports docs |

### Plugins

| Plugin | What it does |
|--------|-------------|
| `microbrain` | Persistent SQLite memory system. Auto-loads memories at session start, auto-extracts before compaction. Provides `memory_search`, `memory_save`, `memory_delete`, `memory_stats` tools. |

### Tools

| Tool | What it does |
|------|-------------|
| `microlocalhostproxy` | Smart port resolution + local subdomain routing (`myapp.localhost`). macOS only. |

---

## First Session

On the first session, tell the agent:

> "Read AGENTS.md to understand the project."

Or if you have a project spec:

> "Read AGENTS.md and tasks/PROJECT_SPEC.md to understand the project."

---

## Customization

### Adding a New Skill

1. Create `.opencode/skills/my-skill/SKILL.md`
2. Add to the skills table in `AGENTS.md`
3. Agent will auto-detect on next session

### Adding Custom Commands

Put command files in `.opencode/commands/`:

```
.opencode/commands/
├── build.md      # /build command
├── deploy.md     # /deploy command
└── test.md       # /test command
```

---

## Troubleshooting

### .claude and .opencode are separate directories

They should be the same (symlink). Fix:
```bash
rm -rf .claude
ln -s .opencode .claude
```

### Agent doesn't see skills

Verify the directory structure:
```bash
ls .opencode/skills/*/SKILL.md
```

Each skill needs at least a `SKILL.md` file in its own directory.
