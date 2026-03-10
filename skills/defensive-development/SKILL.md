---
name: defensive-development
description: Verification-first coding practices. Read before edit, grep before assume, verify API names, safe refactoring with reference checks. Never blame external factors.
license: MIT
compatibility: opencode
metadata:
  type: methodology
  scope: all-codebases
---

# Defensive Development Skill

## Auto-Installation

This skill requires no installation. It's a methodology to follow, not a system to set up.

**To activate:** Load this skill at session start or when needed:
```
skill({ name: "defensive-development" })
```

**When to load automatically:**
- First time editing an unfamiliar codebase
- Before any refactoring task
- When debugging persistent issues

---

## When to Use This Skill

Apply these practices when:
- Editing an unfamiliar codebase
- Using library/framework APIs you haven't memorized
- Refactoring existing code
- Before any destructive operation (delete, rename, move)
- When inheriting code from another developer
- When returning to code after a long break
- Debugging issues that "shouldn't happen"

**Core Philosophy:** "Verify then trust" - never assume code behavior, API signatures, or property names. Always check first.

---

## Section 1: The Verification Mindset

### 1.1 Trust Nothing, Verify Everything

```
WRONG MINDSET
"I think this method exists..."
"This should work..."
"I remember the API being..."
"It's probably called..."
"It must be a cache issue..."

CORRECT MINDSET
"Let me check if this method exists..."
"Let me verify the API signature..."
"Let me find a working example..."
"Let me grep the actual property name..."
"Let me verify the syntax is correct..."
```

### 1.2 The Protocol

Before making ANY code change, follow this sequence:

```
+---------------------------------------------------------------+
|                                                               |
|  READ -> MAP -> LIST -> PRESENT -> WAIT -> EXECUTE -> VERIFY  |
|                                                               |
+---------------------------------------------------------------+

1. READ
   |
   +-- Read the file(s) you plan to modify
   |
   +-- Read related files (imports, dependencies)
   |
   +-- Read tests for usage examples

2. MAP
   |
   +-- Understand the code structure
   |
   +-- Identify dependencies and side effects
   |
   +-- Note all places that reference this code

3. LIST
   |
   +-- List all changes needed
   |
   +-- List all files affected
   |
   +-- List potential risks

4. PRESENT
   |
   +-- Explain the plan before executing
   |
   +-- Show the specific changes
   |
   +-- Highlight any risks

5. WAIT
   |
   +-- Get confirmation before destructive operations
   |
   +-- Ask if unclear about requirements
   |
   +-- Pause if something seems wrong

6. EXECUTE
   |
   +-- Make surgical, focused changes
   |
   +-- One logical change at a time
   |
   +-- Keep changes minimal

7. VERIFY
   |
   +-- Test the change works
   |
   +-- Verify no regressions
   |
   +-- Check edge cases (0, null, empty, missing)
```

### 1.3 Listen Literally

When given instructions, execute them EXACTLY. Don't theorize, don't assume you know better.

```
User says: "Search for handleClick"

WRONG
"I think handleClick might be in the components
folder, let me check there first..."
[Starts browsing folders without searching]

CORRECT
grep -rn "handleClick" src/
[Executes search immediately, shows results]
```

```
User says: "Use the Redis cache"

WRONG
"I'll implement a cache using localStorage instead,
it's simpler..."

CORRECT
"Let me find how Redis is used in this codebase..."
grep -rn "redis\|Redis" src/
```

### 1.4 Never Confirm Without Verification

```
User says: "The bug is in the auth module"

WRONG
"You're right, let me fix the auth module..."
[Starts editing without checking]

CORRECT
"Let me verify that's where the issue is..."
[Reads auth module, traces the bug, confirms]
"Yes, confirmed. The issue is at line 45..."
```

**Rule:** Only say "You're right" AFTER reading code and confirming facts. If not verified, say "Let me check" and investigate.

### 1.5 Never Blame External Factors

When something doesn't work, NEVER immediately blame:
- Cache (browser, server, CDN)
- Environment issues
- "Works on my machine"
- Network problems
- Race conditions (without proof)

**Instead, verify systematically:**

```bash
# Verify syntax is correct
node --check file.js          # JavaScript
python -m py_compile file.py  # Python
go build ./...                # Go

# Test the actual response
curl -v http://localhost:3000/api/endpoint

# Create minimal reproduction
# Write a small test file that isolates the issue

# Check file was actually saved/deployed
cat file.js | head -20
ls -la file.js
```

**The code is wrong until proven otherwise.** Cache is almost never the problem.

---

## Section 2: API Discovery Techniques

### 2.1 Finding Property Names

**Problem:** You need to use a property but don't know its exact name.

**Solution:** Grep the codebase for similar patterns.

```bash
# Language-agnostic: search for property patterns
grep -rn "propertyName" src/
grep -rn "\.propertyName" src/
grep -rn "this\.property" src/

# JavaScript/TypeScript: search class definition
grep -n "this\." src/ClassName.js | head -20

# Python: search class attributes
grep -n "self\." src/class_name.py | head -20

# Go: search struct fields
grep -n "type.*struct" src/*.go

# Ruby: search instance variables
grep -n "@" src/class_name.rb | head -20
```

**Real Example:**

```javascript
// WRONG - Invented property name
const timeout = config.requestTimeout;  // undefined!

// How to find correct name:
// $ grep -n "timeout" src/config.js
// Found: this.http = new HttpClient(...)
// Found: this.http.timeout

// CORRECT - Verified property name
const timeout = config.http.timeout;
```

### 2.2 Finding Constructor/Initializer Parameters

**Problem:** You need to instantiate a class but don't know what parameters it accepts.

**Solution:** Read the constructor definition AND find working examples.

```bash
# JavaScript: find constructor
grep -n "constructor" src/ClassName.js
grep -A 20 "constructor(" src/ClassName.js

# TypeScript: find constructor with types
grep -A 30 "constructor(" src/ClassName.ts

# Python: find __init__
grep -A 20 "def __init__" src/class_name.py

# Go: find New function (constructor pattern)
grep -A 10 "func New" src/package/*.go

# Ruby: find initialize
grep -A 15 "def initialize" src/class_name.rb

# Find working examples in tests (GOLD!)
grep -rn "new ClassName" test/
grep -rn "ClassName(" test/
```

### 2.3 Constructor vs Setter - Critical Distinction

**Problem:** You pass a property to constructor but it's silently ignored.

**Why it happens:** The property is a getter/setter, not a constructor option.

```bash
# Check if it's a getter/setter
grep -n "get propertyName\|set propertyName" src/Class.js

# Check what constructor actually accepts
grep -A 30 "constructor(" src/Class.js | grep "const {" 

# Find how others use it (the truth)
grep -rn "\.propertyName.*=" test/
```

**Real Example:**

```javascript
// WRONG - Treated getter/setter as constructor option
const button = new Button({
    label: 'Submit',
    disabled: true  // Silently ignored! It's a setter
});
// Result: button.disabled === undefined

// How to find the truth:
// $ grep -n "get disabled\|set disabled" src/Button.js
// Found: get disabled() { return this._disabled; }
// Found: set disabled(v) { this._disabled = v; }
// (No mention in constructor defaults)

// CORRECT - Use as setter after construction
const button = new Button({ label: 'Submit' });
button.disabled = true;
```

### 2.4 Never Use Properties Before Initialization

In constructors, property order matters. Don't reference properties before they're set.

```javascript
// WRONG - Using this.width before it's assigned
class Box {
    constructor(options) {
        this.area = this.width * this.height;  // undefined * undefined = NaN
        this.width = options.width;
        this.height = options.height;
    }
}

// CORRECT - Assign first, compute after
class Box {
    constructor(options) {
        this.width = options.width;
        this.height = options.height;
        this.area = this.width * this.height;  // Now works
    }
}
```

### 2.5 Finding Working Examples

**Strategy:** Tests are gold - they show WORKING code that must be correct.

```bash
# Find all usages of a class
grep -rn "ClassName" --include="*.js" .

# Find instantiation examples
grep -rn "new ClassName" test/

# Find method calls
grep -rn "\.methodName(" test/

# Find in actual application code
grep -rn "ClassName" src/ --include="*.js" | grep -v test
```

### 2.6 Verifying Imports

**Problem:** You use a class/function but forgot to import it.

```bash
# Check what's imported in current file
grep "^import" src/myfile.js

# Find where a class is exported from
grep -rn "export.*ClassName" src/

# Find the correct import path
grep -rn "from.*ClassName\|import.*ClassName" src/
```

**Real Example:**

```javascript
// WRONG - Class not imported
import { Button, Input } from './components/forms.js';
const label = new Label({ text: 'Hello' });
// ReferenceError: Label is not defined

// HOW TO VERIFY:
// $ grep "^import" src/myfile.js
// (Label is missing!)

// CORRECT - Added Label to imports
import { Button, Input, Label } from './components/forms.js';
```

### 2.7 API Discovery Checklist

Before using ANY API:

```
[] Grep the property/method name to verify it exists
[] Read the class definition (constructor, methods)
[] Find working examples in tests
[] Check if it's a getter/setter or constructor option
[] Verify the import statement
[] Check parameter order and types
[] Look for default values
[] Verify property initialization order in constructors
```

---

## Section 3: Safe Refactoring Rules

### 3.1 File Operations

**Deletion requires explicit confirmation:**

```
BEFORE DELETING ANY FILE:

1. State the exact filename
2. Explain why it should be deleted
3. Show what references it (should be zero)
4. Wait for explicit confirmation

Example:
"I will delete src/utils/oldHelper.js because:"
"- It's no longer imported anywhere (verified)"
"- It was replaced by src/utils/newHelper.js"
"Confirm deletion? [y/n]"
```

**Rename/Move requires reference update:**

```bash
# Before renaming, find ALL references
grep -rn "oldFileName" .
grep -rn "old-file-name" .
grep -rn "OldFileName" .

# Check imports, requires, configuration files
grep -rn "oldFileName" --include="*.json" .
grep -rn "oldFileName" --include="*.yaml" .
grep -rn "oldFileName" --include="*.md" .
```

### 3.2 Code Deletion Thresholds

```
DELETION THRESHOLDS

Lines to delete    Action required
-------------------------------------------------
1-10 lines         Proceed (explain why)
11-50 lines        Explain + wait for confirmation
51-100 lines       Detailed justification + confirm
100+ lines         Break into smaller operations

Files to delete    Action required
-------------------------------------------------
1 file             Confirm filename
2-5 files          List all + confirm each
5+ files           Stop, reassess, discuss first
```

### 3.3 Never Use Complex Shell Commands for Edits

**Avoid bash/sed/awk/perl for code modifications:**

```bash
# WRONG - Fragile and error-prone
sed -i 's/oldFunction/newFunction/g' src/*.js
perl -pi -e 's/foo/bar/' **/*.ts
awk '{gsub(/old/,"new")}1' file.js > temp && mv temp file.js

# CORRECT - Use proper editor tools
# Read the file, understand context, make precise edits
# Use Edit tool with exact string matching
# Verify the change is correct before and after
```

**Why:** Shell commands don't understand code structure, can't handle edge cases (strings, comments, similar names), and are hard to verify.

### 3.4 Cascading Changes

**Never make cascading changes without a plan:**

```
WRONG - Cascading without planning
"I'll rename this function..."
[Renames in one file]
"Oh, it's used here too..."
[Renames in another file]
"And here..."
[Eventually breaks something]

CORRECT - Plan first, then execute
"I want to rename getUserData to fetchUserData."
"Let me find all references first..."

$ grep -rn "getUserData" --include="*.js" .
src/api/user.js:15:     export function getUserData()
src/components/Profile.js:8:    import { getUserData }
test/api/user.test.js:12:       import { getUserData }
docs/api.md:45:                 Call `getUserData()` to fetch...

"Found 7 references in 4 files. Plan:"
"1. Update export in src/api/user.js"
"2. Update import in src/components/Profile.js"
"3. Update import in test/api/user.test.js"
"4. Update documentation in docs/api.md"
"Proceed? [y/n]"
```

### 3.5 Reference Verification

**After any rename/delete, verify zero dangling references:**

```bash
# After renaming oldName to newName
grep -rn "oldName" .
# Should return: nothing (zero matches)

# If matches found, the refactor is incomplete!
```

**Common places people forget:**

```bash
# Configuration files
grep -rn "oldName" --include="*.json" .
grep -rn "oldName" --include="*.yaml" .
grep -rn "oldName" --include="*.toml" .
grep -rn "oldName" --include="*.env*" .

# Documentation
grep -rn "oldName" --include="*.md" .
grep -rn "oldName" --include="*.txt" .
grep -rn "oldName" --include="*.rst" .

# Build/Deploy scripts
grep -rn "oldName" --include="*.sh" .
grep -rn "oldName" --include="Makefile" .
grep -rn "oldName" --include="Dockerfile" .
grep -rn "oldName" --include="*.yml" .

# Comments in code (often forgotten)
grep -rn "oldName" --include="*.js" . | grep "//"
grep -rn "oldName" --include="*.py" . | grep "#"
```

---

## Section 4: Debugging Before Changing

### 4.1 Verify With Logs FIRST

**Never change code to fix a bug without first understanding it:**

```javascript
// WRONG - Change code hoping it fixes the bug
function processData(data) {
    return data.filter(x => x.active);  // Changed from x.isActive
}

// CORRECT - Add logs to understand the bug first
function processData(data) {
    console.log('processData input:', data);
    console.log('First item:', data[0]);
    console.log('Has active?', 'active' in data[0]);
    console.log('Has isActive?', 'isActive' in data[0]);
    
    const result = data.filter(x => x.active);
    console.log('processData output:', result);
    return result;
}

// Run, see logs, THEN make informed changes
```

### 4.2 Verify Assumptions With Code

```javascript
// Instead of assuming, verify:

// Assumption: "This array should have items"
console.log('items.length:', items.length);
console.log('items:', items);

// Assumption: "This should be a number"
console.log('typeof value:', typeof value);
console.log('value:', value);

// Assumption: "This callback should be called"
function myCallback(result) {
    console.log('CALLBACK CALLED with:', result);
    // ... rest of code
}

// Assumption: "This element should exist"
console.log('element:', element);
console.log('element exists:', !!element);
```

### 4.3 Test Edge Cases

Always verify behavior with edge cases:

```
EDGE CASES TO TEST

Input type        Test values
-------------------------------------------------
Numbers           0, -1, NaN, Infinity, MAX_VALUE
Strings           "", " ", null, undefined
Arrays            [], [one], [many], sparse arrays
Objects           {}, null, undefined, circular refs
Booleans          true, false, truthy (1), falsy (0, "")
Functions         missing callback, throws error, async
Optional params   undefined, null, omitted entirely
```

```javascript
// After modifying a function, test edge cases:
function processItems(items) {
    // ... your modified code ...
}

// Test:
processItems([]);           // Empty array
processItems([1]);          // Single item
processItems(null);         // Null input
processItems(undefined);    // Undefined input
processItems([1,2,3,4,5]);  // Normal case
```

---

## Section 5: Pre-Change Checklists

### Before Editing Code

```
PRE-EDIT CHECKLIST

[] Read the file(s) I'm about to modify
[] Understand what the code currently does
[] Verified any API/property names I'll use
[] Found working examples if using unfamiliar API
[] Checked imports for any new classes/functions
[] Identified all places affected by this change
[] Have a way to test the change works
```

### Before Deleting Code

```
PRE-DELETE CHECKLIST

[] Stated exact filename/code to delete
[] Explained WHY it should be deleted
[] Grepped for all references (found zero)
[] Checked config files, docs, comments
[] Got explicit confirmation if >50 lines
```

### Before Refactoring

```
PRE-REFACTOR CHECKLIST

[] Listed ALL files that will change
[] Grepped ALL references to renamed items
[] Included tests in the refactor plan
[] Included documentation in the refactor plan
[] Included config files in the refactor plan
[] Have a way to verify zero dangling references
[] Breaking into small, verifiable steps
[] NOT using sed/awk/perl for code changes
```

---

## Section 6: Anti-Patterns (Never Do This)

```
NEVER DO THIS

[] Delete files without explicit filename confirmation
[] Delete >50 lines without approval
[] Use bash/sed/perl for complex code edits
[] Make cascading changes without a plan
[] Assume a method exists (verify first)
[] Assume code behavior (read implementation)
[] Use properties before init in constructor
[] Refactor without grep ALL refs
[] Say "You're right" without verification
[] Blame cache/environment before checking code
[] Invent property names (grep existing code)
[] Change code to fix a bug without logging first
```

---

## Quick Reference Card

```
DEFENSIVE DEVELOPMENT QUICK REFERENCE

PROTOCOL
READ -> MAP -> LIST -> PRESENT -> WAIT -> EXECUTE -> VERIFY

MINDSET
- Verify then trust (never assume)
- Listen literally (execute exactly what's asked)
- Confirm only after verification
- Never blame cache/environment first

API DISCOVERY
- grep property names before using
- grep constructor for parameters
- grep tests for working examples
- Check getter/setter vs constructor option
- Verify imports exist
- Check property init order

SAFE REFACTORING
- >50 lines deletion = get approval
- grep ALL refs before rename
- Check: code, tests, docs, config, comments
- Verify zero dangling refs after
- NO sed/awk/perl for code edits

DEBUG FIRST
- Add logs before changing code
- Verify assumptions with console.log
- Understand bug before fixing
- Test edge cases: 0, null, [], "", undefined

COMMON COMMANDS
- grep -rn "name" src/
- grep -A 10 "constructor" src/Class.js
- grep -rn "new ClassName" test/
- grep "^import" src/myfile.js
- node --check file.js  (verify syntax)
```
