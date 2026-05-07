#!/usr/bin/env bash
# Build the libpd WASM bundle and the worklet.
#
# Used both by the Nix dev shell (flake.nix's `build-wasm` alias)
# and by the GitHub Pages workflow. Assumes emcc / emcmake / emmake
# / esbuild are on PATH.
set -euo pipefail

cd "$(dirname "$0")/.."

emcmake cmake -B build-wasm \
  -DCMAKE_BUILD_TYPE=Release \
  -DLIBPD_SHARED=OFF \
  "$@"

emmake make -C build-wasm -j"$(nproc 2>/dev/null || sysctl -n hw.ncpu)"

# Bundle stock Pd abstractions from pure-data/extra/ into the wasm FS at
# /extra so patches referencing [output~], [hilbert~], [rev1~], etc. resolve
# the same way they do in a regular Pd install. The C-coded externals in
# extra/ are already linked in via PD_EXTRA_SOURCES; this covers the .pd
# abstractions that aren't.
extra_embed_args=()
for f in pure-data/extra/*.pd; do
  extra_embed_args+=( --embed-file "$f@/extra/$(basename "$f")" )
done

common_emcc_args=(
  webaudio/pd_wasm_stubs.c
  -Lbuild-wasm/libs -lpd
  -Wl,--error-limit=0
  -Wl,--wrap=getbytes,--wrap=resizebytes
  -I libpd_wrapper
  -I pure-data/src
  -D USEAPI_DUMMY=1 -D LIBPD=1 -D PD=1
  "${extra_embed_args[@]}"
  -s 'EXPORTED_FUNCTIONS=["_libpd_init","_libpd_init_audio","_libpd_openfile","_libpd_closefile","_libpd_process_float","_libpd_add_to_search_path","_libpd_clear_search_path","_libpd_start_message","_libpd_add_float","_libpd_add_symbol","_libpd_finish_message","_libpd_bang","_libpd_float","_libpd_bind","_libpd_unbind","_libpd_set_printhook","_libpd_set_floathook","_libpd_set_verbose","_libpd_blocksize","_malloc","_free"]'
  -s 'EXPORTED_RUNTIME_METHODS=["cwrap","ccall","addFunction","UTF8ToString","stringToUTF8","FS","HEAPF32","HEAPU8"]'
  -s INITIAL_MEMORY=268435456
  -s MAXIMUM_MEMORY=2147483648
  -s STACK_SIZE=5242880
  -s STACK_OVERFLOW_CHECK=2
  -s ALLOW_MEMORY_GROWTH=1
  -s ALLOW_TABLE_GROWTH=1
  -s MODULARIZE=1
  -s EXPORT_ES6=1
  -s EXPORT_NAME=LibPd
  -s ENVIRONMENT=web,worker
  -s ASSERTIONS=1
  -g2
  -O2
)

emcc "${common_emcc_args[@]}" \
  -o build-wasm/libpd.js

emcc "${common_emcc_args[@]}" \
  -s SINGLE_FILE=1 \
  -o build-wasm/libpd-single.js

esbuild \
  --bundle webaudio/worklet.js \
  --format=iife \
  --log-override:empty-import-meta=silent \
  --outfile=webaudio/libpd-worklet.js
