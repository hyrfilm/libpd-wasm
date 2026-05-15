#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

fail() {
  echo "$1" >&2
  exit 1
}

grep -q 'name="viewport"' webaudio/index.html ||
  fail "webaudio/index.html is missing a mobile viewport meta tag"

grep -q '<details[^>]*id="patchSourcePanel"' webaudio/index.html ||
  fail "patch source editor should live in a named collapsible details panel"

grep -q 'Drop a .pd file' webaudio/index.html ||
  fail "patch source panel should clearly advertise drag-and-drop upload"

grep -q 'function shouldShowPdPrint' webaudio/main.js ||
  fail "main.js should filter noisy Pd setup prints before logging"

grep -q 'sendInitialControlValue' webaudio/main.js ||
  fail "main.js should push initial control values into Pd after patch load"

while IFS= read -r path; do
  [[ ! -e "$path" ]] || fail "stale demo file should not be shipped: $path"
done <<'PATHS'
webaudio/.DS_Store
webaudio/patches/libpd-wasm-demo-4-verb.pd
webaudio/patches/libpd-wasm-demo-4-verb-2.pd
PATHS

manifest_files=$(sed -nE 's/^[[:space:]]*"file": "([^"]+)".*/webaudio\/\1/p' webaudio/manifest.json | sort)
patch_files=$(find webaudio/patches -maxdepth 1 -name '*.pd' -print | sort)

if [[ "$manifest_files" != "$patch_files" ]]; then
  fail "manifest.json and webaudio/patches/*.pd disagree"
fi
