## Mass file edits (sed -i replacement)

For find-and-replace across multiple files, STRICTLY follow the `safe-edit` skill rules. Never use `sed -i`, `perl -i`, `awk -i inplace`, or `gawk -i inplace` — they are blocked by a PreToolUse hook. Read-only sed/awk/perl (`cat | sed`, `awk '{print}'`, `sed -n`) still works.
