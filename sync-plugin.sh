#!/bin/bash
# Sync compiled plugin to Obsidian plugins directory.
# Use: ./sync-plugin.sh
#
# Why: this repo (obsidian-pi-agent/) is the source/workspace. The compiled
# output (main.js, styles.css) must also live in the vault's plugin folder
# (.obsidian/plugins/pimate/) for Obsidian to load it. After `npm run build`,
# run this script to copy the fresh artifacts over.
set -e

cd "$(git rev-parse --show-toplevel)"

VAULT_PLUGINS_DIR="$(git rev-parse --show-toplevel)/../.obsidian/plugins/pimate"

if [ ! -d "$VAULT_PLUGINS_DIR" ]; then
  echo "ERROR: vault plugin directory not found: $VAULT_PLUGINS_DIR"
  exit 1
fi

# 1) build (idempotent — uses current sources)
echo "== Building =="
npm run build

# 2) copy artifacts
echo "== Syncing to $VAULT_PLUGINS_DIR =="
cp main.js "$VAULT_PLUGINS_DIR/main.js"
cp styles.css "$VAULT_PLUGINS_DIR/styles.css"

# 3) verify md5 match
SRC_MD5=$(md5sum main.js | awk '{print $1}')
DST_MD5=$(md5sum "$VAULT_PLUGINS_DIR/main.js" | awk '{print $1}')
if [ "$SRC_MD5" != "$DST_MD5" ]; then
  echo "ERROR: main.js md5 mismatch after copy"
  echo "  source: $SRC_MD5"
  echo "  dest:   $DST_MD5"
  exit 1
fi

echo "== Done. Restart Obsidian (or toggle Pimate) to pick up changes. =="
