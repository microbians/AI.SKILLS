---
name: ascii-art-diagrams
description: Rules for creating ASCII art diagrams with Unicode box-drawing characters. Covers boxes, trees, flow charts, and visual representations.
license: MIT
compatibility: opencode
metadata:
  type: formatting
  font: Fira Code
---

# ASCII Art Diagrams Skill

## Auto-Installation

This skill requires no installation. It's a formatting guide, not a system.

**To activate:** Load this skill when you need to create diagrams:
```
skill({ name: "ascii-art-diagrams" })
```

**When to load automatically:**
- Creating architecture documentation
- Explaining complex flows or algorithms
- Building visual representations in code comments or markdown

---

## When to Use This Skill

Use this skill when creating:
- Architecture diagrams
- Flow charts
- Tree structures (file trees, decision trees, hierarchies)
- Box diagrams (notes, warnings, info boxes)
- Tables with borders
- Any visual representation using Unicode box-drawing characters

## Prerequisites

### Font Requirement

For Unicode block characters and box-drawing characters to render correctly with monospace alignment:

```css
/* Google Fonts - Fira Code */
@import url('https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500;700&display=swap');

/* Apply to code blocks */
pre, code, .ascii-art {
    font-family: 'Fira Code', Menlo, Monaco, Consolas, 'Courier New', monospace;
}
```

### Line Height

Use line-height 1 for ASCII diagrams (no extra spacing needed):

```css
.ascii-art {
    line-height: 1;
}
```

---

## Rule 1: Box Construction

### 1.1 All Lines Must Have Equal Length

Every line in a box MUST have identical character count. Pad shorter lines with spaces.

```
WRONG (unequal line lengths)
┌───────────────┐
│ short │
│ this is longer text │
└───────────────┘

CORRECT (all lines equal)
┌─────────────────────┐
│ short               │
│ this is longer text │
└─────────────────────┘
```

### 1.2 Compact Text - No Empty Lines Between Content

With line-height 1, content is compact. NO empty lines needed between text lines:

```
CORRECT (compact, no spacers)
┌───────────────────────────────────────────────────────┐
│  Modifying state DURING iteration loop                │
│  causes concurrent modification exception             │
│  -> collect changes, apply after loop completes       │
└───────────────────────────────────────────────────────┘
```

### 1.3 Minimum Padding

Always have at least 1-2 spaces between content and border:

```
CORRECT (2 space padding)
┌───────────────────────────────────────────────────────┐
│                                                       │
│  During batch processing:                             │
│                                                       │
│    - Items are processed sequentially                 │
│    - Cache is NOT invalidated                         │
│    - Previous results may be stale                    │
│                                                       │
└───────────────────────────────────────────────────────┘
```

Note: Empty lines at TOP and BOTTOM of box content are optional but recommended for readability.

---

## Rule 2: Section Titles

### 2.1 Use Underlines for Title

In pseudocode blocks, use underline characters for title underlines:

```
CORRECT
FULL BUILD
___________________________________________________


1. CLEAN output directory

2. SORT dependencies by priority
```

**Key points:**
- One empty line after the underline
- Creates clean visual separation

### 2.2 Subsection Titles

For minor subsections within boxes, use thin horizontal lines:

```
MODE 1: Single Result (default)

- Returns first matching item
- Uses: findFirst()
- Best performance


MODE 2: All Results

- Returns array of ALL matching items
```

---

## Rule 3: Tree Structures (Procedural Flow)

### 3.1 Basic Pattern

Numbered steps with tree branches for sub-steps:

```
1. LOAD configuration file

2. SORT tasks by priority (low -> high)

3. FOR EACH task (sorted):
   │
   ├── EXECUTE task
   │
   └── IF task.hasCallback AND task.succeeded:
       │
       └── IF callback.isAsync:
           │
           └── QUEUE callback for later

4. PROCESS callbacks:
   │
   ├── IF pending_callbacks.length > 0:
   │   │
   │   └── RUN each callback
   │
   └── IF errors.length > 0:
       │
       └── LOG errors to file
```

### 3.2 Key Rules

- `│` for vertical continuation
- `├──` for branch with more siblings below
- `└──` for last branch (no more siblings)
- Indent nested levels by 4 spaces
- One empty line between major steps
- Sub-branches connect without empty lines

### 3.3 Continue `│` When More Siblings Follow

```
CORRECT
├── Child with nested content
│   │
│   └── Nested item
│
└── Last sibling
```

---

## Rule 4: Flow Diagrams

### 4.1 Vertical Flow with Boxes

Each step gets a box. Use `│` and `▼` between boxes:

```
┌───────────────────────┐
│                       │
│  processRequest()     │
│                       │
└───────────────────────┘
           │
           │
           ▼
┌───────────────────────┐
│                       │
│  validateInput        │
│                       │
└───────────────────────┘
           │
           │
           ▼
┌───────────────────────┐
│                       │
│  needsAuth?           │
│                       │
└───────────────────────┘
```

### 4.2 Branching Decisions

Use side branches with YES/NO labels and return lines:

```
┌───────────────────────┐
│                       │ YES
│  needsAuth?           │──▶───────────┐
│                       │              │
└───────────────────────┘              │
           │                           │
           │ NO                        │
           │                           │
           ▼                           │
┌───────────────────────┐              │
│                       │              │
│  Apply rate limits    │              │
│                       │              │
└───────────────────────┘              │
           │                           │
           │                           │
           ▼                           ▼
┌───────────────────────┐     ┌────────┴──────────┐
│                       │ YES │                   │
│  cache.isValid?       │──▶──┤  returnCached()   │──▶─┐
│                       │     │                   │    │
│                       │     └───────────────────┘    │
└───────────────────────┘                              │
           │                                           │
           │ NO                                        │
           │                                           │
           ▼                                           │
```

### 4.3 Return Lines

Use `<` for return flow:

```
           │                                           │
           │ ◀─────────────────────────────────────────┘
           │
           ▼
┌──────────────────────┐
│                      │
│  DONE                │
│                      │
└──────────────────────┘
```

---

## Rule 5: Graphics vs Text

### 5.1 Graphics (Pixel Art) - Compact

When content is visual/graphical, NO empty lines between rows:

```
┌────────────────────────┐
│░░░░░░░░░░░░░░░░░░░░░░░░│
│░░░░░░░░░░░░░░░░░░░░░░░░│
│░░░░░░░░░░░░░░░░░░░░░░░░│
│░░░░░░████░░░░░░░░░░░░░░│
│░░░░░░████░░░░░░░░░░░░░░│
│░░░░░░████░░░░░░░░░░░░░░│
│░░░░░░░░░░░░░░░░░░░░░░░░│
└────────────────────────┘
```

### 5.2 Visual Character Choices

```
█ = Full block (solid, primary)
▓ = Dark shade (highlighted)
▒ = Medium shade
░ = Light shade (background, secondary)
  = Empty/cleared area
```

---

## Rule 6: Special Box Formats

### 6.1 Note Box with Label

```
┌────────┬───────────────────────────────────────────────────┐
│        │  Cache is NOT invalidated during                  │
│  NOTE  │  batch operations!                                │
│        │  Results may be stale until refresh.              │
└────────┴───────────────────────────────────────────────────┘
```

### 6.2 Info Box with Tree Inside

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│  Step N: Received event                                 │
│    │                                                    │
│    │                                                    │
│    └── QUEUE change (don't apply yet)                   │
│                                                         │
│        pendingChanges = {                               │
│            toRemove: previousItem,                      │
│            toAdd: newItem                               │
│        }                                                │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## Rule 7: Labeled Sections

### 7.1 Compact Within, Space Between

```
PROBLEM:
 
┌─────────────────────────────────────────────────────────┐
│  Modifying collection DURING iteration loop             │
│  causes ConcurrentModificationException                 │
│  -> collect changes, apply after loop ends              │
└─────────────────────────────────────────────────────────┘


SOLUTION:
 
┌─────────────────────────────────────────────────────────┐
│  ...content...                                          │
└─────────────────────────────────────────────────────────┘
```

**Rules:**
- One empty line after label (before box)
- Two empty lines between sections
- Content inside boxes is compact (no internal empty lines unless for visual grouping)

---

## Rule 8: Character Count Verification (Mandatory Bash Check)

### CRITICAL: Verify Every Box With Bash

**After generating ANY box diagram, you MUST run the verification command below before presenting it to the user.** Do NOT rely on visual counting — LLMs consistently miscount characters. Use real tooling instead.

### Step 1: Generate the diagram normally

Write the diagram as you normally would following Rules 1-7.

### Step 2: Verify with bash

Run this command, pasting your diagram between the quotes:

```bash
echo '┌─────────────────────────┐
│  your content here      │
│  more content           │
└─────────────────────────┘' | while IFS= read -r line; do printf "%d: %s\n" "$(echo -n "$line" | wc -m)" "$line"; done
```

All lines MUST show the **same number**. Example output:

```
27: ┌─────────────────────────┐
27: │  your content here      │
27: │  more content           │
27: └─────────────────────────┘
```

### Step 3: Fix if numbers differ

If any line shows a different count:

```
27: ┌─────────────────────────┐
27: │  your content here      │
28: │  more content            │   ← 28 ≠ 27, extra space
27: └─────────────────────────┘
```

- Add or remove spaces before the right `│` to match the target width
- Re-run the verification command
- Repeat until ALL lines show the same number

### Notes

- The command uses `wc -m` which counts Unicode characters correctly (not bytes)
- Each `█ ░ ▒ ▓ ─ │ ┌ ┐ └ ┘ ├ ┤ ┬ ┴ ▼ ▲ ◀ ▶` counts as 1 character
- This check costs one tool call but eliminates all retry loops

---

## Rule 9: Character Reference

### Box Drawing — ALWAYS use Unicode box-drawing characters

**NEVER use `+`, `-`, `|` for box borders.** Always use Unicode box-drawing:

```
Corners:  ┌ ┐ └ ┘
Lines:    ─ │
T-joins:  ┬ ┴ ├ ┤
Cross:    ┼
Double:   ═ ║ ╔ ╗ ╚ ╝ ╠ ╣ ╦ ╩ ╬
```

Example:
```
┌───────────────────────┐
│  Content here         │
├───────────────────────┤
│  More content         │
└───────────────────────┘
```

### Shade Blocks (for grids, heatmaps, coverage diagrams)

```
░ = Light shade (partial, secondary)
▒ = Medium shade
▓ = Dark shade
█ = Full block (solid, primary)
  = Empty (space)
```

### Arrows

```
Down:   ▼ (or v in text flow)
Up:     ▲ (or ^ in text flow)
Left:   ◀ (or <)
Right:  ▶ (or >)
Flow:   → ← (in text)
Branch: ──▶── (horizontal connector)
```

### Bullets and Symbols

```
Bullets:  - * 
Check:    [x] [ ]
```

---

## Quick Reference

```
TITLE WITH UNDERLINE
____________________


1. Step one

2. Step two:
   │
   ├── Sub-step A
   │
   └── Sub-step B


┌───────────────────────┐
│                       │
│  Box content          │
│  More content         │
│                       │
└───────────────────────┘


┌────────┬──────────────┐
│  LABEL │  Content     │
└────────┴──────────────┘


           │
           │
           ▼
┌───────────────────────┐
│  Next step            │
└───────────────────────┘
           │
           │ ◀──────────┐ (return line)
           │
           ▼
```
