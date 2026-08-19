---
name: secure-coding
description: Security and data-integrity rules for writing or reviewing server-side code — auth gates, CSRF, path handling, SQL, uploads, output escaping, and the destructive-write patterns that silently delete user data. Use when adding or changing an API endpoint, a file write, a permission check, a template filter, or any code that takes user input; and when auditing a codebase for vulnerabilities or data loss. Derived from a real audit that found a one-click admin-takeover CSRF, a recursive-wipe path traversal, and three separate bugs that destroyed user content. Examples in PHP and TypeScript/Next.js.
version: 1.0.0
updated: 2026-08-12
license: MIT
compatibility: opencode
metadata:
  type: methodology
  scope: server-side
  stacks: [php, typescript, nextjs]
---

# secure-coding

Rules distilled from a real audit of a PHP/SQLite CMS. Every one corresponds to a
bug that **actually existed and was exploitable or had already destroyed data** —
not theory.

Each rule is stated stack-agnostically, then shown in **PHP** (classic server
app: `$_POST`, file writes, a hand-rolled action router) and in
**TypeScript / Next.js Route Handlers** (`app/api/*/route.ts`, Drizzle,
`better-sqlite3`). Same failure, different syntax — read whichever matches the
project, but the *shape* of the mistake is what matters.

Read this before: adding an API endpoint, writing a file, adding a permission
check, writing a template filter, or accepting user input into a path or a query.

---

## The one rule underneath all the others

**Fail closed. The absence of a decision must never mean "allow" or "delete".**

Every serious finding in that audit was the same shape: code that treated
*missing information* as *permission to act*.

| Missing thing | Was interpreted as | Should be |
|---|---|---|
| action not in the permission map | no permission needed | strictest permission |
| `layout` key absent from payload | delete every instance | leave stored data untouched |
| `html` key absent from payload | write empty file | refuse |
| method not on the POST-only list | GET is fine | GET only if declared read-only |
| column not in the table | *(SQLite)* string literal | drop it and log |

When you write a guard, ask: **what happens if this field never arrives?** If the
answer is destructive, invert the default.

---

## 1. Destructive writes — the bugs that hurt users most

Three separate instances of the same mistake, each of which deleted real content.

### 1.1 An empty payload is not an instruction to delete

Before overwriting stored data with an empty value, check whether what is stored
is non-empty and **refuse by default**. Deletion must be *stated*, never inferred.

```php
// PHP — writing a values file
if ($incoming === [] && !empty($existing) && !$allowWipe) {
    error_log("refused to wipe " . count($existing) . " stored entries with an empty payload");
    $incoming = $existing;               // keep what is on disk
}
```

```ts
// TS — same rule, DB row instead of a file
if (incoming.length === 0 && existing.length > 0 && !allowWipe) {
  console.warn(`refused to wipe ${existing.length} stored entries with an empty payload`);
  return existing;                       // keep what is stored
}
```

Give callers that genuinely mean it an explicit flag (`allowWipe`) and make the
legitimate caller pass it, so the intent is visible at the call site.

### 1.2 Distinguish "key absent" from "key present but empty"

A client that omits a field says *"I have nothing to say about this"*. A client
sending `""` or `[]` says *"make it empty"*. **Only the second may destroy data.**
Nullish defaulting collapses both into one:

```php
$html = $input['html'] ?? '';            // WRONG — absent becomes "erase it"
file_put_contents($path, $html);         // truncates the file to 0 bytes

if (!array_key_exists('html', $input)) { // RIGHT
    error('Refusing to write ' . $file . ': no html in payload');
}
```

```ts
const body = await request.json();
const html = body.html ?? '';            // WRONG — same trap
await fs.writeFile(path, html);

if (!('html' in body)) {                 // RIGHT
  return NextResponse.json({ error: 'no html in payload' }, { status: 400 });
}
```

The TS version is easy to miss because `??` reads as harmless. `'html' in body`,
`Object.hasOwn(body, 'html')` or a Zod schema with `.optional()` vs `.default('')`
keeps the two cases apart.

### 1.3 An empty result from a failed read is not an empty document

This is the one that cost three pages their galleries. The client rebuilt its
instance list from a scan endpoint; when the scan failed to parse it resolved
**200 with an empty array** — no exception, so no `catch` fired — and the client
dutifully asked the server to delete everything.

```ts
// WRONG — a 200 with nothing in it silently becomes "delete all"
const res = await fetch('/api/page-components?…').then(r => r.json());
const instances = Array.isArray(res.components) ? res.components : [];
payload.layout = JSON.stringify(instances);          // [] wipes the page
```

```ts
// RIGHT — "I know nothing" omits the field; the server keeps what it has
if (instances.length) {
  payload.layout = JSON.stringify(instances);
} else if (hadInstancesBefore) {
  console.warn('scan came back empty for a page that had instances — not sending layout');
} else {
  payload.layout = JSON.stringify([]);               // genuinely empty
}
```

Track whether the object *ever* held content. Sudden emptiness after a fetch is a
failure signal, not a user intent.

### 1.4 Snapshot before overwrite

Copy the previous version next to the file (`.history/`, pruned to N revisions)
before any write that changes it. A few lines, negligible cost on small files,
and it turns "data destroyed" into "data one click away". Surface it in the UI
with a **count per revision** so an empty one is visibly wrong before restoring.

```php
if (is_file($path) && $new !== @file_get_contents($path)) {
    copy($path, dirname($path) . '/.history/' . basename($path, '.json')
              . '.' . date('Ymd-His', filemtime($path)) . '.json');
}
```

```ts
const prev = await fs.readFile(path, 'utf8').catch(() => null);
if (prev !== null && prev !== next) {
  const stamp = new Date((await fs.stat(path)).mtimeMs).toISOString().replace(/[:.]/g, '-');
  await fs.mkdir(join(dirname(path), '.history'), { recursive: true });
  await fs.writeFile(join(dirname(path), '.history', `${basename(path)}.${stamp}`), prev);
}
```

### 1.5 When you fix one writer, grep for its twins

The audited project guarded `ComponentValues::save()` and left
`_writeComponentValues` — the same operation reached through a different
endpoint — completely unguarded. Search for every path that writes the same
artefact before calling a fix done.

### 1.6 Read-modify-write on shared state needs a lock

Two tabs saving the same JSON a second apart: the second read predates the first
write, so it silently reverts it — and its snapshot captures the already-stale
state.

```php
$fp = fopen($path, 'c+');
flock($fp, LOCK_EX);
// read, modify, write, then release
```

```ts
// Node: atomic replace — write a temp file, then rename (rename is atomic on
// the same filesystem). Or use a transaction when the state lives in the DB.
await fs.writeFile(`${path}.tmp`, next);
await fs.rename(`${path}.tmp`, path);

// better-sqlite3 / Drizzle: wrap read-modify-write in a transaction
db.transaction(() => { const cur = read(); write(merge(cur, patch)); })();
```

---

## 2. Authorisation

### 2.1 Map every action to a permission, and fail closed when unmapped

```php
$needed = $PERMS[$action] ?? 'all';      // NOT `?? null` + "skip the check"
if (!currentUserCan($needed)) deny();
```

```ts
const needed = PERMS[action] ?? 'all';   // same default
if (!userCan(session, needed)) {
  return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
}
```

A hand-maintained permission map *will* drift from the dispatch table. Make the
drift safe instead of trying to prevent it.

**In Next.js the equivalent trap is structural**: every file under `app/api/`
is a public endpoint the moment it exists. There is no central router to forget
to update — which means there is no central place enforcing auth either. Each
handler must check for itself, or go through a shared wrapper:

```ts
export const POST = withAuth('write', async (req, session) => { … });
```

A `middleware.ts` matcher is a good second layer, but never the only one — a
matcher pattern that misses a route fails open, silently.

### 2.2 A grantable permission must not be able to grant itself more

If a permission (`users`) lets someone edit accounts, and account editing accepts
an `isAdmin` flag, then that permission **is** admin. Actions touching global
identity — users, grants, roles — need a separate, non-grantable gate.

```php
if (in_array($action, ['user_create','user_update','grant_save', …], true)
    && empty($_SESSION['root_admin'])) {
    error('Root access required', 403);
}
```

```ts
// Never let the client choose which fields it updates on an identity row
const patch = updateUserSchema.parse(body);           // zod: isAdmin NOT in the schema
if ('isAdmin' in body && !session.isRootAdmin) {
  return NextResponse.json({ error: 'Root access required' }, { status: 403 });
}
```

### 2.3 Check tenancy, not just capability

"May manage users" and "may manage *these* users" are different questions. If the
table is global, the permission must be global too. In a multi-tenant Drizzle
query, that means the tenant predicate is part of **every** query, not an
afterthought:

```ts
db.select().from(assets).where(and(eq(assets.id, id), eq(assets.tenantId, session.tenantId)));
```

A missing `tenantId` in a `where` is an IDOR, not a bug in the listing.

---

## 3. CSRF and HTTP method

### 3.1 GET must be read-only, enforced by an allowlist

A denylist of "actions that need POST" silently exposes every action added
later. Derive the allowlist from something already maintained:

```php
// GET allowed ONLY for actions declared read-only in the permission map
if ($method === 'GET' && ($PERMS[$action] ?? null) !== 'read') {
    http_response_code(405);
    exit;
}
```

In Next.js this is mostly given to you: a Route Handler exporting only `POST`
won't answer GET. The equivalent mistakes are **mutating inside `GET`** (or
inside a Server Component, which is a GET) and Server Actions, which are
POST-only and carry a framework CSRF token — but only protect what actually goes
through them:

```ts
export async function GET()  { /* read only — never write here */ }
export async function POST() { /* mutations live here */ }
```

### 3.2 `SameSite=Lax` is not CSRF protection

It blocks sub-resource requests (`<img>`, `fetch`) but **allows top-level
navigations** — a plain `<a href>`, a `<meta refresh>`, a redirect from the
attacker's site. If a mutating action answers GET, it is one click from running.
Use `SameSite=Strict` for session cookies where UX allows, and never rely on Lax
alone as the CSRF story.

### 3.3 Token auth is per-request, never sticky

Storing "this caller authenticated with a bearer token" **in the session** leaves
that browser cookie permanently exempt from CSRF, long after the token-bearing
request finished.

```php
$GLOBALS['bearer_auth'] = true;          // request scope
// NOT: $_SESSION['bearer_auth'] = true;
```

```ts
// Derive it per request from the header; don't persist it into the session cookie
const viaBearer = timingSafeEqualStr(req.headers.get('authorization'), `Bearer ${env.TOKEN}`);
```

### 3.4 Never accept credentials in the query string

They land in access logs, `Referer` headers, proxy logs and browser history.
Header only — in both stacks.

---

## 4. Paths and file operations

### 4.1 Validate, then resolve, then verify containment

Regex validation alone is not enough:

```php
$real = realpath($path);
$root = realpath($allowedRoot);
if (!$real || !$root || !str_starts_with($real, $root)) deny();
```

```ts
const real = await fs.realpath(path).catch(() => null);
const root = await fs.realpath(allowedRoot);
if (!real || !(real === root || real.startsWith(root + sep))) deny();
```

Note the TS version compares with a trailing separator — `startsWith(root)` alone
matches `/data/uploads-evil` against root `/data/uploads`. The same subtlety
exists in PHP.

In Next.js this matters most in dynamic routes that map a param to a file:
`app/static/[...path]/route.ts` receives an **array of segments straight from
the URL**, already percent-decoded. Join and resolve before trusting it.

### 4.2 Watch characters admitted for a legitimate reason

The audited regex allowed `.` so sub-components could be called `embed.youtube` —
which also made `..` a valid value. It reached a recursive delete:
`<base>/_trash/..` resolves to `<base>/`, wiping every component.

Reject `..`, `/`, `\` and null bytes explicitly, even when the charset "looks"
safe. In TS, also reject after decoding: `%2e%2e` arrives as `..`.

### 4.3 Apply the guard to every sibling handler

`delete_x` had containment; `purge_x` and `restore_x` did not. Destructive
handlers are exactly the ones people forget.

### 4.4 Recursive delete deserves paranoia

Before `rm -rf` semantics, assert the resolved target is inside the expected
root, is **not** the root itself, and matches an expected shape. Prefer moving to
trash over deleting.

```ts
// fs.rmSync(p, { recursive: true, force: true }) — force:true hides your mistakes
if (target === root || !target.startsWith(root + sep)) throw new Error('refusing');
```

---

## 5. SQL

Prepared statements for values, allowlists for identifiers. Column and table
names cannot be bound, so they must come from a **hardcoded constant or an
allowlist intersection** — never from input.

```php
$cols = array_intersect($declared, array_keys(tableColumns($table)));
$sql  = 'SELECT "' . implode('","', $cols) . '" FROM "' . $table . '"';
```

An ORM covers the value side by construction — Drizzle's `eq(assets.id, id)`
binds `id`. The residual risks in TS are **raw fragments** and **dynamic
ordering**:

```ts
db.run(sql.raw(`SELECT * FROM assets ORDER BY ${col}`));   // WRONG — injection
const ORDERABLE = { title: assets.title, createdAt: assets.createdAt } as const;
db.select().from(assets).orderBy(ORDERABLE[col] ?? assets.createdAt);  // RIGHT
```

### Keep declared column lists in sync with the live schema

A stale column name is not always an error. **SQLite**, given `SELECT "foo"`
where `foo` doesn't exist, returns **the string `"foo"` as the value** — so every
row carries `foo => "foo"` and it surfaces as a template printing a column name.
(Postgres and MySQL error instead, which is friendlier.) Intersect declared
columns against `PRAGMA table_info` and log what you drop.

With Drizzle the schema is typed, so this class of drift is caught at compile
time — as long as the schema file is the single source of truth and nobody
hand-writes column names in `sql.raw`.

---

## 6. Output escaping

**Escape by default; keep the raw path small and auditable.** A typed marker
(`SafeHtml`) that only a handful of call-sites can produce beats a list of
"fields we trust by name" — you can enumerate the producers and audit each one.

React escapes by default, so the equivalent audit target is narrow and precise:

```tsx
<div dangerouslySetInnerHTML={{ __html: post.body }} />   // audit EVERY one
```

Grep `dangerouslySetInnerHTML`, and sanitise at that boundary (DOMPurify or a
server-side sanitiser) unless the HTML is provably generated by your own code.

**Escaping is context-specific.** HTML-escaping is not JS-escaping.
`json_encode()` / `JSON.stringify()` do **not** neutralise `</script>`: inside a
`<script>` block the HTML parser closes the element from within your string
literal.

```php
json_encode($v, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT);
```

```ts
// Next.js: prefer passing data as props (React escapes it). If you must inline
// JSON into a <script>, escape the characters that break out of the literal:
const safe = JSON.stringify(data)
  .replace(/</g, '\\u003c')                 // prevents </script>
  .replace(/\u2028/g, '\\u2028')            // LINE SEPARATOR: valid JSON, invalid JS
  .replace(/\u2029/g, '\\u2029');           // PARAGRAPH SEPARATOR
```

**URL-typed fields need scheme validation**, not just escaping — `javascript:`
survives HTML escaping intact in an `href`, in both stacks:

```ts
const ok = /^(https?:|mailto:|\/)/i.test(url);   // allowlist, not blocklist
```

**Sanitise consistently across paths carrying the same data.** If rich text is
sanitised on one route and passed raw on another, the strict route is decoration.

**Escape on output even when input is sanitised.** The audited admin interpolated
filenames into `innerHTML` and `onclick` unescaped; it was safe *only* because
uploads stripped dangerous characters. Any other write path (import, restore,
FTP) reopens it. Defence must not depend on a single distant chokepoint.

---

## 7. Uploads

Allowlist extensions, never denylist. Check **every** dot-segment
(`evil.php.jpg`). Verify real content type (`finfo` / `getimagesize` in PHP,
`file-type` sniffing in Node), not the declared one — `Content-Type` and the
filename both come from the client.

**Treat SVG as active content**: it carries `<script>` and `on*=` handlers, so a
same-origin SVG is stored XSS. If one endpoint excludes it, propagate that
decision to every sibling endpoint.

Make upload directories non-executable at the web-server level (`php_flag engine
off`, or simply never serve them through a handler). It turns a future
validation bug from RCE into a harmless file. In Next.js, prefer serving user
files through a Route Handler that sets `Content-Type` and
`Content-Disposition: attachment` explicitly, rather than dropping them in
`public/`.

---

## 8. Read endpoints leak too

**Filter by publication state at the API boundary.** Data providers legitimately
return drafts (templates filter later); an HTTP endpoint that forwards them leaks
unpublished content to anonymous callers. The provider is not an access-control
layer — the boundary is.

```php
$rows = publishedOnly(Sources::from($collection));
```

```ts
const rows = await db.select().from(items)
  .where(and(eq(items.collection, slug), eq(items.state, 'published')));
```

Don't let the client choose visibility (`?state=draft`) unless authenticated.
Watch for asymmetries: in the audited code, lookup-by-slug filtered state and
lookup-by-id didn't.

In Next.js also watch **caching**: a personalised or draft-visible response that
gets statically cached, or a `fetch` with default caching inside a
per-user path, serves one user's data to another. Mark such routes
`export const dynamic = 'force-dynamic'` (or `cache: 'no-store'`) deliberately.

**Debug endpoints must not ship.** Arbitrary file read + `phpinfo` behind a good
token is still an unnecessary blast radius in the web root. Exclude it in the
server config *and* in `.gitignore`.

---

## 9. Errors must be loud

Empty `catch {}` blocks and unchecked write returns turn "your save failed" into
"saved!". Check the return of every write. Never swallow an exception on a path
that persists data. If a migration can fail, make it fail visibly — the audited
one silently retried on every boot, forever.

```php
if (file_put_contents($path, $json) === false) error('Failed to write ' . $path);
```

```ts
try { await fs.writeFile(path, json); }
catch (e) { logger.error({ e, path }, 'write failed'); throw e; }   // never swallow
```

---

## Auditing an existing codebase

Fan out over independent vectors rather than one pass: **auth/CSRF**,
**injection/traversal**, **XSS/public surface**, **data loss**. They need
different mental models and overlap little.

Then:

- **Verify before reporting.** Read the code path; don't infer from names.
- **Reproduce before believing.** In this audit an anonymous draft leak looked
  *false* on first test — the database simply had no drafts. Inserting one proved
  it real. **A negative test on empty data proves nothing.**
- **Separate exploitable from theoretical**, and name the actor (anonymous vs
  authenticated). "Requires admin" changes the priority, not the validity.
- **Note the existing defence** when something looks bad but is contained — and
  say *where* it is, because that tells you what breaks if it moves.
- **Look for siblings of every bug found.** The three worst findings were each
  the second or third instance of a pattern already fixed elsewhere.
- **Write the report to a file**, ordered by damage, with file:line, a concrete
  exploit, and a clear mark on what is a *decision* rather than a bug.
