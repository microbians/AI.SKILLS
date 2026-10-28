const vscode = require('vscode');

let sessionCount = 0;
const claudeTerminals = new Set();
let statusBarItem;

function buildShellArgs() {
  const config = vscode.workspace.getConfiguration('claudeLauncher');
  const skip = config.get('skipPermissions', true);
  const cmd = skip ? 'claude --dangerously-skip-permissions' : 'claude';
  return ['-c', `${cmd}; exec bash`];
}

function openClaude() {
  sessionCount++;
  const config = vscode.workspace.getConfiguration('claudeLauncher');
  const shellPath = config.get('shellPath', '/bin/bash');

  const terminal = vscode.window.createTerminal({
    name: `Claude #${sessionCount}`,
    location: vscode.TerminalLocation.Editor,
    shellPath,
    shellArgs: buildShellArgs(),
  });
  terminal.show();
  claudeTerminals.add(terminal);
  updateStatusBar();
}

function updateStatusBar() {
  if (!statusBarItem) return;
  statusBarItem.text =
    claudeTerminals.size > 0
      ? `$(sparkle) Claude (${claudeTerminals.size})`
      : '$(sparkle) Claude';
}

function activate(context) {
  statusBarItem = vscode.window.createStatusBarItem(
    'claudeLauncher.statusbar',
    vscode.StatusBarAlignment.Left,
    -100
  );
  statusBarItem.name = 'Claude Launcher';
  statusBarItem.tooltip = 'Open Claude Code';
  statusBarItem.command = 'claudeLauncher.open';
  updateStatusBar();
  statusBarItem.show();

  const openCmd = vscode.commands.registerCommand('claudeLauncher.open', openClaude);

  const terminalClose = vscode.window.onDidCloseTerminal((closed) => {
    if (claudeTerminals.has(closed)) {
      claudeTerminals.delete(closed);
      updateStatusBar();
    }
  });

  const viewProvider = {
    resolveWebviewView(webviewView) {
      webviewView.webview.options = { enableScripts: false };
      webviewView.webview.html =
        '<html><body style="font-family:sans-serif;padding:12px;color:#ccc"><p>Launching Claude Code…</p></body></html>';
      openClaude();
      vscode.commands.executeCommand('workbench.action.closeSidebar');
    },
  };

  context.subscriptions.push(
    statusBarItem,
    openCmd,
    terminalClose,
    vscode.window.registerWebviewViewProvider('claudeLauncher.view', viewProvider)
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
