#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f extra-libs/else/Source/Control/else.c ]]; then
  echo "skipping: extra-libs/else/Source/Control/else.c is not checked out"
  exit 0
fi

if ! grep -q 'lua_setup' extra-libs/else/Source/Control/else.c; then
  exit 0
fi

if grep -q 'Source/Control/lua/pdlua\.c' scripts/build-wasm.sh; then
  exit 0
fi

if grep -q "else_skip_re=.*else" scripts/build-wasm.sh; then
  exit 0
fi

echo "ELSE's meta object calls lua_setup(), but pdlua is not compiled or skipped" >&2
exit 1
