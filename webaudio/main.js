// libpd-in-the-browser demo. Picks a curated patch from manifest.json,
// rewrites unbound GUI elements so we can drive them from the DOM, and
// pipes audio through a master GainNode whose level the user controls.

const startBtn   = document.getElementById("start");
const stopBtn    = document.getElementById("stop");
const reloadBtn  = document.getElementById("reload");
const patchPicker = document.getElementById("patchPicker");
const patchDesc  = document.getElementById("patchDesc");
const patchEl    = document.getElementById("patch");
const ctrlsEl    = document.getElementById("controls");
const logEl      = document.getElementById("log");
const volume     = document.getElementById("volume");
const volumeVal  = document.getElementById("volumeVal");
const applyBtn   = document.getElementById("apply");

const log = (m) => {
  logEl.textContent += m + "\n";
  logEl.scrollTop = logEl.scrollHeight;
};

let ctx = null;
let node = null;
let gain = null;
let manifest = [];
let currentPatch = null;          // { file, title, description, content }
let loadedLibrary = null;         // which worklet bundle is currently in ctx
const widgetsByRecv = new Map();  // receiver -> { kind, setValue }

// Each variant of the build outputs its own worklet bundle. The currently
// selected patch's `library` field (in manifest.json) decides which one we
// load. Patches that omit the field default to "basic".
const LIBRARY_WORKLETS = {
  basic:   "./libpd-worklet.js",
  cyclone: "./libpd-worklet-cyclone.js",
  else:    "./libpd-worklet-else.js",
};
const patchLibrary = (p) => p?.library || "basic";

let readyResolve, readyReject, readyPromise;

// ---------------------------------------------------------------------------
// .pd parser + in-place rewriter
//
// For every bng / tgl / hsl / vsl / nbx with no SEND or RCV symbol, we
// inject a synthetic RCV symbol so DOM widgets can drive the element.
// Sending a value to that RCV updates the GUI element AND fires its outlet,
// so downstream wiring behaves exactly as if the user had clicked/dragged.
// ---------------------------------------------------------------------------
function parseAndRewrite(patch) {
  const isSym = (s) => s && s !== "empty" && s !== "-";
  // Pd escapes spaces, commas, semicolons in label/symbol fields with a
  // backslash. Strip the escaping for display.
  const unesc = (s) => isSym(s) ? s.replace(/\\(.)/g, "$1") : null;

  const byRecv = new Map();
  const add = (ctrl, fromGui) => {
    const prev = byRecv.get(ctrl.receiver);
    if (prev && (prev._fromGui || !fromGui)) return;
    ctrl._fromGui = fromGui;
    byRecv.set(ctrl.receiver, ctrl);
  };

  let synthCounter = 0;
  const synth = () => `__pdwa_${synthCounter++}`;

  // Split keeping the `;` terminator + trailing whitespace so we can
  // reassemble the file byte-for-byte after editing in place.
  const parts = patch.split(/(;\s*\n?)/);

  for (let i = 0; i < parts.length; i += 2) {
    const body = parts[i];
    const trimmed = body.trim();

    // Two object families:
    //   #X obj X Y <type> ...args    — gui externals (hsl, nbx, bng, tgl)
    //   #X <atomtype> X Y ...args    — atom widgets  (floatatom, ...)
    // Split on whitespace not preceded by `\` so escaped spaces inside
    // labels (e.g. `track3\ level`) survive as one token.
    const t = trimmed.split(/(?<!\\)\s+/);
    let prefixLen, type, a;
    if (trimmed.startsWith("#X obj")) {
      prefixLen = 5; type = t[4]; a = t.slice(5);
    } else if (trimmed.startsWith("#X floatatom")) {
      prefixLen = 2; type = t[1]; a = t.slice(2);
    } else {
      continue;
    }

    let kind = null, recv = null, lbl = null;
    let min = 0, max = 1, init = 0, step = 0.001;
    let mutated = false;

    // iemgui init value lives in different slots depending on which
    // format Pd saved the patch in:
    //   - vanilla modern: position 5 (hsl/vsl/nbx) or 1 (tgl) is the
    //     loadinit *flag*; the saved value is the second-to-last token
    //     before steady/log_height/default_val.
    //   - older / hand-authored: that same position holds the init
    //     value directly; the trailing slot is 0.
    // Prefer the trailing value, but fall back to the legacy slot when
    // it's zero and the legacy slot has something usable.
    const savedVal = (legacyIdx) => {
      const tail = parseFloat(a[a.length - 2]);
      if (tail) return tail;
      const legacy = parseFloat(a[legacyIdx]);
      return Number.isFinite(legacy) ? legacy : 0;
    };

    if (type === "r" || type === "receive") {
      if (isSym(a[0])) { kind = "slider"; recv = a[0]; }
    } else if (type === "hsl" || type === "vsl") {
      // hsl/vsl: [w, h, min, max, log, init, SEND, RCV, LBL, ..., val, steady]
      min  = parseFloat(a[2]);
      max  = parseFloat(a[3]);
      init = savedVal(5);
      step = (max - min) / 200 || 0.001;
      kind = "slider";
      lbl = unesc(a[8]);
      if (isSym(a[7]))      recv = a[7];
      else if (isSym(a[6])) recv = a[6];
      else if (isFinite(min) && isFinite(max)) {
        recv = synth(); a[7] = recv; mutated = true;
      }
    } else if (type === "nbx") {
      // nbx: [w, h, min, max, log, init, SEND, RCV, LBL, ...]
      min  = parseFloat(a[2]);
      max  = parseFloat(a[3]);
      init = savedVal(5);
      kind = "number";
      lbl = unesc(a[8]);
      if (isSym(a[7]))      recv = a[7];
      else if (isSym(a[6])) recv = a[6];
      else { recv = synth(); a[7] = recv; mutated = true; }
    } else if (type === "bng") {
      // bng: [size, hold, interrupt, init, SEND, RCV, LBL, ...]
      kind = "bang";
      lbl = unesc(a[6]);
      if (isSym(a[5]))      recv = a[5];
      else if (isSym(a[4])) recv = a[4];
      else { recv = synth(); a[5] = recv; mutated = true; }
    } else if (type === "tgl") {
      // tgl: [size, init, SEND, RCV, LBL, ...]
      init = savedVal(1) ? 1 : 0;
      kind = "toggle";
      lbl = unesc(a[4]);
      if (isSym(a[3]))      recv = a[3];
      else if (isSym(a[2])) recv = a[2];
      else { recv = synth(); a[3] = recv; mutated = true; }
    } else if (type === "floatatom") {
      // floatatom: [X, Y, W, LOW, HIGH, LABEL_POS, LABEL, RCV, SEND, ...]
      // Note: RCV is *before* SEND here, opposite of hsl/nbx. 0/0 limits
      // means "no limits" by Pd convention.
      const lo = parseFloat(a[3]);
      const hi = parseFloat(a[4]);
      const noLimits = (lo === 0 && hi === 0);
      min  = noLimits ? -Infinity : lo;
      max  = noLimits ?  Infinity : hi;
      kind = "number";
      lbl = unesc(a[6]);
      if (isSym(a[7]))      recv = a[7];
      else if (isSym(a[8])) recv = a[8];
      else { recv = synth(); a[7] = recv; mutated = true; }
    }

    if (mutated) {
      const leading  = body.match(/^\s*/)[0];
      const trailing = body.match(/\s*$/)[0];
      parts[i] = leading + t.slice(0, prefixLen).join(" ") + " " + a.join(" ") + trailing;
    }

    if (kind && recv) {
      add({
        kind, receiver: recv, label: lbl,
        min: isFinite(min) ? min : -Infinity,
        max: isFinite(max) ? max : Infinity,
        init: isFinite(init) ? init : 0,
        step,
      }, type !== "r" && type !== "receive");
    }
  }

  return { text: parts.join(""), controls: Array.from(byRecv.values()) };
}

// ---------------------------------------------------------------------------
// DOM widgets
// ---------------------------------------------------------------------------
function renderControls(controls) {
  ctrlsEl.innerHTML = "";
  for (const recv of widgetsByRecv.keys()) {
    node?.port.postMessage({ type: "unbind", receiver: recv });
  }
  widgetsByRecv.clear();

  if (controls.length === 0) {
    ctrlsEl.innerHTML = "<em>No controls exposed by this patch.</em>";
    return;
  }
  // Manifest defaults override the patch's saved init value. Match by RCV
  // first (stable, recommended) and fall back to label so patches that only
  // label their controls still work.
  const defaults = currentPatch?.defaults || {};
  const lookupDefault = (c) => {
    if (c.receiver in defaults) return defaults[c.receiver];
    if (c.label && c.label in defaults) return defaults[c.label];
    return undefined;
  };
  for (const c of controls) {
    const override = lookupDefault(c);
    if (override !== undefined) c.init = override;
    const row = document.createElement("div");
    row.className = "ctrl";

    const label = document.createElement("label");
    // Prefer the patch's own label (the visible text Pd shows next to the
    // widget). Fall back to the receiver name, or "(unnamed kind)" when
    // we synthesized the receiver. Receiver name still goes on the title
    // attribute so it's visible on hover for debugging.
    label.textContent = c.label
      ? c.label
      : (c.receiver.startsWith("__pdwa_")
          ? `(unnamed ${c.kind})`
          : c.receiver);
    label.title = c.receiver;
    row.appendChild(label);

    let setValue = () => {};

    if (c.kind === "slider") {
      const input = document.createElement("input");
      input.type = "range";
      input.min = c.min; input.max = c.max; input.step = c.step;
      input.value = c.init;
      const val = document.createElement("span");
      val.className = "val";
      val.textContent = formatVal(c.init);
      input.addEventListener("input", () => {
        val.textContent = formatVal(input.value);
        sendFloat(c.receiver, parseFloat(input.value));
      });
      setValue = (v) => {
        input.value = v;
        val.textContent = formatVal(v);
      };
      row.appendChild(input);
      row.appendChild(val);
    } else if (c.kind === "number") {
      const input = document.createElement("input");
      input.type = "number";
      if (isFinite(c.min)) input.min = c.min;
      if (isFinite(c.max)) input.max = c.max;
      input.value = c.init;
      input.addEventListener("change", () => sendFloat(c.receiver, parseFloat(input.value)));
      setValue = (v) => { input.value = v; };
      row.appendChild(input);
      row.appendChild(document.createElement("span"));
    } else if (c.kind === "bang") {
      const btn = document.createElement("button");
      btn.textContent = "bang";
      btn.addEventListener("click", () => sendBang(c.receiver));
      row.appendChild(btn);
      row.appendChild(document.createElement("span"));
    } else if (c.kind === "toggle") {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!c.init;
      cb.addEventListener("change", () => sendFloat(c.receiver, cb.checked ? 1 : 0));
      setValue = (v) => { cb.checked = !!v; };
      row.appendChild(cb);
      row.appendChild(document.createElement("span"));
    }
    ctrlsEl.appendChild(row);

    widgetsByRecv.set(c.receiver, { kind: c.kind, setValue });
    node?.port.postMessage({ type: "bind", receiver: c.receiver });
    // If a manifest default applies, push it into the patch after the bind
    // is posted (postMessage preserves order, so the float arrives once
    // libpd has registered the binding).
    if (override !== undefined && c.kind !== "bang") {
      sendFloat(c.receiver, override);
    }
  }
  setControlsLocked(!node);
}

// Until the user hits Start, sendFloat/sendBang silently no-op (node is
// null). Disable the inputs so dragging a slider before audio starts
// can't desync the UI from libpd's actual state.
function setControlsLocked(locked) {
  ctrlsEl.classList.toggle("locked", locked);
  for (const el of ctrlsEl.querySelectorAll("input, button")) {
    el.disabled = locked;
  }
}

function formatVal(v) {
  const n = parseFloat(v);
  if (!isFinite(n)) return String(v);
  if (Math.abs(n) >= 100) return n.toFixed(0);
  if (Math.abs(n) >= 1)   return n.toFixed(2);
  return n.toFixed(3);
}

function sendFloat(receiver, value) {
  node?.port.postMessage({ type: "float", receiver, value });
}
function sendBang(receiver) {
  node?.port.postMessage({ type: "bang", receiver });
}

// ---------------------------------------------------------------------------
// Worklet plumbing
// ---------------------------------------------------------------------------
function onWorkletMessage(data) {
  switch (data.type) {
    case "ready":         readyResolve?.(); break;
    case "error":         readyReject?.(new Error(data.message));
                          log("error: " + data.message); break;
    case "print":         log("pd: " + data.text); break;
    case "patch-opened":  log(data.ok ? "patch opened" : "patch open FAILED"); break;
    case "recv-float": {
      const w = widgetsByRecv.get(data.receiver);
      if (w) w.setValue(data.value);
      break;
    }
    default: log("worklet: " + JSON.stringify(data));
  }
}

async function start() {
  startBtn.disabled = true;

  if (!currentPatch && manifest.length) {
    await selectPatch(manifest[0]);
  }
  if (!currentPatch) {
    log("no patch selected");
    startBtn.disabled = false;
    return;
  }

  ctx = new AudioContext();
  log(`AudioContext sampleRate=${ctx.sampleRate}`);

  readyPromise = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });

  // Pick the worklet that matches the selected patch's library. Fall back
  // to basic if the requested bundle isn't deployed (e.g. ELSE submodule
  // missing in CI), and record which one actually loaded.
  const wantLibrary = patchLibrary(currentPatch);
  const wantUrl = LIBRARY_WORKLETS[wantLibrary] || LIBRARY_WORKLETS.basic;
  try {
    await ctx.audioWorklet.addModule(wantUrl);
    loadedLibrary = wantLibrary;
  } catch {
    if (wantLibrary !== "basic") {
      log(`worklet for "${wantLibrary}" not available — falling back to basic`);
      await ctx.audioWorklet.addModule(LIBRARY_WORKLETS.basic);
      loadedLibrary = "basic";
    } else {
      throw new Error("basic worklet bundle missing");
    }
  }
  log(`worklet module loaded (${loadedLibrary})`);

  node = new AudioWorkletNode(ctx, "libpd", { outputChannelCount: [2] });
  node.port.onmessage = (e) => onWorkletMessage(e.data);

  gain = ctx.createGain();
  gain.gain.value = parseFloat(volume.value);
  node.connect(gain);
  gain.connect(ctx.destination);

  await readyPromise;
  loadCurrentPatch();
  setControlsLocked(false);

  stopBtn.disabled  = false;
  reloadBtn.disabled = false;
}

function stop() {
  node?.disconnect();
  gain?.disconnect();
  ctx?.close();
  node = null;
  gain = null;
  ctx = null;
  loadedLibrary = null;
  setControlsLocked(true);
  startBtn.disabled = false;
  stopBtn.disabled  = true;
  reloadBtn.disabled = true;
}

function loadCurrentPatch() {
  if (!node || !currentPatch) return;
  const { text, controls } = parseAndRewrite(currentPatch.content);
  patchEl.value = text;
  log(`loading ${currentPatch.title || currentPatch.file}`);
  node.port.postMessage({
    type: "load",
    files: [{ path: "patch.pd", content: text }],
    openPath: "patch.pd",
  });
  renderControls(controls);
}

// ---------------------------------------------------------------------------
// Manifest + patch selection
// ---------------------------------------------------------------------------
async function selectPatch(meta) {
  const text = await fetch("./" + meta.file).then((r) => r.text());
  currentPatch = { ...meta, content: text };
  patchEl.value = text;
  patchDesc.textContent = meta.description || "";
  // Show the controls preview before audio starts so users can see what
  // they'll be able to drive once they hit Start.
  const { controls } = parseAndRewrite(text);
  renderControls(controls);
}

async function init() {
  try {
    manifest = await fetch("./manifest.json").then((r) => r.json());
  } catch (e) {
    log("failed to load manifest.json: " + e);
    return;
  }
  for (const p of manifest) {
    const opt = document.createElement("option");
    opt.value = p.file;
    opt.textContent = p.category ? `${p.category} — ${p.title}` : p.title;
    patchPicker.appendChild(opt);
  }
  if (manifest.length) {
    patchPicker.value = manifest[0].file;
    await selectPatch(manifest[0]);
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
startBtn.addEventListener("click", () => start().catch((e) => {
  log("error: " + e.message);
  startBtn.disabled = false;
}));
stopBtn.addEventListener("click", stop);

patchPicker.addEventListener("change", async () => {
  const meta = manifest.find((p) => p.file === patchPicker.value);
  if (!meta) return;
  await selectPatch(meta);
  if (node) {
    // If the new patch requires a different library bundle than the one
    // already running in the audio context, we have to tear down and
    // re-init — AudioWorklet modules can't be hot-swapped.
    if (patchLibrary(meta) !== loadedLibrary) {
      log(`library switch: ${loadedLibrary} → ${patchLibrary(meta)} (restarting audio)`);
      stop();
      await start();
    } else {
      loadCurrentPatch();
    }
  }
});

reloadBtn.addEventListener("click", () => {
  if (currentPatch) currentPatch.content = patchEl.value;
  loadCurrentPatch();
});

applyBtn.addEventListener("click", () => {
  if (!currentPatch) {
    currentPatch = { file: "edit.pd", title: "edit.pd", description: "(edited)", content: patchEl.value };
  } else {
    currentPatch.content = patchEl.value;
  }
  if (node) loadCurrentPatch();
  else {
    const { controls } = parseAndRewrite(patchEl.value);
    renderControls(controls);
  }
});

volume.addEventListener("input", () => {
  const v = parseFloat(volume.value);
  volumeVal.textContent = v.toFixed(2);
  if (gain) gain.gain.value = v;
});

// Drag-and-drop a .pd file onto the textarea.
patchEl.addEventListener("dragover", (e) => { e.preventDefault(); patchEl.classList.add("dropping"); });
patchEl.addEventListener("dragleave", () => patchEl.classList.remove("dropping"));
patchEl.addEventListener("drop", async (e) => {
  e.preventDefault();
  patchEl.classList.remove("dropping");
  const file = e.dataTransfer.files[0];
  if (!file) return;
  const text = await file.text();
  patchEl.value = text;
  currentPatch = { file: file.name, title: file.name, description: "(dropped) " + file.name, content: text };
  patchDesc.textContent = currentPatch.description;
  if (node) loadCurrentPatch();
  else {
    const { controls } = parseAndRewrite(text);
    renderControls(controls);
  }
});

init();
