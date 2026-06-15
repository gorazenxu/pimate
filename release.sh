#!/bin/bash
# 2-push release workflow. Use: ./release.sh
#
# NOTE: We force C.UTF-8 locale inline because Git for Windows' alias
# shell runs with an empty locale, which makes grep treat the file
# as Latin-1 and silently fail to match the 🛠 emoji in CHANGELOG.
#
# What it does:
#   1. Verifies the working tree is clean AND CHANGELOG Working section is empty.
#   2. Bumps version (npm version patch), commits the version bump.
#   3. Pushes main (1).
#   4. Tags the bump commit and pushes the tag (2).
#
# If you need to amend (CHANGELOG typo, etc.) after step 4:
#   git commit --amend --no-edit
#   git tag -d 1.0.xx
#   git push origin :refs/tags/1.0.xx
#   git tag 1.0.xx
#   git push origin 1.0.xx
set -e

# Make sure we're in the repo root regardless of how the script was invoked
cd "$(git rev-parse --show-toplevel)"

if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: working tree is dirty. Commit/stash first."
  git status --short
  exit 1
fi

# Find the line of the actual `## ... Working / Uncommitted ...` heading
# (line 13 in CHANGELOG, after the preamble bullets).
if ! grep -qE "^## .*Working / Uncommitted" CHANGELOG.md; then
  echo "ERROR: CHANGELOG missing the Working section heading."
  exit 1
fi

# Take everything after the first Working heading and look for a non-empty
# line before the next '## ...' heading. If found, the Working section
# still has un-released items.
WORKING_HAS_ITEMS=$(awk '
  /^## .*Working \/ Uncommitted/ { in_working=1; next }
  in_working && /^## / { exit }
  in_working && NF { print; exit }
' CHANGELOG.md)
if [ -n "$WORKING_HAS_ITEMS" ] && ! echo "$WORKING_HAS_ITEMS" | grep -q "_当前没有未提交的修改"; then
  echo "ERROR: CHANGELOG Working section still has items."
  echo "Move them under a \"## 📦 vX.Y.Z\" heading first."
  echo "First item: $WORKING_HAS_ITEMS"
  exit 1
fi

# Compute the version that will be released (= current version + 1 patch).
# The script's job is to bump and release, so the only thing that matters
# is whether the *next* version's tag already exists.
CUR_VER=$(node -p "require('./package.json').version")
NEXT_VER=$(node -e "
  const [a,b,c] = '$CUR_VER'.split('.').map(Number);
  console.log(\`\${a}.\${b}.\${c+1}\`);
")

if git rev-parse "$NEXT_VER" >/dev/null 2>&1; then
  echo "ERROR: tag $NEXT_VER already exists locally (current package.json is $CUR_VER)."
  echo "Either delete the tag and re-run, or update CHANGELOG with a new section."
  git rev-parse "$NEXT_VER"
  exit 1
fi

VER="$NEXT_VER"

ORIGIN_SHA=$(git rev-parse origin/main 2>/dev/null || echo "no-origin-main")
LOCAL_SHA=$(git rev-parse HEAD)
if [ "$ORIGIN_SHA" != "no-origin-main" ] && [ "$ORIGIN_SHA" != "$LOCAL_SHA" ]; then
  echo "ERROR: origin/main ($ORIGIN_SHA) is not at HEAD ($LOCAL_SHA). Pull/rebase first."
  exit 1
fi

echo "== Releasing v$VER =="
echo "Step 1/3: bump version + commit"
npm version patch --no-git-tag-version
npm run version
git add manifest.json package.json package-lock.json versions.json
git commit -m "Bump to v$VER"

echo "Step 2/3: push main"
git push origin main

echo "Step 3/3: push tag"
git tag "$VER"
git push origin "$VER"

echo "== Done. v$VER published. =="
