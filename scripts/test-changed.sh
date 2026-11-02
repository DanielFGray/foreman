#!/bin/bash
# Runs tests only in workspace packages changed since the branch base.
# If root files (outside any package) are changed, runs all package tests.
set -euo pipefail

# Derive workspace packages from package.json workspaces field
# Returns a list of "path:name" pairs for each package
PACKAGES_JSON=$(node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const ws = pkg.workspaces || [];
  const { execSync } = require('child_process');
  let entries = [];
  for (const pattern of ws) {
    try {
      const output = execSync('find ' + pattern + ' -name package.json -type f 2>/dev/null | sed \"s|/package.json$||\"', { encoding: 'utf8' });
      const matches = output.trim().split('\n').filter(Boolean);
      for (const m of matches) {
        const p = JSON.parse(fs.readFileSync(m + '/package.json', 'utf8'));
        entries.push(m + ':' + p.name);
      }
    } catch (e) {
      // find returns non-zero if no matches, ignore
    }
  }
  console.log(entries.join(' '));
")

# Convert to arrays
PACKAGE_PATHS=()
PACKAGE_NAMES=()
read -r -a ENTRIES <<< "$PACKAGES_JSON"
for entry in "${ENTRIES[@]}"; do
  PACKAGE_PATHS+=("${entry%%:*}")
  PACKAGE_NAMES+=("${entry##*:}")
done

if [[ ${#PACKAGE_PATHS[@]} -eq 0 ]]; then
  echo "No workspace packages found, running all tests" >&2
  exec bun run test
fi

# Find base commit: merge-base with develop (trunk)
BASE=$(git merge-base develop HEAD 2>/dev/null || echo "")

if [[ -z "$BASE" ]]; then
  echo "Could not determine base commit (develop not found), running all tests" >&2
  exec bun run test
fi

# Get changed files since base (committed)
CHANGED_FILES=()
while IFS= read -r -d '' file; do
  [[ -n "$file" ]] && CHANGED_FILES+=("$file")
done < <(git diff --name-only -z "$BASE"..HEAD 2>/dev/null)

# Get uncommitted changes (staged and unstaged)
# Use git status --porcelain=v1 and parse correctly to handle renames and quotes
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  # Format: XY PATH (for normal) or XY OLD_PATH -> NEW_PATH (for renames)
  # X = index status, Y = worktree status
  # We want the working tree path (after -> for renames, or the path itself)
  if [[ "$line" == ".. "*" -> "* ]]; then
    # Rename: status + space + oldpath + " -> " + newpath
    newpath="${line##* -> }"
    CHANGED_FILES+=("$newpath")
  elif [[ "$line" == '.. "'*'" -> "'*'"' ]]; then
    # Quoted rename
    rest="${line:4}"
    newpath="${rest##*\" -> \"}"
    newpath="${newpath%\"}"
    CHANGED_FILES+=("$newpath")
  elif [[ "$line" == '.. "'*'"' ]]; then
    # Quoted path
    path="${line:4}"
    path="${path%\"}"
    CHANGED_FILES+=("$path")
  else
    # Normal unquoted path (status + space + path)
    CHANGED_FILES+=("${line:3}")
  fi
done < <(git status --porcelain=v1 2>/dev/null)

# Deduplicate
CHANGED_FILES=($(printf '%s\n' "${CHANGED_FILES[@]}" | sort -u))

if [[ ${#CHANGED_FILES[@]} -eq 0 ]]; then
  echo "No changed files detected, running all tests" >&2
  exec bun run test
fi

# Determine which packages are affected
declare -A AFFECTED_PACKAGE_NAMES=()
ROOT_CHANGED=false

for file in "${CHANGED_FILES[@]}"; do
  # Skip the test-changed.sh script itself
  [[ "$file" == "scripts/test-changed.sh" ]] && continue

  # Check if file is inside a package directory
  FOUND_PACKAGE=false
  for i in "${!PACKAGE_PATHS[@]}"; do
    pkg_path="${PACKAGE_PATHS[i]}"
    pkg_name="${PACKAGE_NAMES[i]}"
    if [[ "$file" == "$pkg_path/"* ]] || [[ "$file" == "$pkg_path" ]]; then
      AFFECTED_PACKAGE_NAMES["$pkg_name"]=1
      FOUND_PACKAGE=true
      break
    fi
  done

  if [[ "$FOUND_PACKAGE" == "false" ]]; then
    # File is outside any package (root file)
    ROOT_CHANGED=true
  fi
done

# If root files changed, run all tests
if [[ "$ROOT_CHANGED" == "true" ]]; then
  echo "Root files changed, running all package tests" >&2
  exec bun run test
fi

# Collect affected package names
AFFECTED=()
for pkg in "${!AFFECTED_PACKAGE_NAMES[@]}"; do
  AFFECTED+=("$pkg")
done

if [[ ${#AFFECTED[@]} -eq 0 ]]; then
  echo "No packages affected by changes, running all tests" >&2
  exec bun run test
fi

echo "Running tests for affected packages: ${AFFECTED[*]}" >&2

# Run tests only in affected packages using bun's --filter
FILTER_ARGS=()
for pkg in "${AFFECTED[@]}"; do
  FILTER_ARGS+=("--filter" "$pkg")
done

exec bun run "${FILTER_ARGS[@]}" test