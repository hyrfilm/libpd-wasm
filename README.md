# libpd-wasm

Experimental WebAssembly build of [libpd](https://github.com/libpd/libpd), packaged for browser AudioWorklet use.

[Try it out](https://hyrfilm.github.io/libpd-wasm/)

## What This Is

`libpd-wasm` builds libpd with Emscripten and runs it inside a browser AudioWorklet. The demo loads Pure Data patches from `webaudio/patches/` and uses libpd as part of a Web Audio graph.

This repository is based on libpd and keeps `pure-data` as a submodule.

## Can I Use This Commercially?

Yes. libpd uses the BSD license, which permits use in open source, private, and commercial projects.

The practical obligations are:

- Keep the copyright notice and BSD license text when redistributing source.
- Include the copyright notice, BSD license text, and disclaimer with binary/browser bundle distributions.
- Do not imply that libpd, Pure Data, Miller Puckette, or other contributors endorse your product without permission.

The license does not require you to open source your own application. This is not legal advice; read [LICENSE.txt](LICENSE.txt) for the exact terms.

## Using It

The simplest path is to download the latest GitHub Release and serve the included browser files with your app.

Releases provide two browser assets:

- `libpd-wasm-browser.zip`: split JS/WASM files for custom integration.
- `libpd-wasm-worklet.zip`: self-contained AudioWorklet processor used by the demo.

The browser zip contains:

```text
libpd.js
libpd.wasm
```

The worklet zip contains:

```text
libpd-worklet.js
```

Use `libpd.js` and `libpd.wasm` when you want to integrate libpd into your own browser code. Use `libpd-worklet.js` when you want the prebuilt AudioWorklet processor used by the demo.

If you want to build from source instead:

```sh
git clone --recurse-submodules https://github.com/hyrfilm/libpd-wasm.git
cd libpd-wasm
nix develop
build-wasm
```

The build outputs are:

```text
build-wasm/libpd.js
build-wasm/libpd.wasm
webaudio/libpd-worklet.js
```

If the `extra-libs/cyclone` submodule is checked out, the build also produces a "full" variant with the cyclone library statically linked:

```text
build-wasm/libpd-full.js
build-wasm/libpd-full.wasm
webaudio/libpd-worklet-full.js
```

The demo prefers `libpd-worklet-full.js` and falls back to the basic worklet if the full bundle isn't present, so the basic build still works in environments without the submodule (e.g. CI without `--recurse-submodules`).

## Extra libraries

### cyclone

[pd-cyclone](https://github.com/porres/pd-cyclone) ships as a submodule under `extra-libs/cyclone`. The build script:

1. Runs cyclone's own CMake (configure step only) to generate `single_lib.c`, the file that declares and calls every `*_setup()` in the library.
2. Compiles cyclone's `.c` files directly into the `libpd-full*` bundles.
3. Defines `CYCLONE_SINGLE_LIBRARY=1` so `cyclone_setup()` invokes `setup_single_lib()`.
4. Embeds `cyclone_objects/abstractions/*.pd` into the wasm filesystem at `/extra/` alongside Pd's own extras.
5. Calls `cyclone_setup()` from the worklet right after `libpd_init()` (gated on the symbol's existence so the basic bundle still boots).

Out of ~192 cyclone classes, all but `coll` register at runtime.

#### Skipped cyclone objects

Tracked in `scripts/build-wasm.sh` under `cyclone_skip_re` / `cyclone_skip_setups`:

| Object | Reason | Could it be revisited? |
| --- | --- | --- |
| `coll` | Uses `pthread` mutexes for its async file I/O path. | Probably yes — Emscripten supports `-pthread`. The mutexes guard a save/load worker thread; in-memory FS may make even a no-op stub good enough. Worth trying before treating it as truly hard. |
| `scope_dialog.c` | Tcl/Tk snippet `#include`'d by `scope.c`, not a translation unit. | Not really an object — the file is excluded from compilation but `scope~` itself is still built. |

If you add an object to the skip list, also add a row here.

#### Build-time hacks worth cleaning up

- `-Wl,--allow-multiple-definition` — cyclone's `shared/control/s_cycloneutf8.c` is a near-copy of pd's `s_utf8.c` with only 3 of ~13 helpers actually prefixed with `cyclone_`. The rest collide with libpd's symbols. Bodies are byte-identical, so the linker flag is safe; the proper fix is upstreaming a PR that either prefixes the remaining helpers or has cyclone include libpd's `s_utf8.h` directly.
- `-DSHARED_HIOFFSET=1 -DSHARED_LOWOFFSET=0` — cyclone's `shared.h` has explicit endian branches for linux/win/apple/irix only. wasm32 is little-endian, so we predefine the offsets. Could be upstreamed as another `#elif defined(__EMSCRIPTEN__)` branch.
- Generated `single_lib.c` is post-processed with `sed` to drop calls for skipped classes — fine for now, would be cleaner if cyclone's CMake supported a class exclusion list.

#### Boot spam

Cyclone prints its banner, "Cyclone Browser plug-in installed" notice, and a deprecation warning per legacy class on every load. None of this means anything broke; it's the same output cyclone produces in stock Pd. We may want to call `libpd_set_verbose(0)` before `cyclone_setup()` if it gets in the way.

### ELSE

Not yet integrated. Next iteration.

## Development

Use Nix directly:

```sh
nix develop
```

Or use direnv:

```sh
direnv allow
```

Useful commands:

```sh
build-wasm       # build the browser bundle and demo worklet
build-native     # native debug CMake build for quick iteration
serve            # serve the demo at http://localhost:8000/webaudio/
clean            # remove build directories
```

## License

libpd is distributed under the BSD license. See [LICENSE.txt](LICENSE.txt). The original libpd README is preserved in [docs/libpd-readme.md](docs/libpd-readme.md).
