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

# ---------------------------------------------------------------------------
# Variant build helper.
#
# Each variant produces three artefacts:
#   build-wasm/libpd<suffix>.js           — separate .js + .wasm
#   build-wasm/libpd<suffix>-single.js    — single-file (wasm embedded base64)
#   webaudio/libpd-worklet<wsuffix>.js    — worklet bundle aliased at the above
#
# Variant naming: basic uses no suffix (matches release-asset names); every
# other variant is suffixed with its library name (-cyclone, -else, ...).
#
# Args:
#   $1 = variant name ("basic" | "cyclone" | "else" | ...)
#   $2..$5 = names of bash arrays that hold extra inputs (passed by name so
#            bash can splice them in). For variants with nothing to add (e.g.
#            "basic"), pass empty-array names.
#       $2: sources       — extra .c files
#       $3: embeds        — extra --embed-file args
#       $4: flags         — extra emcc flags (-I, -D, ...)
#       $5: extra_export  — symbol name to splice into EXPORTED_FUNCTIONS, or ""
# ---------------------------------------------------------------------------
bundle_variant() {
  local name=$1
  local -n srcs="$2"
  local -n embeds="$3"
  local -n flags="$4"
  local extra_export=$5

  local suffix=""
  local wsuffix=""
  if [[ "$name" != basic ]]; then
    suffix="-$name"
    wsuffix="-$name"
  fi

  # Splice the variant's setup symbol into EXPORTED_FUNCTIONS if needed.
  local variant_common=("${common_emcc_args[@]}")
  if [[ -n "$extra_export" ]]; then
    for i in "${!variant_common[@]}"; do
      if [[ "${variant_common[$i]}" == EXPORTED_FUNCTIONS=* ]]; then
        variant_common[$i]="${variant_common[$i]/_libpd_init\"/_libpd_init\",\"${extra_export}\"}"
      fi
    done
  fi

  echo "→ building libpd${suffix}"

  emcc "${variant_common[@]}" "${srcs[@]}" "${embeds[@]}" "${flags[@]}" \
    -o "build-wasm/libpd${suffix}.js"

  emcc "${variant_common[@]}" "${srcs[@]}" "${embeds[@]}" "${flags[@]}" \
    -s SINGLE_FILE=1 \
    -o "build-wasm/libpd${suffix}-single.js"

  esbuild \
    --bundle webaudio/worklet.js \
    --format=iife \
    "--alias:libpd-impl=./build-wasm/libpd${suffix}-single.js" \
    --log-override:empty-import-meta=silent \
    "--outfile=webaudio/libpd-worklet${wsuffix}.js"
}

# ---------------------------------------------------------------------------
# basic variant: just libpd + pd's own extras. No extra sources, embeds,
# flags, or exports.
# ---------------------------------------------------------------------------
basic_sources=(); basic_embeds=(); basic_flags=()
bundle_variant basic basic_sources basic_embeds basic_flags ""

# ---------------------------------------------------------------------------
# cyclone variant: libpd + pd-cyclone (Max compatibility library).
# Built only when the submodule is checked out — otherwise skip.
# ---------------------------------------------------------------------------
if [[ -d extra-libs/cyclone/cyclone_objects ]]; then
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
  # additions in README.md under "cyclone: skipped objects". Policy: skip
  # anything that needs pthread, sockets, GL, fftw, sndfile, samplerate, or
  # other heavy deps that wasm doesn't ship.
  #   coll.c         — uses pthread mutexes for its async file I/O path.
  #   scope_dialog.c — Tcl/Tk snippet #include'd by scope.c, not a TU.
  cyclone_skip_re='/(coll|scope_dialog)\.c$'
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
  cyclone_embeds=()
  for f in extra-libs/cyclone/cyclone_objects/abstractions/*.pd; do
    cyclone_embeds+=( --embed-file "$f@/extra/$(basename "$f")" )
  done

  # Cyclone-specific compile args:
  #   -DCYCLONE_SINGLE_LIBRARY=1   makes cyclone_setup() call setup_single_lib()
  #   -I shared                    so #include <common/api.h> resolves
  cyclone_flags=(
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

  bundle_variant cyclone cyclone_sources cyclone_embeds cyclone_flags _cyclone_setup
fi

# ---------------------------------------------------------------------------
# ELSE variant: libpd + pd-else (porres/pd-else, large modern DSP library).
# Submodule lives at extra-libs/else, pinned via .gitmodules.
#
# Skip-list (applied identically to the cyclone policy):
#   Source/Control/sfload.c    — pthread + ffmpeg
#   Source/Control/sfinfo.c    — ffmpeg
#   Source/Audio/play.file~.c  — ffmpeg
#   Source/Audio/pdlink~.c     — libsamplerate + opus + Ableton Link
#   Source/Audio/beat~.c       — aubio
#   Source/Audio/conv~.c       — kiss_fft
#   Source/Control/osc.format.c, osc.parse.c
#                              — Shared/OSC.h pulls in <netinet/in.h>
#   Source/Control/else.c      — calls lua_setup(); pdlua/Lua is not compiled
# The bundled-dep subtrees under Source/Shared/{aubio,ffmpeg,kiss_fft,
# libsamplerate,link,opus}/ are excluded by globbing Source/Shared/*.c
# (top-level only). ELSE doesn't ship <fftw3.h> or <sndfile.h>; it routes
# those through its bundled kiss_fft + its own Source/Shared/elsefile.c.
# ---------------------------------------------------------------------------
if [[ -d extra-libs/else/Source ]]; then
  echo "→ preparing ELSE build"

  # `pdlink~?` matches both pdlink~.c (audio) and pdlink.c (control); both
  # pull in the Ableton Link bundled tree we exclude.
  else_skip_re='/(sfload|sfinfo|pdlink~?|beat~|conv~|play\.file~|osc\.format|osc\.parse|else)\.c$'

  # Walk Audio/, Control/, and Extra/Aliases/ — the externals proper.
  # Skip anything matching the policy. Aliases are real externals with
  # their own setup functions; they need to be registered too.
  else_extern_sources=()
  shopt -s nullglob
  for f in extra-libs/else/Source/Audio/*.c \
           extra-libs/else/Source/Control/*.c \
           extra-libs/else/Source/Extra/Aliases/*.c; do
    [[ "$f" =~ $else_skip_re ]] && continue
    else_extern_sources+=( "$f" )
  done
  shopt -u nullglob

  # Generate else_lib.c. ELSE has no equivalent of cyclone's
  # BUILD_SINGLE_LIBRARY mode, so we synthesize the registration TU
  # ourselves: walk each external, extract its setup symbol, emit an
  # extern + a call inside a wrapper function. ELSE uses two
  # naming conventions side-by-side — the legacy `<name>_setup` and the
  # newer `setup_<munged>` where `~`→`_tilde`, `.`→`0x2e` — so we match
  # either by regex against `^void X(void){`.
  mkdir -p build-wasm/else-cfg
  else_lib=build-wasm/else-cfg/else_lib.c
  : > "$else_lib"
  {
    echo "/* Auto-generated by scripts/build-wasm.sh. */"
    echo "/* Calls every setup function in pd-else for the libpd-else bundle. */"
    echo ""
  } > "$else_lib"

  else_symbols=()
  else_missing=0
  for f in "${else_extern_sources[@]}"; do
    # grep returns 1 when no match — silence it so set -e + pipefail
    # don't kill the build on every file that lacks a setup symbol.
    # Accepts: `void NAME(void)`, `extern void NAME(void)`, with optional
    # whitespace inside the parens (ELSE has `(void )` in a few files).
    sym=$(grep -hE "^(extern[[:space:]]+)?void[[:space:]]+(setup_[a-zA-Z0-9_]+|[a-zA-Z0-9_]+_setup)[[:space:]]*\([[:space:]]*void[[:space:]]*\)" "$f" 2>/dev/null \
          | head -1 \
          | sed -E 's/^(extern[[:space:]]+)?void[[:space:]]+//; s/[[:space:]]*\([[:space:]]*void[[:space:]]*\).*$//' || true)
    if [[ -n "$sym" ]]; then
      else_symbols+=( "$sym" )
      printf 'extern void %s(void); /* %s */\n' "$sym" "$f" >> "$else_lib"
    else
      echo "  warn: no setup symbol in $f" >&2
      else_missing=$((else_missing + 1))
    fi
  done
  {
    echo ""
    echo "extern void post(const char *fmt, ...);"
    echo "void libpd_else_setup(void) {"
    for s in "${else_symbols[@]}"; do
      # Bisection aid: bracket each call with before/after prints so a
      # hang inside the setup function (no "<<" emitted) is distinguishable
      # from a hang afterwards (">>" of next symbol never reached).
      printf '    post(">> %s");\n' "$s"
      printf '    %s();\n' "$s"
      printf '    post("<< %s");\n' "$s"
    done
    echo "}"
  } >> "$else_lib"

  echo "→ generated $else_lib with ${#else_symbols[@]} object setups (${else_missing} files had no detectable symbol)"

  # Source list: generated lib + Shared/ helpers (top-level only, no
  # bundled deps) + every non-skipped external.
  else_sources=( "$else_lib" )
  shopt -s nullglob
  for f in extra-libs/else/Source/Shared/*.c; do
    else_sources+=( "$f" )
  done
  shopt -u nullglob
  else_sources+=( "${else_extern_sources[@]}" )

  # Embed ELSE's abstractions alongside Pd's own extras at /extra/.
  else_embeds=()
  shopt -s nullglob
  for f in extra-libs/else/Abstractions/Audio/*.pd \
           extra-libs/else/Abstractions/Control/*.pd \
           extra-libs/else/Abstractions/Extra/*.pd; do
    else_embeds+=( --embed-file "$f@/extra/$(basename "$f")" )
  done
  shopt -u nullglob

  else_flags=(
    -I extra-libs/else/Source/Shared
    -I extra-libs/else/Source
    # s_elseutf8.c defines u8_* symbols that collide with libpd's s_utf8.c
    # (only `else_u8_wc_nbytes` is actually prefixed; the rest aren't).
    # Bodies are byte-identical, so let the linker keep the first one.
    -Wl,--allow-multiple-definition
  )

  bundle_variant else else_sources else_embeds else_flags _libpd_else_setup
fi
