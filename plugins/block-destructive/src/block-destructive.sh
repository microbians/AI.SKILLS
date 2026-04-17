#!/bin/bash
# PreToolUse hook: blocks destructive Bash commands even in bypass mode.
# Reads tool input JSON from stdin, exits with deny decision if pattern matches.
#
# Escape hatch: append "# approved" at the end of a command to skip all checks.
# Example: rm -rf /tmp/foo # approved

cmd=$(jq -r '.tool_input.command // ""')

# Escape hatch: if command ends with "# approved" comment, skip all checks.
if echo "$cmd" | grep -qE '#[[:space:]]*approved[[:space:]]*$'; then
  exit 0
fi

block() {
  jq -n --arg reason "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
  exit 0
}

# rm -rf / rm -fr (any variant with both flags)
if echo "$cmd" | grep -qE '(^|[[:space:]])rm[[:space:]]+(-[a-zA-Z]*[rf][a-zA-Z]*[rf]|-r[[:space:]]+-f|-f[[:space:]]+-r)'; then
  block "BLOCKED: rm -rf detected. Append '# approved' to confirm, or ask the user."
fi

# git destructive
if echo "$cmd" | grep -qE 'git[[:space:]]+reset[[:space:]]+--hard'; then
  block "BLOCKED: git reset --hard. Append '# approved' to confirm."
fi
if echo "$cmd" | grep -qE 'git[[:space:]]+push[[:space:]]+(.*[[:space:]])?(-f($|[[:space:]])|--force($|[[:space:]])|--force-with-lease)'; then
  block "BLOCKED: git push --force. Append '# approved' to confirm."
fi
if echo "$cmd" | grep -qE 'git[[:space:]]+checkout[[:space:]]+(--[[:space:]]+)?\.($|[[:space:]])'; then
  block "BLOCKED: git checkout . (discards changes). Append '# approved' to confirm."
fi
if echo "$cmd" | grep -qE 'git[[:space:]]+clean[[:space:]]+-[a-zA-Z]*f'; then
  block "BLOCKED: git clean -f. Append '# approved' to confirm."
fi
if echo "$cmd" | grep -qE 'git[[:space:]]+branch[[:space:]]+(.*[[:space:]])?-D($|[[:space:]])'; then
  block "BLOCKED: git branch -D. Append '# approved' to confirm."
fi
if echo "$cmd" | grep -qE 'git[[:space:]]+stash[[:space:]]+(drop|clear)'; then
  block "BLOCKED: git stash drop/clear. Append '# approved' to confirm."
fi
if echo "$cmd" | grep -qE -- '--no-verify'; then
  block "BLOCKED: --no-verify (skips hooks). Append '# approved' to confirm."
fi

# database
if echo "$cmd" | grep -qE '(^|[[:space:]])dropdb($|[[:space:]])'; then
  block "BLOCKED: dropdb. Append '# approved' to confirm."
fi
if echo "$cmd" | grep -qiE 'DROP[[:space:]]+(TABLE|DATABASE|SCHEMA)'; then
  block "BLOCKED: DROP TABLE/DATABASE/SCHEMA. Append '# approved' to confirm."
fi
if echo "$cmd" | grep -qiE 'TRUNCATE[[:space:]]+(TABLE[[:space:]]+)?[a-zA-Z_]'; then
  block "BLOCKED: TRUNCATE TABLE. Append '# approved' to confirm."
fi
# DELETE FROM <table> without WHERE (mass delete)
if echo "$cmd" | grep -qiE 'DELETE[[:space:]]+FROM[[:space:]]+[a-zA-Z_][a-zA-Z0-9_.]*[[:space:]]*(;|"|'\''|$)' \
  && ! echo "$cmd" | grep -qiE 'DELETE[[:space:]]+FROM[[:space:]]+[^;"'\'']*WHERE'; then
  block "BLOCKED: DELETE FROM without WHERE (mass delete). Append '# approved' to confirm."
fi
# UPDATE <table> SET ... without WHERE (mass update)
if echo "$cmd" | grep -qiE 'UPDATE[[:space:]]+[a-zA-Z_][a-zA-Z0-9_.]*[[:space:]]+SET[[:space:]]' \
  && ! echo "$cmd" | grep -qiE 'UPDATE[[:space:]]+[^;"'\'']*WHERE'; then
  block "BLOCKED: UPDATE without WHERE (mass update). Append '# approved' to confirm."
fi
# mongo dropDatabase / deleteMany({})
if echo "$cmd" | grep -qE 'dropDatabase\(\)|deleteMany\([[:space:]]*\{[[:space:]]*\}'; then
  block "BLOCKED: mongo dropDatabase/deleteMany({}). Append '# approved' to confirm."
fi
# redis FLUSHDB / FLUSHALL
if echo "$cmd" | grep -qiE '(^|[[:space:]])(FLUSHDB|FLUSHALL)($|[[:space:]])'; then
  block "BLOCKED: redis FLUSHDB/FLUSHALL. Append '# approved' to confirm."
fi

# disk
if echo "$cmd" | grep -qE '(^|[[:space:]])mkfs'; then
  block "BLOCKED: mkfs. Append '# approved' to confirm."
fi
if echo "$cmd" | grep -qE '(^|[[:space:]])dd[[:space:]]+.*if='; then
  block "BLOCKED: dd if=. Append '# approved' to confirm."
fi
if echo "$cmd" | grep -qE '>[[:space:]]*/dev/(sd|disk|nvme)'; then
  block "BLOCKED: direct write to disk device. Append '# approved' to confirm."
fi

exit 0
