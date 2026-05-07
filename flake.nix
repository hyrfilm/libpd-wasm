{
  description = "libpd → WASM development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        devShells.default = pkgs.mkShell {
          name = "libpd-wasm";

          packages = with pkgs; [
            # --- WASM toolchain ---
            emscripten          # emcc / em++ / emcmake / emmake
            nodejs_20           # required by emscripten; also for testing output in node
            python3             # emscripten internally needs python

            # --- Native build (for iterating on the stubs without WASM round-trips) ---
            cmake
            gnumake
            clang               # or gcc if you prefer: pkgs.gcc
            pkg-config

            # --- Patch loading / virtual FS tooling ---
            # emcc's --preload-file and --embed-file handle this at link time,
            # but file is useful for inspecting pd patch formats
            file

            # --- JS / AudioWorklet side ---
            esbuild             # bundles the AudioWorklet processor JS
            # optional: bun if you want a faster node alternative
            # bun

            # --- Debugging / inspection ---
            wabt                # wasm2wat, wat2wasm, wasm-validate, wasm-objdump
            binaryen            # wasm-opt (size/speed optimisation after emcc)

            # --- Useful during iteration ---
            jq                  # inspect emcc-generated compile_commands.json
            git
          ];

          # Point emscripten at its own cache so it doesn't try to write
          # into the nix store on first run.
          EM_CACHE = "${placeholder "out"}/em_cache";

          shellHook = ''
            # emscripten needs a writable cache dir; put it in the project root
            export EM_CACHE="$PWD/.em_cache"
            mkdir -p "$EM_CACHE"

            # Confirm toolchain versions on entry
            echo ""
            echo "=== libpd WASM dev shell ==="
            echo "emcc:      $(emcc --version 2>&1 | head -1)"
            echo "node:      $(node --version)"
            echo "cmake:     $(cmake --version | head -1)"
            echo "wasm-opt:  $(wasm-opt --version 2>&1 | head -1)"
            echo "wasm2wat:  $(wasm2wat --version 2>&1 | head -1)"
            echo ""
            echo "Useful aliases loaded:"
            echo "  build-native   → cmake build, no WASM (fast iteration)"
            echo "  build-wasm     → emcmake cmake build"
            echo "  inspect-wasm   → wasm2wat + wasm-validate on last output"
            echo ""

            # --- Convenience aliases ---

            # Native build (no WASM) — useful for checking stubs compile cleanly
            # before doing the full Emscripten round-trip
            build-native() {
              cmake -B build-native \
                -DCMAKE_BUILD_TYPE=Debug \
                -DUSEAPI_DUMMY=1 \
                "$@" \
              && cmake --build build-native -j"$(nproc)"
            }

            # WASM build via emcmake
            build-wasm() {
              emcmake cmake -B build-wasm \
                -DCMAKE_BUILD_TYPE=Release \
                -DUSEAPI_DUMMY=1 \
                -DLIBPD_EXTRA=ON \
                "$@" \
              && emmake make -C build-wasm -j"$(nproc)"
            }

            # Inspect the built WASM (pass the .wasm file path as $1)
            inspect-wasm() {
              local wasm="''${1:-build-wasm/libpd.wasm}"
              echo "--- wasm-validate ---"
              wasm-validate "$wasm" && echo "valid"
              echo ""
              echo "--- wasm-objdump (exports) ---"
              wasm-objdump -x "$wasm" | grep -A 9999 'Export\[' | head -60
            }

            export -f build-native build-wasm inspect-wasm
          '';
        };
      }
    );
}
