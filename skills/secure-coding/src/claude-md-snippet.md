<!-- skill: secure-coding vSKILL_VERSION -->
## Security & data integrity

Invoke the `secure-coding` skill BEFORE adding/changing an API endpoint or permission check, writing/deleting files, building a path or query from user input, rendering user data, or auditing.

**Fail closed — absence of a decision never means "allow" or "delete".** Unmapped action → strictest permission. A missing payload key means "leave it alone" (`array_key_exists`, never `?? ''`). GET is read-only via allowlist. Empty input never overwrites non-empty data unless explicit; snapshot before destructive writes. Fixed a writer → grep its twins.
