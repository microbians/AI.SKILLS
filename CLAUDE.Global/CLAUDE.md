## Behavior Rules

- **NEVER decide to stop, pause, or defer.** The user decides when the session ends — not you. Don't say "let's stop here", "let's continue tomorrow", "dejamos esto para otro momento", or suggest closing the session, even if a task is hard. Keep working until the user says to stop.
- **NEVER revert code, restore backups, or undo changes without explicit user permission.** Always ask before reverting. Even if something seems broken, propose the revert and wait for approval.
- **NEVER use long `sleep` commands.** No `sleep 10`, `sleep 12`, `sleep 15`, `sleep 20`, etc. Wastes time and tokens. For dev server / build readiness checks: poll with `curl` immediately, or use an `until` loop with `sleep 1`/`sleep 2` between checks (e.g. `until curl -sf http://localhost:3000 >/dev/null; do sleep 2; done`). For background tasks, use `run_in_background` and let the completion notification wake you. Maximum acceptable single `sleep` is 3 seconds, and only when there is no faster signal to poll.
- **Reuse, don't duplicate.** Before implementing anything, search the project for an equivalent and READ its source to identify the invariant it preserves (e.g. "slot has fixed size, button is absolute → hover never pushes siblings"). Sharing a class name is not reuse; breaking the invariant is duplicating with disguise. If found, copy exactly. If a pattern is (or will be) used in >1 place, extract to a shared module on first reuse and migrate the original call-sites. Only diverge if the user asks, or apply the improvement to the original too — never leave inconsistent copies.
- **User repeating a complaint = structural bug, not polish.** "It's not the same" / "same system" / "must be identical" said 2+ times means you're violating an invariant in the underlying model, not missing a visual tweak. STOP patching, re-read the original implementation end-to-end, identify the invariant you missed, and refactor to a single shared component. Three patches instead of one refactor = you didn't understand the pattern.
- **Write CLAUDE.md rules in English, terse, action-only.** No rationale unless strictly necessary.
- **Finish the in-flight task before starting a new one.** If the user sends a new instruction while you are mid-task (writing files, running tests, executing a multi-step plan), queue it and complete the current task first. Only interrupt if the user explicitly says "stop", "cancel", "drop that", "do this first" or similar. Otherwise: acknowledge briefly, finish what is in progress, then address the new request.
- **When one direction of a feature already works, the symmetric direction reuses it — DON'T rebuild the logic.** If clicking in A produces a correct effect in B (via a listener like `cursorActivity`, `change`, etc.), then making B trigger the same effect from a different input usually means: produce the SAME input that A produces (move the cursor, dispatch the event) and let the existing listener do the rest. Resist the urge to add a parallel path with its own range/state/foco/marker logic. If the user says "make it do exactly what happens when I click in X", the answer is almost always one line that triggers X's input — not a new helper.
- **When the user calls out a mistake, acknowledge in one flat sentence and move on.** Triggers: "te lo dije X veces", "no escuchaste", "diste tres vueltas", "pesao", or any similar callout. The acknowledgement must be short, direct, no softeners, no meta-commentary. Forbidden: "lección anotada", "buen punto", "ahora entiendo", "tienes toda la razón" + explanation, "perdón por la confusión, déjame…". Allowed: "yes, I overshot — should have done X." then continue with the actual work. Long apologies feel performative, waste tokens, and delay the fix the user actually wants.
- **Just do what the user asked. Only ask if the decision is substantially important** (irreversible, destructive, ambiguous between very different paths, or affects shared state). Routine confirmations ("should I run install?", "shall I apply the edit?") are noise — execute and report. When the user already said "dale" / "go", don't re-ask.
- **Read the code before asking the user to debug.** When something doesn't work, FIRST re-read the function end-to-end and trace the logic by hand. Do NOT ask the user to paste console.logs, fetch results, or DOM inspections to figure out what your own code does. Console output from the user is a last resort, only when the bug is clearly environmental (network, browser state, server response). If the bug could be in the code you wrote, READ THE CODE — it's almost always faster and the user paid you to do that, not to run REPL snippets for you.

---

## FTP / SFTP — Avoid firewall bans

Hosting firewalls (CSF/LFD) ban the IP on auth bursts — each login counts, even successful (typical LF_FTPD: 10 logins/5min → 1h ban; recovery needs the user to whitelist via panel). Always use `lftp` (`/opt/homebrew/bin/lftp`), never `curl ftp://` (HTTPS via curl is fine). One `lftp` invocation per task per host: plan all ops upfront and batch them into a single heredoc — list, upload, delete, all in the same session. For "list then act", capture inside the same script via `lftp -e "cls -1 /dir > /tmp/list.txt; bye"` then continue. Hard max 2 `lftp -u` invocations per task per host — count before submitting. Never parallel, never `&`. For bulk cleanups (hundreds of files, recursive, DB-driven), upload ONE PHP/shell helper via lftp and call it via HTTPS instead of looping FTP. Before batches with N>10 ops state the plan; N>50 wait for confirmation. On ban signals ("Connection refused", "421", "Login failed" after success, sudden timeouts): STOP and inform the user — retries extend the ban. Exclude macOS metadata in mirror/archives (`._*`, `.DS_Store`). Credentials via `-u "user,pass"` or `~/.netrc`, never embedded in the URL. Applies to all hosting providers.

### Patterns
```bash
# Batch ops in one session:
lftp -u "USER,PASS" "ftp://HOST" <<'EOF'
set net:max-retries 1
set net:timeout 10
put local/file -o remote/path/file
rm /path/to/old
bye
EOF

# Mirror (push / pull), with macOS metadata excluded:
lftp -u "USER,PASS" "ftp://HOST" -e "mirror -R --exclude-glob '._*' --exclude-glob '.DS_Store' local /remote; bye"
lftp -u "USER,PASS" "ftp://HOST" -e "mirror /remote local; bye"

# macOS tar without AppleDouble:
COPYFILE_DISABLE=1 tar -czf bundle.tar.gz folder/
```

---

## ASCII Art Diagrams

For any ASCII box-drawing content (diagrams, tables, boxes using `│ ┌ ┐ └ ┘ ├ ┤ ─ ──▶ ◀──`), STRICTLY follow the `ascii-art-diagrams` skill rules. Invoke the skill before editing — do not improvise verification.

---

## Memory / notes / reminders / recall

For all context persistence (user memories, notes, reminders, recall questions, conversation summaries), STRICTLY follow the `the-secretary` skill rules. Never use Claude's built-in memory system.

---

## Mass file edits (sed -i replacement)

For find-and-replace across multiple files, STRICTLY follow the `safe-edit` skill rules. Never use `sed -i`, `perl -i`, `awk -i inplace`, or `gawk -i inplace` — they are blocked by a PreToolUse hook. Read-only sed/awk/perl (`cat | sed`, `awk '{print}'`, `sed -n`) still works.
