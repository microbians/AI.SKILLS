#!/usr/bin/env node
/**
 * secretary: runs `claude` with the same arguments (account flags included)
 * and reopens the session when its context is trimmed. Claude Code cannot
 * reload a running session's context, so past `context_clear_tokens` the
 * UserPromptSubmit hook trims the transcript, holds the prompt and signals
 * this launcher, which stops claude and starts it again with
 * `--resume <session> "<prompt>"`.
 */
import { spawn, execFileSync } from 'child_process';
import { readFileSync, unlinkSync, existsSync, mkdirSync, cpSync } from 'fs';
import { join, dirname, basename } from 'path';
import { homedir } from 'os';

const CLAUDE = process.env.SECRETARY_CLAUDE || 'claude';
const relaunchFile = join(homedir(), '.claude', 'the-secretary', 'relaunch', `${process.pid}.json`);

// Flags that pick or start a session: dropped on relaunch, which picks its own.
const SESSION_FLAGS = new Set(['-c', '--continue', '-r', '--resume', '--session-id', '--fork-session', '--from-pr']);

// Every option `claude --help` lists and what it takes: `--verbose` none,
// `--model <model>` one, `--resume [value]` optional, `--allowedTools <tools...>` many.
function knownFlags() {
  const flags = new Map();
  let help = '';
  try { help = execFileSync(CLAUDE, ['--help'], { encoding: 'utf-8' }); } catch { return flags; }
  // `  -r, --resume [value]`, `  --allowedTools, --allowed-tools <tools...>`, `  --verbose`
  for (const m of help.matchAll(/^\s+((?:-{1,2}[\w-]+, )*-{1,2}[\w-]+)(?: (<[^>]+>|\[[^\]]+\]))?/gm)) {
    const kind = !m[2] ? 'none' : m[2].includes('...') ? 'many' : m[2].startsWith('[') ? 'optional' : 'one';
    for (const name of m[1].split(', ')) flags.set(name, kind);
  }
  return flags;
}

// The launch arguments minus the session choice and the initial prompt.
// `ownFlagsOnly` also drops options claude does not know: a wrapper's own
// account flags (`claude -work`), which would override an account switch.
function persistentArgs(args, ownFlagsOnly = false) {
  const flags = knownFlags();
  const kept = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) continue; // initial prompt
    const name = arg.split('=')[0];
    const values = [];
    const kind = arg.includes('=') ? null : flags.get(name);
    if (kind === 'one') values.push(args[++i]);
    else if (kind === 'optional' && args[i + 1] && !args[i + 1].startsWith('-')) values.push(args[++i]);
    else if (kind === 'many') while (args[i + 1] && !args[i + 1].startsWith('-')) values.push(args[++i]);
    if (SESSION_FLAGS.has(name) || (ownFlagsOnly && flags.size && !flags.has(name))) continue;
    kept.push(arg, ...values);
  }
  return kept;
}

// Claude Code keeps sessions per account, under `<config>/projects/<cwd slug>/`
// (`~/.claude` for the default account). Copy this session's transcript and its
// folder (subagents, tool results) there so `--resume` finds it.
function moveSession({ session_id, transcript_path }, configDir) {
  const target = join(configDir === 'default' ? join(homedir(), '.claude') : configDir, 'projects', basename(dirname(transcript_path)));
  mkdirSync(target, { recursive: true });
  cpSync(transcript_path, join(target, basename(transcript_path)));
  const folder = join(dirname(transcript_path), session_id);
  if (existsSync(folder)) cpSync(folder, join(target, session_id), { recursive: true });
}

// Run claude under another account from now on: its config folder, and its
// name for the status line; a wrapper's account flags no longer apply.
function useAccount({ config_dir, name }) {
  if (config_dir === 'default') delete env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = config_dir;
  env.CLAUDE_PROFILE = name;
  claudeArgs = persistentArgs(claudeArgs, true);
}

// `-limit 30` or `-limit 30k`: this session's context limit in thousands of
// tokens (config's context_clear_tokens), for testing the trim without filling
// a large context. Not passed to claude.
let claudeArgs = process.argv.slice(2);
const env = { ...process.env, SECRETARY_LAUNCHER_PID: String(process.pid) };
const at = claudeArgs.indexOf('-limit');
if (at >= 0) {
  const [, value] = claudeArgs.splice(at, 2);
  env.SECRETARY_LIMIT = String(Math.round(parseFloat(value) * 1000));
}

let child = null;
let relaunch = null;

function run(args) {
  child = spawn(CLAUDE, args, { stdio: 'inherit', env });
  child.on('exit', (code, signal) => {
    if (relaunch) {
      const { session_id, prompt, account } = relaunch;
      if (account) {
        try { moveSession(relaunch, account.config_dir); useAccount(account); }
        catch (err) { process.stderr.write(`secretary: account switch failed: ${err.message}\n`); }
      }
      relaunch = null;
      run([...persistentArgs(claudeArgs), '--resume', session_id, ...(prompt ? ['--', prompt] : [])]);
      return;
    }
    process.exit(signal ? 1 : code ?? 0);
  });
}

// The hook wrote the session and prompt to reopen: stop claude, `exit` relaunches.
process.on('SIGUSR2', () => {
  try {
    relaunch = JSON.parse(readFileSync(relaunchFile, 'utf-8'));
    unlinkSync(relaunchFile);
  } catch { return; }
  child?.kill('SIGTERM');
});
// Ctrl+C belongs to claude (same process group); hangups and kills go through.
process.on('SIGINT', () => {});
for (const sig of ['SIGTERM', 'SIGHUP']) process.on(sig, () => child?.kill(sig));
process.on('exit', () => { if (existsSync(relaunchFile)) try { unlinkSync(relaunchFile); } catch {} });

run(claudeArgs);
