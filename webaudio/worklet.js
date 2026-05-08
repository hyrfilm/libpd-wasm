// AudioWorkletProcessor that hosts libpd in the audio thread.
//
// Bundled with esbuild into webaudio/libpd-worklet.js. The imported libpd
// module is built with -s SINGLE_FILE=1 so the wasm is embedded as base64.

// Emscripten's runtime sniffs `window` / `WorkerGlobalScope` / `process`
// to decide which environment code path to use. AudioWorkletGlobalScope
// has none of these, so without these shims it falls through to "shell"
// mode — file I/O and memory growth then take broken paths that
// manifest as `getbytes() failed -- out of memory` deep inside libpd.
// Faking WorkerGlobalScope steers the runtime onto the Worker path,
// which is close enough to AudioWorkletGlobalScope for our usage
// (we don't rely on importScripts / postMessage from the runtime,
// because SINGLE_FILE=1 inlines the wasm).
if (typeof self === "undefined") globalThis.self = globalThis;
if (typeof WorkerGlobalScope === "undefined") {
  globalThis.WorkerGlobalScope = function () {};
}

// Resolved by esbuild --alias at bundle time so the same source compiles
// against either build-wasm/libpd-single.js (basic) or libpd-full-single.js
// (with cyclone). See scripts/build-wasm.sh.
import LibPdFactory from "libpd-impl";

const PD_BLOCK = 64;
const QUANTUM  = 128;
const TICKS    = QUANTUM / PD_BLOCK;
const IN_CH    = 0;
const OUT_CH   = 2;
const PATCH_DIR = "/patches";

class LibPdProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ready = false;
    this.lib = null;
    this.processFloat = null;
    this.inPtr = 0;
    this.outPtr = 0;
    this.patchHandle = 0;
    this.bindings = new Map();      // receiver -> libpd binding handle
    this.printBuf = "";
    this.port.onmessage = (e) => this._onMessage(e.data);
    this._boot().catch((err) => {
      this.port.postMessage({ type: "error", message: String(err) });
    });
  }

  async _boot() {
    const lib = await LibPdFactory();
    this.lib = lib;

    // Hooks must be installed before libpd_init (libpd's docs).
    const printhookPtr = lib.addFunction((ptr) => {
      const chunk = lib.UTF8ToString(ptr);
      // pd emits a line at a time, sometimes without a trailing newline.
      this.printBuf += chunk;
      let nl;
      while ((nl = this.printBuf.indexOf("\n")) >= 0) {
        const line = this.printBuf.slice(0, nl);
        this.printBuf = this.printBuf.slice(nl + 1);
        this.port.postMessage({ type: "print", text: line });
      }
    }, "vi");
    lib._libpd_set_printhook(printhookPtr);

    const floathookPtr = lib.addFunction((recvPtr, x) => {
      const receiver = lib.UTF8ToString(recvPtr);
      this.port.postMessage({ type: "recv-float", receiver, value: x });
    }, "vif");
    lib._libpd_set_floathook(floathookPtr);

    lib._libpd_init();
    // Register cyclone classes (Max compatibility lib) when present.
    // Symbol only exists in the libpd-full bundle.
    if (lib._cyclone_setup) lib._cyclone_setup();
    lib._libpd_init_audio(IN_CH, OUT_CH, sampleRate);

    this.inPtr  = IN_CH  ? lib._malloc(QUANTUM * IN_CH  * 4) : 0;
    this.outPtr = lib._malloc(QUANTUM * OUT_CH * 4);
    this.processFloat = lib.cwrap(
      "libpd_process_float", "number",
      ["number", "number", "number"],
    );

    // [; pd dsp 1(
    lib._libpd_start_message(1);
    lib._libpd_add_float(1);
    lib.ccall("libpd_finish_message", "number",
              ["string", "string"], ["pd", "dsp"]);

    this.ready = true;
    this.port.postMessage({ type: "ready" });
  }

  _onMessage(msg) {
    const lib = this.lib;
    if (!lib) return;
    switch (msg.type) {
      case "load": {
        if (this.patchHandle) {
          lib._libpd_closefile(this.patchHandle);
          this.patchHandle = 0;
        }
        for (const handle of this.bindings.values()) lib._libpd_unbind(handle);
        this.bindings.clear();
        lib._libpd_clear_search_path();

        rmrf(lib, PATCH_DIR);
        mkdirp(lib, PATCH_DIR);
        lib.ccall("libpd_add_to_search_path", null, ["string"], [PATCH_DIR]);

        const dirsAdded = new Set([PATCH_DIR]);
        for (const f of msg.files) {
          const fullPath = PATCH_DIR + "/" + f.path;
          const slash = fullPath.lastIndexOf("/");
          const dir = fullPath.slice(0, slash);
          mkdirp(lib, dir);
          if (!dirsAdded.has(dir)) {
            dirsAdded.add(dir);
            lib.ccall("libpd_add_to_search_path", null, ["string"], [dir]);
          }
          try {
            lib.FS.writeFile(fullPath, f.content);
          } catch (e) {
            this.port.postMessage({ type: "error",
              message: "FS.writeFile " + fullPath + ": " + e });
            return;
          }
        }

        // Stock Pd abstractions (output~, hilbert~, rev1~/2~/3~, ...) are
        // embedded into the wasm FS at /extra by build-wasm.sh. Re-add it
        // after each clear so user patches can reference them. Lowest
        // priority — matches Pd's stdpath / 'extra' folder convention.
        lib.ccall("libpd_add_to_search_path", null, ["string"], ["/extra"]);

        const openFull = PATCH_DIR + "/" + msg.openPath;
        const slash = openFull.lastIndexOf("/");
        const openDir = openFull.slice(0, slash);
        const openName = openFull.slice(slash + 1);
        const handle = lib.ccall(
          "libpd_openfile", "number",
          ["string", "string"], [openName, openDir],
        );
        this.patchHandle = handle;
        this.port.postMessage({ type: "patch-opened", ok: handle !== 0 });
        break;
      }
      case "close-patch": {
        if (this.patchHandle) {
          lib._libpd_closefile(this.patchHandle);
          this.patchHandle = 0;
        }
        for (const handle of this.bindings.values()) lib._libpd_unbind(handle);
        this.bindings.clear();
        break;
      }
      case "bind": {
        if (!this.bindings.has(msg.receiver)) {
          const h = lib.ccall("libpd_bind", "number",
                              ["string"], [msg.receiver]);
          if (h) this.bindings.set(msg.receiver, h);
        }
        break;
      }
      case "unbind": {
        const h = this.bindings.get(msg.receiver);
        if (h) {
          lib._libpd_unbind(h);
          this.bindings.delete(msg.receiver);
        }
        break;
      }
      case "bang": {
        lib.ccall("libpd_bang", "number", ["string"], [msg.receiver]);
        break;
      }
      case "float": {
        lib.ccall("libpd_float", "number",
                  ["string", "number"], [msg.receiver, msg.value]);
        break;
      }
    }
  }

  process(_inputs, outputs) {
    if (!this.ready) return true;

    this.processFloat(TICKS, this.inPtr, this.outPtr);

    const out = outputs[0];
    if (!out || out.length === 0) return true;

    const heap = this.lib.HEAPF32;
    const base = this.outPtr >> 2;
    const channels = Math.min(out.length, OUT_CH);
    for (let ch = 0; ch < channels; ch++) {
      const dst = out[ch];
      for (let i = 0; i < QUANTUM; i++) {
        dst[i] = heap[base + i * OUT_CH + ch];
      }
    }
    return true;
  }
}

function mkdirp(lib, path) {
  const parts = path.split("/").filter(Boolean);
  let cur = "";
  for (const p of parts) {
    cur += "/" + p;
    try { lib.FS.mkdir(cur); } catch (_) {}
  }
}

function rmrf(lib, path) {
  let stat;
  try { stat = lib.FS.stat(path); } catch (_) { return; }
  if (lib.FS.isDir(stat.mode)) {
    for (const e of lib.FS.readdir(path)) {
      if (e === "." || e === "..") continue;
      rmrf(lib, path + "/" + e);
    }
    try { lib.FS.rmdir(path); } catch (_) {}
  } else {
    try { lib.FS.unlink(path); } catch (_) {}
  }
}

registerProcessor("libpd", LibPdProcessor);
