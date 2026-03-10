---
name: project-structure
description: Auto-generates and maintains project structure documentation. Self-healing, auto-installing. Query structure anytime without manual updates.
license: MIT
compatibility: opencode
metadata:
  type: documentation
  output: .claude/structure.md
  scope: all-codebases
---

# Project Structure Skill

## Auto-Installation

**Step 1:** Check if structure file exists:
```bash
test -f .claude/structure.md && echo "exists" || echo "missing"
```

**Step 2:** If "missing" or outdated, generate it using the generation script below.

**Step 3:** Verify:
```bash
head -50 .claude/structure.md
```

**When to auto-install:** First session in project, or when structure seems outdated.

---

## Overview

This skill automatically generates and maintains a `.claude/structure.md` file that documents the project's directory structure, key files, their purposes, and relationships.

**Philosophy:** "Always know where you are" - instant understanding of any codebase.

**Output location:** `.claude/structure.md`

---

## Generate Structure

### Full Generation Command (JavaScript/TypeScript Projects)

```bash
bash -c 'cat > .claude/structure.md << STRUCTURE_EOF
# Project Structure

Generated: $(date +%Y-%m-%d)

---

## Directory Tree with Descriptions

$(find . -type d \
  -not -path "*/\.*" \
  -not -path "./node_modules*" \
  -not -path "./dist*" \
  -not -path "./build*" \
  -not -path "./coverage*" \
  -maxdepth 4 2>/dev/null | sort | while read dir; do
  depth=$(echo "$dir" | tr -cd "/" | wc -c)
  indent=$(printf "%*s" $((depth * 2)) "")
  name=$(basename "$dir")
  
  # Auto-detect purpose based on common patterns
  desc=""
  case "$name" in
    src|lib|core) desc="# Core source code" ;;
    test|tests|__tests__) desc="# Test files" ;;
    docs|documentation) desc="# Documentation" ;;
    components) desc="# UI components" ;;
    utils|helpers) desc="# Utility functions" ;;
    api) desc="# API layer" ;;
    models) desc="# Data models" ;;
    services) desc="# Business logic" ;;
    hooks) desc="# Custom hooks" ;;
    styles|css) desc="# Stylesheets" ;;
    assets|images|static|public) desc="# Static assets" ;;
    config|settings) desc="# Configuration" ;;
    scripts|bin) desc="# Build/utility scripts" ;;
    types|typings) desc="# TypeScript types" ;;
    worker|workers) desc="# Web workers" ;;
    math|algorithms) desc="# Math/algorithms" ;;
    ui|views|pages) desc="# UI layer" ;;
    routes|routing) desc="# Route definitions" ;;
    middleware) desc="# Middleware" ;;
    controllers) desc="# Controllers" ;;
    store|state|redux) desc="# State management" ;;
    examples|demos|samples) desc="# Examples/demos" ;;
    benchmarks|perf) desc="# Performance tests" ;;
    unit|spec) desc="# Unit tests" ;;
    e2e|integration) desc="# Integration tests" ;;
    fixtures|mocks) desc="# Test fixtures" ;;
  esac
  
  if [ "$dir" = "." ]; then
    echo "/ (root)"
  else
    echo "${indent}${name}/ ${desc}"
  fi
done)

---

## Key Files by Category

### Entry Points
$(find . -maxdepth 3 \( -name "index.js" -o -name "index.ts" -o -name "main.js" -o -name "main.ts" \) -type f 2>/dev/null | grep -v node_modules | sort | while read f; do
  exports=$(grep -c "^export" "$f" 2>/dev/null || echo "0")
  echo "$f  (exports: $exports)"
done | head -15)

### Configuration Files
$(find . -maxdepth 2 \( -name "package.json" -o -name "tsconfig.json" -o -name "*.config.js" -o -name "*.config.ts" -o -name ".eslintrc*" -o -name ".prettierrc*" \) -type f 2>/dev/null | grep -v node_modules | sort | head -10)

### Core Classes (by file size - larger = more important)
$(find . -name "*.js" -o -name "*.ts" 2>/dev/null | grep -v node_modules | grep -v dist | xargs wc -l 2>/dev/null | sort -rn | head -15 | awk '{print $2 "  (" $1 " lines)"}')

---

## Module Dependencies

### Internal Imports Graph (top modules)
$(for f in $(find . -name "*.js" -type f 2>/dev/null | grep -v node_modules | grep -v dist | head -30); do
  imports=$(grep -c "^import\|require(" "$f" 2>/dev/null || echo "0")
  if [ "$imports" -gt 3 ]; then
    echo "$f imports $imports modules"
  fi
done | sort -t" " -k3 -rn | head -10)

---

## File Type Distribution

$(find . -type f -not -path "*/\.*" -not -path "./node_modules*" 2>/dev/null | sed "s/.*\.//" | sort | uniq -c | sort -rn | head -10 | awk '{printf "%-6s %s files\n", $2, $1}')

---

## Test Coverage Map

### Test Files
$(find . -path "*/test*" -name "*.js" -o -path "*/__tests__*" -name "*.js" 2>/dev/null | grep -v node_modules | head -15)

### Source-to-Test Mapping
$(for src in $(find . -name "*.js" -path "*/src/*" -o -name "*.js" -path "*/lib/*" 2>/dev/null | grep -v node_modules | head -10); do
  base=$(basename "$src" .js)
  test=$(find . -name "${base}.test.js" -o -name "${base}.spec.js" -o -name "test-${base}.js" 2>/dev/null | grep -v node_modules | head -1)
  if [ -n "$test" ]; then
    echo "$src → $test"
  else
    echo "$src → (no test)"
  fi
done)

---

## Statistics

- Total directories: $(find . -type d -not -path "*/\.*" -not -path "./node_modules*" 2>/dev/null | wc -l | tr -d " ")
- Total source files: $(find . -type f \( -name "*.js" -o -name "*.ts" \) -not -path "*/\.*" -not -path "./node_modules*" 2>/dev/null | wc -l | tr -d " ")
- Total lines of code: $(find . -type f \( -name "*.js" -o -name "*.ts" \) -not -path "*/\.*" -not -path "./node_modules*" 2>/dev/null | xargs wc -l 2>/dev/null | tail -1 | awk "{print \$1}")
- HTML files: $(find . -name "*.html" -not -path "./node_modules*" 2>/dev/null | wc -l | tr -d " ")
- CSS files: $(find . -name "*.css" -not -path "./node_modules*" 2>/dev/null | wc -l | tr -d " ")

STRUCTURE_EOF'
```

---

## Query Commands

### View Full Structure
```bash
cat .claude/structure.md
```

### Find Directory Purpose
```bash
# Check what's in a directory
ls -la path/to/dir/
# Count files by type
find path/to/dir -type f | sed 's/.*\.//' | sort | uniq -c | sort -rn
```

### Find Related Files
```bash
# Find all files related to a feature
grep -rl "FeatureName" --include="*.js" . | grep -v node_modules
```

### Check File Types Distribution
```bash
find . -type f -not -path '*/\.*' -not -path './node_modules*' | sed 's/.*\.//' | sort | uniq -c | sort -rn | head -15
```

---

## Self-Healing

### When to Regenerate

Regenerate structure when:
- New major directories added
- Project reorganization
- Structure file is >7 days old
- Agent seems confused about file locations

### Check if Outdated

```bash
# Check age of structure file
if [ -f .claude/structure.md ]; then
  file_age=$(( ($(date +%s) - $(stat -f %m .claude/structure.md 2>/dev/null || stat -c %Y .claude/structure.md 2>/dev/null)) / 86400 ))
  echo "Structure file is $file_age days old"
  [ $file_age -gt 7 ] && echo "OUTDATED - regenerate"
else
  echo "MISSING - generate now"
fi
```

---

## Quick Reference

```
STRUCTURE SKILL QUICK REFERENCE

GENERATE
  Full:    Run generation command (creates .claude/structure.md)
  Quick:   find . -type d -not -path '*/\.*' | head -30

QUERY
  View:    cat .claude/structure.md
  Dir:     ls -la path/to/dir/
  Types:   find path -type f | sed 's/.*\.//' | sort | uniq -c

CHECK
  Exists:  test -f .claude/structure.md
  Age:     stat -f %m .claude/structure.md (Mac) / stat -c %Y (Linux)

HEAL
  Outdated (>7 days) → Regenerate
  Wrong/incomplete → Regenerate
```
