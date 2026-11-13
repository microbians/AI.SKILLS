// Search helpers shared by CodeIndex and The Secretary — one copy here; each plugin's
// src/ links to it and its installer copies it next to the plugin's own code.
//
// Both plugins search SQLite FTS5 tables the same way: the words a person types, each
// matched as a word PREFIX, OR-ed together, ranked by bm25 — so a query still returns
// its best partial matches when one word is absent. Accents never matter.

// Lowercase, accents removed ("Edición" → "edicion").
export function foldAccents(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// An FTS5 MATCH expression from typed words: `"word"*` OR-ed. FTS syntax characters are
// removed (typed text is never read as an FTS operator); words shorter than minLength
// dropped. null when nothing is left.
export function ftsPrefixQuery(terms, minLength = 2) {
  const safe = terms
    .map((t) => String(t).replace(/["*()^:+\-]/g, '').trim())
    .filter((t) => t.length >= minLength);
  return safe.length ? safe.map((t) => `"${t}"*`).join(' OR ') : null;
}

// An FTS5 phrase matching a path or identifier as the words it is made of
// ("store/user-methods.js" → "store user methods js"), or null.
export function ftsPhrase(text) {
  const words = String(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return words.length ? `"${words.join(' ')}"` : null;
}

// Edit distance between a and b, or limit + 1 as soon as it is past limit.
export function editDistance(a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > limit) return limit + 1;
    prev = cur;
  }
  return prev[b.length];
}
