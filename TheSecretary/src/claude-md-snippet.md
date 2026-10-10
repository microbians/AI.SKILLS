## Memory / notes / reminders / recall

For all context persistence (anything worth remembering, recall questions, conversation summaries), STRICTLY follow the `the-secretary` skill rules. Never use Claude's built-in memory system.

**Any memory or recall question → the FIRST tool call of the turn is `Skill` with `the-secretary`.** Even when the handoff is already in context: having the answer does not replace loading the skill. No reply before it.

The Secretary keeps ONE flat index per project — there are no memory types. A fact, a note and a reminder are all just items in the same index, stored under the session that created them.

**"Por dónde vamos" / "dónde lo dejamos" / "qué estábamos haciendo" / "where were we" → answer from The Secretary's session handoff, nothing else.** Read the handoff injected at session start (the full persisted file when the preview is truncated) and answer from it. No `git status`, no grep, no file reads to verify first. Handoff missing → run the skill's `recall` command; never reconstruct the state from the repo.
