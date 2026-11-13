# The Secretary — local memory for Claude Code

> Local memory for Claude Code: every conversation kept verbatim, a handoff for your next session, answers to "do you remember…?".

Page: https://microbians.github.io/AI.SKILLS/plugins/secretary/ · Source: https://github.com/microbians/AI.SKILLS/tree/main/plugins/secretary · License: MIT

## What it does

The Secretary keeps every Claude Code conversation word for word and leaves a handoff for your next session, so you never explain the same thing twice. It runs on a local LLM on your own machine; no conversation leaves it.

## Recall

Ask in plain words, in English or Spanish ("Do you remember the aspect ratio fix?"). The Secretary searches what was literally said and what was said with other words, then hands Claude the matching turns before it answers. No command to run.

- `[said]` — your own words, found literally.
- `[turn]` — Claude's answer, found literally.
- `[said~]` — found by meaning; similar wording exists, a lead, not proof.
- No literal hit means it was never said in this project.

## Measured on real sessions

| What went wrong | Was | Now |
|---|---|---|
| Handoffs named files nobody touched (better model + files-touched list read from the session) | 26 paths | 0 paths |
| End-of-session handoff read only the last unread lines; now reads the whole session | 112 chars | 15,755 chars |
| Recognizing "remember this" / "forget that" (gemma-4-26B-A4B replaced Qwen2.5-7B on 48 GB+) | 60% | 90% |
| Summaries stuck in a repetition loop (304 of 29,373 stored) | ~1% stored | detected |
| Q&A turns with no tool call were never indexed | 9 of 11 lost | all indexed |
| Meaning-only search missed exact names; word + meaning search now run together | 0 of 17 | 17 of 17 |

## How it works

A set of Claude Code hooks:

- **SessionStart** — the latest handoff first, then the newest items and the end of the previous session, word for word.
- **PostToolUse** — every turn indexed verbatim, screenshots included; every 15 tool calls the conversation is summarized.
- **UserPromptSubmit** — "Remember that…", "forget…", "do you remember…?" are caught and acted on before Claude replies.
- **Stop** — a handoff: what was done, what is broken or untested, the next step, the rules you repeated, the files touched.

The status line shows a blinking face, the context used against the trim limit, the model and your plan usage.

## The memory travels with the folder

```
my-project/
└── .claude/
    └── the-secretary/
        ├── summaries.db   every turn + index
        ├── bullets.md     summaries
        ├── images/        screenshots
        └── .gitignore     *
```

Copy or sync the folder and the next session picks up the same memory. The folder ignores itself, so no repository commits your conversations. Transcripts are kept past Claude Code's 30-day cleanup. One flat index: a fact, a note and a reminder are the same thing.

## With CodeIndex

Installed together with [CodeIndex](https://microbians.github.io/AI.SKILLS/plugins/code-index/), handoffs name the functions each edit touched, recall by symbol also finds turns about the file that defines it, and CodeIndex shows its indexing progress in the status line.

## Install

```bash
pip install mlx-lm        # Apple Silicon (or: brew install llama.cpp)
git clone https://github.com/microbians/AI.SKILLS.git
cd AI.SKILLS/plugins/secretary
bash install.sh
# optional, from each project root:
node ~/.claude/the-secretary/summarize.mjs index-turns
node ~/.claude/the-secretary/summarize.mjs index-vectors
```

With a Claude Max subscription, the `claude_cli` provider skips the local model. Requirements: macOS or Linux, Node.js 18+, Claude Code CLI, 1–15 GB of disk for the model (none with `claude_cli`). Search by meaning is optional (a small Python venv with `mlx-embeddings`). Uninstall: `bash install.sh --uninstall`.
