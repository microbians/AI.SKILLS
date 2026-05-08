#!/usr/bin/env node
/**
 * PreToolUse hook — blocks in-place file editing via sed/perl/awk and points
 * the user at safe-edit. Only blocks WRITE operations; read/filter pipelines
 * (cat | sed, awk '{print}', sed -n) are still allowed.
 *
 * Reads Claude Code's PreToolUse JSON payload from stdin. If the tool is Bash
 * and its command contains an in-place edit invocation, prints a blocking
 * message to stderr and exits with code 2 (deny).
 */

import { readFileSync } from 'fs';

let raw = '';
try { raw = readFileSync(0, 'utf8'); } catch { process.exit(0); }
if (!raw.trim()) process.exit(0);

let payload;
try { payload = JSON.parse(raw); } catch { process.exit(0); }

const tool = payload.tool_name || payload.tool || '';
if (tool !== 'Bash') process.exit(0);

const command = payload.tool_input?.command ?? payload.input?.command ?? '';
if (typeof command !== 'string' || !command) process.exit(0);

const offense = detectInplace(command);
if (!offense) process.exit(0);

const msg = `[safe-edit] Blocked in-place edit: ${offense.tool} ${offense.flag}

Command: ${command}

Reason: in-place editing with sed/perl/awk corrupts files on regex slips,
mid-edit interrupts, or charset mismatches. Use \`safe-edit\` instead — it
shows a unified diff before writing, backs up modified files to a timestamped
batch dir, and prunes old batches automatically.

Replace with:
  node ~/.claude/safe-edit/safe-edit.mjs replace \\
    --find "PATTERN" --with "REPLACEMENT" --files "GLOB" --apply

  # Add --regex for regex mode. Drop --apply for a dry-run.

Read-only sed/awk/perl (cat | sed, awk '{print}', sed -n) are NOT blocked —
only writes. If you genuinely need to bypass this guard, run the command
in a subshell that the hook cannot inspect, or temporarily disable the hook.`;

process.stderr.write(msg + '\n');
process.exit(2);

// ─────────────────────────────────────────────────────────────────

function detectInplace(cmd) {
  // Strip single/double quoted strings so flags inside literals don't trigger.
  const stripped = cmd
    .replace(/'(?:\\.|[^'])*'/g, "''")
    .replace(/"(?:\\.|[^"])*"/g, '""');

  // Split on shell separators (;, &&, ||, |, &, newline) and check each segment.
  const segments = stripped.split(/(?:\|\||&&|;|\||&|\n)/);

  for (const segRaw of segments) {
    const seg = segRaw.trim();
    if (!seg) continue;

    // sed -i / sed -i'' / sed -i.bak / sed -i ''
    // Match `sed` (possibly with path) followed by any flags containing -i.
    const sedMatch = seg.match(/(^|\s)(?:[\w./-]*\/)?(g?sed)\b([^]*)$/);
    if (sedMatch) {
      const tail = sedMatch[3];
      // -i can be: -i, -i'', -i.bak, -i .bak, --in-place
      if (/(^|\s)-i(\b|['".\w])/.test(tail) || /(^|\s)--in-place\b/.test(tail)) {
        return { tool: sedMatch[2], flag: '-i' };
      }
    }

    // perl -i / perl -pi / perl -ni / perl -i.bak
    const perlMatch = seg.match(/(^|\s)(?:[\w./-]*\/)?(perl)\b([^]*)$/);
    if (perlMatch) {
      const tail = perlMatch[3];
      // Look for a flag cluster that contains 'i': -i, -pi, -ni, -pie, -i.bak
      if (/(^|\s)-[a-zA-Z]*i([a-zA-Z]*)?(\b|['".\w])/.test(tail)) {
        return { tool: 'perl', flag: '-i' };
      }
    }

    // awk -i inplace / gawk -i inplace
    const awkMatch = seg.match(/(^|\s)(?:[\w./-]*\/)?(g?awk)\b([^]*)$/);
    if (awkMatch) {
      const tail = awkMatch[3];
      if (/(^|\s)-i\s+inplace\b/.test(tail)) {
        return { tool: awkMatch[2], flag: '-i inplace' };
      }
    }
  }

  return null;
}
