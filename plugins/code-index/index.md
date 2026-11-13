# CodeIndex — Claude's index to your codebase

> A plugin for Claude Code: an index of every class, function and method in your project, so Claude finds your code without searching it.

Page: https://microbians.github.io/AI.SKILLS/plugins/code-index/ · Source: https://github.com/microbians/AI.SKILLS/tree/main/plugins/code-index · License: MIT

## What it does

When Claude Code needs a function in your project, it usually goes looking for it: searching files, opening them, reading until it finds the right one, every time. CodeIndex keeps a list of everything in your code: each class, function and method, the file and line where it lives, its signature, and the doc comment written above it. Claude asks the list and goes straight to that line. Answers come faster and spend fewer tokens.

No AI is involved: symbols come from universal-ctags (~150 languages), stored in SQLite. Only files whose content changed are read again.

## Commands

```bash
node ~/.claude/codeindex/codeindex.mjs where <Name>        # definitions: file:line, signature, doc
node ~/.claude/codeindex/codeindex.mjs refs <Name>         # definitions + every textual mention
node ~/.claude/codeindex/codeindex.mjs callers <Name>      # who calls / uses a symbol
node ~/.claude/codeindex/codeindex.mjs members <Class>     # every member, mixed-in ones included
node ~/.claude/codeindex/codeindex.mjs where <Class.name>  # one member of a class, own or mixed in
node ~/.claude/codeindex/codeindex.mjs grep <words…>       # loose ranked search; a typo gets the closest names
node ~/.claude/codeindex/codeindex.mjs file <path>         # symbols in one file
node ~/.claude/codeindex/codeindex.mjs deps <file>         # what a file imports and calls into
node ~/.claude/codeindex/codeindex.mjs arch                # module dependency map
node ~/.claude/codeindex/codeindex.mjs flow <module>       # up/downstream of a module
node ~/.claude/codeindex/codeindex.mjs index               # incremental reindex
```

Example:

```
$ codeindex where saveUser
store/user-methods.js:42   saveUser(user, opts)   (method)  in UserMethods → UserStore (mixin)
    Writes the user to disk, merged with the stored copy.
```

## Mixins

Methods laid onto a class from another file (`Object.assign(T.prototype, S.prototype)`, `mixInto(T, S)`, `applyMixins(T, [A, B])`) are filed under the class they land in: `members UserStore` lists them, `where UserStore.saveUser` finds them, and a stale copy in `old/` does not pass for the real one.

## How it works

1. **List** — files from `git ls-files` (honors `.gitignore`); files over 2 MB are skipped.
2. **Compare** — modification time, then content hash; unchanged files are not read again.
3. **Extract** — each symbol with its signature and the comment above it, verbatim (JavaScript inside HTML and PHP too).
4. **Link** — imports and call sites become edges: who calls what, which file needs which.
5. **Answer** — `file:line`, signature and doc, or the thread of callers and dependencies.

A `SessionStart` hook refreshes the index every session. The database lives at `<project>/.claude/codeindex.db` and adds itself to the project's `.gitignore`.

## With The Secretary

Installed together with [The Secretary](https://microbians.github.io/AI.SKILLS/plugins/secretary/), each reads the other with nothing to configure: CodeIndex shows its indexing progress in The Secretary's status line, handoffs name the functions each edit touched, and recall finds conversations about the file that defines a symbol.

## Install

Requires Node.js 22+ and universal-ctags (the BSD `ctags` shipped with macOS won't do). macOS or Linux.

```bash
brew install universal-ctags            # macOS
sudo apt-get install universal-ctags    # Debian / Ubuntu
git clone https://github.com/microbians/AI.SKILLS.git
bash AI.SKILLS/plugins/code-index/install.sh
```

Uninstall: `bash install.sh --uninstall`.

## Limits

- `where` and `callers` of uniquely named functions are exact; `arch` and `flow` are strong hints (built from names).
- `refs` is a word scan, not semantic usage.
- Two symbols with the same name both come back; the path tells them apart.
