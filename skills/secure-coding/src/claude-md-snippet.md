<!-- skill: secure-coding vSKILL_VERSION -->
## Security & data integrity

When writing or reviewing server-side code, STRICTLY follow the `secure-coding` skill rules. Invoke it BEFORE: adding or changing an API endpoint or its permission check, writing/deleting files, building a path or a query from user input, writing a template filter or anything that renders user data, or auditing a codebase.

**The rule underneath all of them: fail closed — the absence of a decision must never mean "allow" or "delete".** An action missing from the permission map needs the STRICTEST permission, not none. A payload key that never arrived means "leave it alone", not "empty it" (`array_key_exists` / `'k' in obj`, never `?? ''`). GET is read-only, enforced by an allowlist. Empty input never overwrites stored non-empty data unless the caller says so explicitly; snapshot before every destructive write. And when you fix a writer, grep for its twins — the worst data-loss bugs are second instances of a pattern already fixed elsewhere.
