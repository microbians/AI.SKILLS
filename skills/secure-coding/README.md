# Secure Coding Skill

Security and data-integrity rules for AI agents writing or reviewing server-side code. Every rule comes from a bug that actually existed.

```
┌───────────────────────────────────────────────────────────────┐
│                                                               │
│  SECURE CODING                                                │
│                                                               │
│  One rule underneath all: FAIL CLOSED                         │
│  The absence of a decision must never mean "allow" or         │
│  "delete".                                                    │
│                                                               │
│  - Unmapped action        -> strictest permission, not none   │
│  - Missing payload key    -> leave it alone, not empty it     │
│  - Method not on a list   -> POST+CSRF, not "GET is fine"     │
│  - Column not in schema   -> drop and log, not silent junk    │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

## What is it

A checklist distilled from a real audit of a PHP/SQLite CMS. It is **not** a generic OWASP summary: every rule maps to a specific finding that was either exploitable or had already destroyed user data.

The value is in the failure *shapes*. Nearly every serious finding was the same mistake wearing different clothes — code that treated **missing information as permission to act**.

## Two stacks, same failures

Each rule is stated stack-agnostically, then shown twice:

- **PHP** — classic server app: `$_POST`, direct file writes, a hand-rolled action router (the audited codebase)
- **TypeScript / Next.js** — App Router Route Handlers (`app/api/*/route.ts`), Drizzle, `better-sqlite3`

That pairing is deliberate. The same bug looks different in each stack, and some traps only exist in one:

```
┌──────────────────────┬──────────────────────────────────────┐
│  IN PHP              │  IN NEXT.JS                          │
├──────────────────────┼──────────────────────────────────────┤
│  $input['x'] ?? ''   │  body.x ?? ''  (reads as harmless)   │
│  Forgotten route in  │  Every file under app/api IS a       │
│  a central switch    │  public endpoint — no central gate   │
│  json_encode flags   │  dangerouslySetInnerHTML is the      │
│  for </script>       │  only raw path — grep them all       │
│  realpath + prefix   │  [...path] arrives pre-decoded       │
│  Manual SQL quoting  │  sql.raw + dynamic orderBy           │
│  (SQLite: a ghost    │  Typed schema catches drift — until  │
│  column becomes a    │  someone hand-writes a column name   │
│  string literal)     │  Cache can serve one user's data     │
│                      │  to another                          │
└──────────────────────┴──────────────────────────────────────┘
```

## Where it comes from

```
┌──────────────────────┬──────────────────────────────────────┐
│  VECTOR              │  WHAT THE AUDIT ACTUALLY FOUND       │
├──────────────────────┼──────────────────────────────────────┤
│  Destructive writes  │  3 bugs that deleted user content    │
│  Authorisation       │  fail-open gate, self-promotion      │
│  CSRF / HTTP method  │  ~90 mutating actions open to GET    │
│  Paths               │  ".." reached a recursive delete     │
│  SQL                 │  ghost column returned as a string   │
│  Output escaping     │  json_encode did not stop </script>  │
│  Uploads             │  SVG accepted as a passive asset     │
│  Read endpoints      │  drafts served to anonymous callers  │
└──────────────────────┴──────────────────────────────────────┘
```

Three of those cost real data: a page save shipped an empty layout whenever a scan silently returned nothing, wiping the galleries of three pages; a second writer of the same file had no guard at all; and a save with a missing payload key truncated files to zero bytes.

## When to load it

Before:

- Adding or changing an API endpoint, or its permission check
- Writing, deleting or moving files from user-controlled input
- Building a path or a SQL query from anything a user can influence
- Writing a template filter, or rendering user data into HTML/JS
- Auditing a codebase for vulnerabilities or data loss

## What it covers

- **Destructive writes** — empty payload is not "delete"; `array_key_exists` vs `?? ''`; snapshot before overwrite; grep for the twin writer
- **Authorisation** — fail-closed permission maps; a grantable permission must not grant itself more; tenancy is not capability
- **CSRF** — GET read-only by allowlist; `SameSite=Lax` is not protection; token auth is per-request, never sticky
- **Paths** — validate, resolve, verify containment; watch characters admitted for a good reason; recursive delete deserves paranoia
- **SQL** — allowlists for identifiers; keep declared columns in sync with the live schema (and enforce it)
- **Output escaping** — escape by default with a small auditable raw path; escaping is context-specific; escape on output even when input is sanitised
- **Uploads** — allowlist extensions across every dot-segment; verify real content type; SVG is active content
- **Read endpoints** — filter publication state at the boundary, not in the provider
- **Auditing method** — fan out over independent vectors, verify before reporting, reproduce before believing

## The lesson that saved the audit

An anonymous draft-leak finding tested **false** at first — the database simply had no drafts. Inserting one proved it real and exploitable.

> A negative test on empty data proves nothing.

## Installation

```bash
mkdir -p ~/.claude/skills/secure-coding
cp SKILL.md README.md ~/.claude/skills/secure-coding/
```

Per-project instead:

```bash
mkdir -p .claude/skills/secure-coding
cp SKILL.md README.md .claude/skills/secure-coding/
```

Optionally add a pointer in your global `CLAUDE.md` so it is invoked without being asked:

```markdown
## Security & data integrity

When writing or reviewing server-side code, STRICTLY follow the `secure-coding`
skill rules. Invoke it BEFORE: adding or changing an API endpoint or its
permission check, writing/deleting files, building a path or a query from user
input, writing a template filter, or auditing a codebase.

**Fail closed — the absence of a decision must never mean "allow" or "delete".**
```

## Requirements

- Claude Code or OpenCode with skills support
- Language-agnostic (examples are PHP; the rules apply to any stack)

## License

MIT
