#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

script_entrypoint=$(
  sed -nE 's/^[[:space:]]*echo "void ([A-Za-z0-9_]+)\(void\) \{".*/\1/p' scripts/build-wasm.sh |
    tail -1
)

if [[ -z "$script_entrypoint" ]]; then
  echo "could not find generated ELSE setup entrypoint in scripts/build-wasm.sh" >&2
  exit 1
fi

if [[ ! -d extra-libs/else/Source ]]; then
  echo "skipping: extra-libs/else/Source is not checked out"
  exit 0
fi

tmpfile=$(mktemp)
trap 'rm -f "$tmpfile"' EXIT

find extra-libs/else/Source/Audio \
     extra-libs/else/Source/Control \
     extra-libs/else/Source/Extra/Aliases \
     -maxdepth 1 -name '*.c' -print0 |
  xargs -0 grep -hE "^(extern[[:space:]]+)?void[[:space:]]+(setup_[a-zA-Z0-9_]+|[a-zA-Z0-9_]+_setup)[[:space:]]*\([[:space:]]*void[[:space:]]*\)" |
  sed -E 's/^(extern[[:space:]]+)?void[[:space:]]+//; s/[[:space:]]*\([[:space:]]*void[[:space:]]*\).*$//' |
  sort -u > "$tmpfile"

if grep -qx "$script_entrypoint" "$tmpfile"; then
  echo "generated ELSE entrypoint '$script_entrypoint' collides with an object setup symbol" >&2
  exit 1
fi
