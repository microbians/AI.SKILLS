# Claude Terminal Launcher

One-click launcher for [Claude Code](https://claude.com/claude-code) in VS Code.

## Features

- **Activity Bar icon** — click to open Claude Code in an editor tab.
- **Status Bar button** — `✦ Claude` in the bottom-left, with a live counter of open sessions.
- Opens Claude as an **editor tab** (not the terminal panel), using VS Code's editor terminal location.
- Keeps the shell alive with `exec bash` after Claude exits, so you can reuse the session.

## Requirements

- [Claude Code CLI](https://claude.com/claude-code) installed and available as `claude` in your PATH.

## Settings

| Setting | Default | Description |
|---|---|---|
| `claudeLauncher.skipPermissions` | `true` | Launch Claude with `--dangerously-skip-permissions`. |
| `claudeLauncher.shellPath` | `/bin/bash` | Shell used to run Claude. |

## Commands

| Command | Description |
|---|---|
| `Open Claude Code` | Opens a new Claude Code session in an editor tab. |

## License

MIT
