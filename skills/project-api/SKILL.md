---
name: project-api
description: Auto-generates and maintains project API documentation. Extracts classes, functions, exports from code. Self-healing, auto-installing.
license: MIT
compatibility: opencode
metadata:
  type: documentation
  output: .claude/api.md
  scope: all-codebases
---

# Project API Skill

## Auto-Installation

**Step 1:** Check if API file exists:
```bash
test -f .claude/api.md && echo "exists" || echo "missing"
```

**Step 2:** If "missing" or outdated, generate it using the generation script below.

**Step 3:** Verify:
```bash
head -50 .claude/api.md
```

**When to auto-install:** First session in project, after major code changes, or when API seems outdated.

---

## Overview

This skill automatically generates and maintains a `.claude/api.md` file that documents the project's public API: classes with their methods, inheritance hierarchy, constructor parameters, and function signatures.

**Philosophy:** "Know the API before you code" - instant reference without reading all source files.

**Output location:** `.claude/api.md`

---

## Generate API

### JavaScript/TypeScript Full API Generation

```bash
bash -c 'cat > .claude/api.md << API_EOF
# Project API Reference

Generated: $(date +%Y-%m-%d)

---

## Class Hierarchy

$(grep -rn "extends" --include="*.js" --include="*.ts" . 2>/dev/null | grep -v node_modules | grep -v dist | grep "class.*extends" | sed "s/.*class \([A-Za-z]*\) extends \([A-Za-z]*\).*/\2 → \1/" | sort | uniq)

---

## Classes with Methods

$(for file in $(find . -name "*.js" -type f 2>/dev/null | grep -v node_modules | grep -v dist | sort); do
  classes=$(grep -n "^export class\|^class " "$file" 2>/dev/null | head -5)
  if [ -n "$classes" ]; then
    echo ""
    echo "### $(basename $file)"
    echo "\`$file\`"
    echo ""
    
    # Extract each class with its methods
    grep -n "^export class\|^class " "$file" 2>/dev/null | while read classline; do
      classname=$(echo "$classline" | sed "s/.*class \([A-Za-z_]*\).*/\1/")
      linenum=$(echo "$classline" | cut -d: -f1)
      extends=$(echo "$classline" | grep -o "extends [A-Za-z_]*" | sed "s/extends //" || echo "")
      
      if [ -n "$extends" ]; then
        echo "#### $classname (extends $extends)"
      else
        echo "#### $classname"
      fi
      echo ""
      
      # Get constructor signature
      constructor=$(awk "NR>=$linenum && NR<=$((linenum+50))" "$file" 2>/dev/null | grep -m1 "constructor(" | sed "s/^[[:space:]]*//" | head -1)
      if [ -n "$constructor" ]; then
        echo "**Constructor:** \`$constructor\`"
        echo ""
      fi
      
      # Get methods (public ones, first 15)
      echo "**Methods:**"
      awk "NR>=$linenum && NR<=$((linenum+300))" "$file" 2>/dev/null | grep -E "^[[:space:]]+(async\s+)?[a-zA-Z_][a-zA-Z0-9_]*\s*\(" | grep -v "constructor\|^[[:space:]]*//\|^[[:space:]]*\*" | sed "s/^[[:space:]]*/- \`/" | sed "s/$/\`/" | head -15
      echo ""
    done
  fi
done | head -500)

---

## Exported Functions

$(grep -rn "^export function\|^export async function\|^export const.*=.*=>" --include="*.js" --include="*.ts" . 2>/dev/null | grep -v node_modules | grep -v dist | while read line; do
  file=$(echo "$line" | cut -d: -f1)
  content=$(echo "$line" | cut -d: -f3-)
  # Extract function name and params
  if echo "$content" | grep -q "^export function\|^export async function"; then
    sig=$(echo "$content" | sed "s/export \(async \)\{0,1\}function //" | sed "s/{.*//" | tr -d "\n")
    echo "- \`$sig\` → $file"
  elif echo "$content" | grep -q "^export const.*=>"; then
    name=$(echo "$content" | sed "s/export const \([a-zA-Z_]*\).*/\1/")
    echo "- \`$name\` → $file"
  fi
done | head -50)

---

## Getters and Setters

$(grep -rn "^\s*get \|^\s*set " --include="*.js" --include="*.ts" . 2>/dev/null | grep -v node_modules | grep -v dist | grep -v "\.test\.\|\.spec\." | sed "s/^[[:space:]]*//" | awk -F: '{
  file=$1; 
  prop=$3; 
  gsub(/^[[:space:]]*/, "", prop);
  gsub(/[[:space:]]*\{.*/, "", prop);
  print "- `" prop "` → " file
}' | sort | uniq | head -40)

---

## Event Names / Constants

$(grep -rn "addEventListener\|on[A-Z][a-z]*.*=" --include="*.js" . 2>/dev/null | grep -v node_modules | grep -oE "'[a-z]+'" | sort | uniq -c | sort -rn | head -15 | awk '{print "- " $2 " (" $1 " uses)"}')

---

## Common Patterns

### Frequently Used Properties
$(grep -rn "this\.\(width\|height\|x\|y\|id\|name\|value\|type\|status\)" --include="*.js" --include="*.ts" . 2>/dev/null | grep -v node_modules | grep -oE "this\.[a-zA-Z_]+" | sed "s/this\.//" | sort | uniq -c | sort -rn | head -15)

---

## Entry Points

$(find . -maxdepth 3 -name "index.js" -type f 2>/dev/null | grep -v node_modules | while read f; do
  echo "### $f"
  grep "^export" "$f" 2>/dev/null | head -20
  echo ""
done)

---

## Quick API Lookup

| Class | File | Extends | Key Methods |
|-------|------|---------|-------------|
$(grep -rn "^export class" --include="*.js" . 2>/dev/null | grep -v node_modules | grep -v dist | head -25 | while read line; do
  file=$(echo "$line" | cut -d: -f1)
  classinfo=$(echo "$line" | cut -d: -f3-)
  classname=$(echo "$classinfo" | sed "s/.*class \([A-Za-z_]*\).*/\1/")
  extends=$(echo "$classinfo" | grep -o "extends [A-Za-z_]*" | sed "s/extends //" || echo "-")
  methods=$(grep -A 100 "class $classname" "$file" 2>/dev/null | grep -E "^[[:space:]]+(async\s+)?[a-zA-Z_][a-zA-Z0-9_]*\s*\(" | grep -v constructor | head -3 | sed "s/(.*//" | tr -d " \t" | tr "\n" ", " | sed "s/,$//")
  echo "| $classname | $(basename $file) | ${extends:--} | ${methods:--} |"
done)

API_EOF'
```

---

## Query Commands

### View Full API
```bash
cat .claude/api.md
```

### Find Specific Class
```bash
grep -A 20 "#### ClassName" .claude/api.md
```

### Find Method in Source
```bash
grep -rn "methodName(" --include="*.js" . | grep -v node_modules
```

### Get Constructor Signature
```bash
grep -A 30 "class ClassName" src/file.js | grep -m1 "constructor("
```

### List All Methods of a Class
```bash
grep -A 200 "class ClassName" src/file.js | grep -E "^\s+(async\s+)?[a-zA-Z_].*\(" | head -20
```

---

## Self-Healing

### When to Regenerate

Regenerate API when:
- New classes/functions added
- Major refactoring done
- API file is >7 days old
- Agent uses wrong method names

### Check if Outdated

```bash
if [ -f .claude/api.md ]; then
  file_age=$(( ($(date +%s) - $(stat -f %m .claude/api.md 2>/dev/null || stat -c %Y .claude/api.md 2>/dev/null)) / 86400 ))
  echo "API file is $file_age days old"
  [ $file_age -gt 7 ] && echo "OUTDATED - regenerate"
else
  echo "MISSING - generate now"
fi
```

### Verify Method Exists
```bash
# Before using any method
grep -rn "methodName" --include="*.js" . | grep -v node_modules | head -3
```

---

## Integration with Other Skills

### With defensive-development

Before using any API:
1. Check `.claude/api.md` for correct method name
2. Grep source for exact signature
3. Find working example in tests
4. Then write code

### With microbrain

```bash
# Save API discovery to memory
sqlite3 .claude/memory.db "INSERT INTO memories (type, subject, content, importance, file_refs) VALUES ('api', 'ClassName.methodName', 'Correct usage: ...', 4, 'src/file.js')"
```

---

## Quick Reference

```
API SKILL QUICK REFERENCE

GENERATE
  Full:    Run generation script above
  Quick:   grep "^export class" --include="*.js" -rn .

QUERY
  View:    cat .claude/api.md
  Class:   grep -A 20 "#### ClassName" .claude/api.md
  Method:  grep -rn "methodName(" --include="*.js" .

VERIFY
  Exists:  grep -rn "class X" . | grep -v node_modules
  Method:  grep -A 50 "class X" file.js | grep "methodName"
  Params:  grep -A 30 "class X" file.js | grep "constructor("

PATTERNS
  Classes:    grep "^export class"
  Functions:  grep "^export function"
  Getters:    grep "^\s*get "
  Setters:    grep "^\s*set "
```
