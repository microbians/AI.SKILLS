# Install

## Option 1 — From the `.vsix` (recommended)

```bash
code --install-extension claude-terminal-launcher-0.1.0.vsix
```

Or from VS Code UI: `Cmd+Shift+P` → `Extensions: Install from VSIX...` → pick the file.

Reload the window after installing.

## Option 2 — Rebuild from source

```bash
npx @vscode/vsce package --no-dependencies --allow-star-activation --allow-missing-repository
code --install-extension claude-terminal-launcher-*.vsix
```

## Uninstall

```bash
code --uninstall-extension microbians.claude-terminal-launcher
```
