// Insert (or refresh) The Secretary's section in a CLAUDE.md, in place.
//
// Lives in its own file on purpose: it used to be inlined in install.sh inside
// node -e "..." with DOUBLE quotes, so bash expanded the escapes before node
// ever saw them. A regex written as '\n' arrived as a literal backslash-n in
// some spots and a real newline in others, which is why a reinstall duplicated
// the section and ate the neighbouring skill marker.
//
// Usage: node inject-claude-md.mjs <target> <snippet> <version>

import fs from 'node:fs';

const [, , target, snippetPath, version] = process.argv;
if (!target || !snippetPath || !version) {
  console.error('usage: inject-claude-md.mjs <target> <snippet> <version>');
  process.exit(2);
}

const ANCHOR = '@@THE-SECRETARY-SLOT@@';
const marker = `<!-- skill: the-secretary v${version} -->`;
const snippet = `${marker}\n${fs.readFileSync(snippetPath, 'utf-8').trim()}\n`;

let md = fs.readFileSync(target, 'utf-8');

// Cut one section: its heading through to the next heading, taking with it a
// marker comment sitting directly above its own heading — but never the marker
// belonging to the NEXT section, which is what used to strip secure-coding's.
// Headings are anchored to the start of a line, or '## The Secretary' also
// matches the prose sentence "The Secretary keeps ONE flat index...".
// No 'm' flag: with it, the trailing $ matches at every line end and the cut
// stops after the heading, orphaning the body. Without it, $ means end of file,
// so a section that is the last one is still consumed whole.
const cut = (text, heading) => text.replace(
  new RegExp(
    `(?:^|\\n)(?:<!-- skill: [^\\n]*-->\\n)?${heading}[^\\n]*\\n[\\s\\S]*?(?=\\n(?:<!-- skill: [^\\n]*-->\\n)?## |\\n---\\n|$)`,
  ),
  `\n${ANCHOR}`,
);

md = cut(md, '## ClaudeSumarizer');            // legacy name
md = cut(md, '## The Secretary');              // legacy name
md = cut(md, '## Memory / notes / reminders'); // current name

// Put the section back where it already lived instead of appending, so a
// reinstall is a no-op rather than shuffling the file's order every time.
if (md.includes(ANCHOR)) {
  md = md.replace(ANCHOR, snippet.trim());
  md = md.split(ANCHOR).join(''); // a rename can leave more than one placeholder
} else {
  md = `${md.trimEnd()}\n\n${snippet.trim()}\n`;
}

md = `${md.replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;

if (md.includes('\0')) {
  console.error('refusing to write: NUL byte in output');
  process.exit(1);
}

fs.writeFileSync(target, md);
