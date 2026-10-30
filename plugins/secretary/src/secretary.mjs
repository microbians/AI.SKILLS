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
import { readFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CLAUDE = process.env.SECRETARY_CLAUDE || 'claude';
const relaunchFile = join(homedir(), '.claude', 'the-secretary', 'relaunch', `${process.pid}.json`);

// Flags that pick or start a session: dropped on relaunch, which picks its own.
const SESSION_FLAGS = new Set(['-c', '--continue', '-r', '--resume', '--session-id', '--fork-session', '--from-pr']);

// Options that take a value, read from `claude --help` (`--model <model>`,
// `--resume [value]`, `--allowedTools <tools...>`).
function valueFlags() {
  const flags = new Map();
  let help = '';
  try { help = execFileSync(CLAUDE, ['--help'], { encoding: 'utf-8' }); } catch { return flags; }
  // `  -r, --resume [value]`, `  --allowedTools, --allowed-tools <tools...>`
  for (const m of help.matchAll(/^\s+((?:-{1,2}[\w-]+, )*-{1,2}[\w-]+) (<[^>]+>|\[[^\]]+\])/gm)) {
    const kind = m[2].includes('...') ? 'many' : m[2].startsWith('[') ? 'optional' : 'one';
    for (const name of m[1].split(', ')) flags.set(name, kind);
  }
  return flags;
}

// The launch arguments minus the session choice and the initial prompt.
function persistentArgs(args) {
  const takes = valueFlags();
  const kept = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) continue; // initial prompt
    const name = arg.split('=')[0];
    const values = [];
    const kind = arg.includes('=') ? null : takes.get(name);
    if (kind === 'one') values.push(args[++i]);
    else if (kind === 'optional' && args[i + 1] && !args[i + 1].startsWith('-')) values.push(args[++i]);
    else if (kind === 'many') while (args[i + 1] && !args[i + 1].startsWith('-')) values.push(args[++i]);
    if (!SESSION_FLAGS.has(name)) kept.push(arg, ...values);
  }
  return kept;
}

// `-limit 30` or `-limit 30k`: this session's context limit in thousands of
// tokens (config's context_clear_tokens), for testing the trim without filling
// a large context. Not passed to claude.
const claudeArgs = process.argv.slice(2);
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
      const { session_id, prompt } = relaunch;
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
