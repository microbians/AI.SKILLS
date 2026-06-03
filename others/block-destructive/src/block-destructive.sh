#!/bin/bash
# PreToolUse hook: intercepts destructive Bash commands.
#
# Behavior:
#   - If the user's last prompt contains an authorization keyword
#     ("approved", "dale", "force", "borra", "adelante", "hazlo", etc.)
#     OR the command ends with "# approved" → allow without dialog.
#   - Otherwise → emit permissionDecision: "ask" so Claude Code shows
#     the native approval dialog before running.
#
# Why "ask" instead of "deny":
#   "deny" forces a 3-turn loop (run → error → user types "approved" → retry).
#   "ask" delegates to the native UI: one click, one turn, no keyword magic.

input=$(cat)
cmd=$(echo "$input" | jq -r '.tool_input.command // ""')
session_id=$(echo "$input" | jq -r '.session_id // "default"')

# Check if user already authorized this turn (in their last prompt).
user_authorized() {
  local last_prompt_file="$HOME/.claude/last-prompts/$session_id.txt"
  [ -f "$last_prompt_file" ] || return 1
  grep -qiE '(^|[^a-z])(approve[ds]?|aprov[ao]d[ao]s?|aprob[ao]d[ao]s?|aprivad[ao]s?|aprived[ao]s?|apruebo|apruebas?|force|forzar|forz[ao]|autorizo|autoriza(do|da)?|borra(l[oa]s?)?|dale|dale[[:space:]]+force|ok[[:space:]]+force|ok[[:space:]]+borra|puedes[[:space:]]+forzar|s[ií][[:space:]]+(borra|forzar?|adelante|hazlo)|adelante|hazlo|s[ií][[:space:]]+aprob|# approved)' "$last_prompt_file"
}

# "# approved" trailing comment + user authorization → allow.
if echo "$cmd" | grep -qE '#[[:space:]]*approved[[:space:]]*$'; then
  if user_authorized; then
    exit 0
  fi
  # No user authorization in last prompt → ask via native dialog.
  jq -n '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: "Command marked \"# approved\" but user has not authorized this turn — confirm to proceed."
    }
  }'
  exit 0
fi

ask() {
  # If the user already authorized this turn in their last prompt, skip the dialog.
  if user_authorized; then
    exit 0
  fi
  jq -n --arg reason "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: $reason
    }
  }'
  exit 0
}

# rm -rf / rm -fr (any variant with both flags)
if echo "$cmd" | grep -qE '(^|[[:space:]])rm[[:space:]]+(-[a-zA-Z]*[rf][a-zA-Z]*[rf]|-r[[:space:]]+-f|-f[[:space:]]+-r)'; then
  ask "Destructive command: rm -rf — requires explicit confirmation."
fi

# git destructive
if echo "$cmd" | grep -qE 'git[[:space:]]+reset[[:space:]]+--hard'; then
  ask "Destructive command: git reset --hard — discards local changes."
fi
if echo "$cmd" | grep -qE 'git[[:space:]]+push[[:space:]]+(.*[[:space:]])?(-f($|[[:space:]])|--force($|[[:space:]])|--force-with-lease)'; then
  ask "Destructive command: git push --force — can overwrite remote history."
fi
if echo "$cmd" | grep -qE 'git[[:space:]]+checkout[[:space:]]+(--[[:space:]]+)?\.($|[[:space:]])'; then
  ask "Destructive command: git checkout . — discards working tree changes."
fi
if echo "$cmd" | grep -qE 'git[[:space:]]+restore[[:space:]]+\.($|[[:space:]])'; then
  ask "Destructive command: git restore . — discards working tree changes."
fi
if echo "$cmd" | grep -qE 'git[[:space:]]+clean[[:space:]]+-[a-zA-Z]*f'; then
  ask "Destructive command: git clean -f — removes untracked files."
fi
if echo "$cmd" | grep -qE 'git[[:space:]]+branch[[:space:]]+(.*[[:space:]])?-D($|[[:space:]])'; then
  ask "Destructive command: git branch -D — force-delete branch."
fi
if echo "$cmd" | grep -qE 'git[[:space:]]+stash[[:space:]]+(drop|clear)'; then
  ask "Destructive command: git stash drop/clear — discards stashed changes."
fi
if echo "$cmd" | grep -qE -- '--no-verify'; then
  ask "Destructive flag: --no-verify — skips git hooks."
fi

# database
if echo "$cmd" | grep -qE '(^|[[:space:]])dropdb($|[[:space:]])'; then
  ask "Destructive command: dropdb."
fi
if echo "$cmd" | grep -qiE 'DROP[[:space:]]+(TABLE|DATABASE|SCHEMA)'; then
  ask "Destructive SQL: DROP TABLE/DATABASE/SCHEMA."
fi
if echo "$cmd" | grep -qiE 'TRUNCATE[[:space:]]+(TABLE[[:space:]]+)?[a-zA-Z_]'; then
  ask "Destructive SQL: TRUNCATE TABLE."
fi
# DELETE FROM <table> without WHERE (mass delete)
if echo "$cmd" | grep -qiE 'DELETE[[:space:]]+FROM[[:space:]]+[a-zA-Z_][a-zA-Z0-9_.]*[[:space:]]*(;|"|'\''|$)' \
  && ! echo "$cmd" | grep -qiE 'DELETE[[:space:]]+FROM[[:space:]]+[^;"'\'']*WHERE'; then
  ask "Destructive SQL: DELETE FROM without WHERE (mass delete)."
fi
# UPDATE <table> SET ... without WHERE (mass update)
if echo "$cmd" | grep -qiE 'UPDATE[[:space:]]+[a-zA-Z_][a-zA-Z0-9_.]*[[:space:]]+SET[[:space:]]' \
  && ! echo "$cmd" | grep -qiE 'UPDATE[[:space:]]+[^;"'\'']*WHERE'; then
  ask "Destructive SQL: UPDATE without WHERE (mass update)."
fi
# mongo dropDatabase / deleteMany({})
if echo "$cmd" | grep -qE 'dropDatabase\(\)|deleteMany\([[:space:]]*\{[[:space:]]*\}'; then
  ask "Destructive mongo: dropDatabase() / deleteMany({})."
fi
# redis FLUSHDB / FLUSHALL
if echo "$cmd" | grep -qiE '(^|[[:space:]])(FLUSHDB|FLUSHALL)($|[[:space:]])'; then
  ask "Destructive redis: FLUSHDB/FLUSHALL."
fi

# disk
if echo "$cmd" | grep -qE '(^|[[:space:]])mkfs'; then
  ask "Destructive command: mkfs (formats filesystem)."
fi
if echo "$cmd" | grep -qE '(^|[[:space:]])dd[[:space:]]+.*if='; then
  ask "Destructive command: dd — raw block copy."
fi
if echo "$cmd" | grep -qE '>[[:space:]]*/dev/(sd|disk|nvme)'; then
  ask "Destructive: direct write to disk device."
fi

exit 0
