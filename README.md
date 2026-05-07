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
