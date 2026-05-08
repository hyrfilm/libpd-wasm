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

# ---------------------------------------------------------------------------
# Optional "full" build: libpd + cyclone (Max compatibility library).
# Run only when the cyclone submodule is checked out — otherwise just skip.
# ---------------------------------------------------------------------------
if [[ -d extra-libs/cyclone/cyclone_objects ]]; then
  echo "→ building libpd-full with cyclone"

  # Cyclone ships a CMakeLists that, with BUILD_SINGLE_LIBRARY=ON, generates
  # cyclone_objects/binaries/single_lib.c with declarations + calls for every
  # `*_setup()` in the library. We use it for that one generated file only —
  # the actual compile is done by emcc directly below.
  cmake -S extra-libs/cyclone -B build-wasm/cyclone-cfg \
    -DBUILD_SINGLE_LIBRARY=ON \
    -DBUILD_SHARED_LIBS=OFF \
    -DPD_INCLUDE_DIR="$(pwd)/pure-data/src" \
    -DPD_LIBRARY=/dev/null \
    -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
    >/dev/null

  # Skip list — objects we know need patches we haven't done yet. Document
  # additions in README.md under "cyclone: skipped objects".
  #   coll.c         — uses pthread mutexes for its async file I/O path.
  #   scope_dialog.c — Tcl/Tk snippet #include'd by scope.c, not a TU.
  cyclone_skip_re='/(coll|scope_dialog)\.c$'
  # Class setups to strip from the generated single_lib.c (must match a
  # subset of the file skip list — only files with `<name>_setup()` in
  # single_lib.c need entries here).
  cyclone_skip_setups=( coll )

  for cls in "${cyclone_skip_setups[@]}"; do
    sed -i.bak \
      -e "/^void ${cls}_setup(/d" \
      -e "/^[[:space:]]*${cls}_setup();/d" \
      build-wasm/cyclone-cfg/cyclone_objects/binaries/single_lib.c
  done
  rm -f build-wasm/cyclone-cfg/cyclone_objects/binaries/single_lib.c.bak

  cyclone_sources=(
    extra-libs/cyclone/cyclone_objects/binaries/cyclone_lib.c
    build-wasm/cyclone-cfg/cyclone_objects/binaries/single_lib.c
  )
  shopt -s nullglob
  for f in extra-libs/cyclone/shared/common/*.c \
           extra-libs/cyclone/shared/control/*.c \
           extra-libs/cyclone/shared/signal/*.c \
           extra-libs/cyclone/cyclone_objects/binaries/control/*.c \
           extra-libs/cyclone/cyclone_objects/binaries/audio/*.c; do
    [[ "$f" =~ $cyclone_skip_re ]] && continue
    cyclone_sources+=( "$f" )
  done
  shopt -u nullglob

  # Embed cyclone abstractions alongside pd's own extras at /extra/.
  cyclone_embed_args=()
  for f in extra-libs/cyclone/cyclone_objects/abstractions/*.pd; do
    cyclone_embed_args+=( --embed-file "$f@/extra/$(basename "$f")" )
  done

  # Cyclone-specific compile args:
  #   -DCYCLONE_SINGLE_LIBRARY=1   makes cyclone_setup() call setup_single_lib()
  #   -I shared                    so #include <common/api.h> resolves
  cyclone_emcc_args=(
    "${cyclone_sources[@]}"
    "${cyclone_embed_args[@]}"
    -I extra-libs/cyclone/shared
    -I extra-libs/cyclone
    -DCYCLONE_SINGLE_LIBRARY=1
    # wasm32 is little-endian. cyclone's shared.h has explicit branches for
    # linux/win/apple/irix only, none of which match emscripten — predefine
    # the offsets for the LE case so audio objects using w_i[] index right.
    -DSHARED_HIOFFSET=1
    -DSHARED_LOWOFFSET=0
    # cyclone ships its own copy of pd's s_utf8.c (renamed s_cycloneutf8.c)
    # with only 3 of the helpers actually prefixed with cyclone_ — the
    # remaining ~10 keep their original names and clash with libpd's copy.
    # The bodies are byte-identical, so let the linker keep the first one.
    -Wl,--allow-multiple-definition
  )

  # Replace the EXPORTED_FUNCTIONS arg to also export _cyclone_setup so the
  # worklet can register cyclone classes after libpd_init.
  full_args=("${common_emcc_args[@]}")
  for i in "${!full_args[@]}"; do
    if [[ "${full_args[$i]}" == EXPORTED_FUNCTIONS=* ]]; then
      full_args[$i]="${full_args[$i]/_libpd_init\"/_libpd_init\",\"_cyclone_setup\"}"
    fi
  done

  emcc "${full_args[@]}" "${cyclone_emcc_args[@]}" \
    -o build-wasm/libpd-full.js

  emcc "${full_args[@]}" "${cyclone_emcc_args[@]}" \
    -s SINGLE_FILE=1 \
    -o build-wasm/libpd-full-single.js
fi

# ---------------------------------------------------------------------------
# Worklet bundle. esbuild's --alias swaps the libpd-impl placeholder import
# for whichever build we want, so worklet.js stays single-source.
# ---------------------------------------------------------------------------
esbuild \
  --bundle webaudio/worklet.js \
  --format=iife \
  --alias:libpd-impl=./build-wasm/libpd-single.js \
  --log-override:empty-import-meta=silent \
  --outfile=webaudio/libpd-worklet.js

if [[ -f build-wasm/libpd-full-single.js ]]; then
  esbuild \
    --bundle webaudio/worklet.js \
    --format=iife \
    --alias:libpd-impl=./build-wasm/libpd-full-single.js \
    --log-override:empty-import-meta=silent \
    --outfile=webaudio/libpd-worklet-full.js
fi
