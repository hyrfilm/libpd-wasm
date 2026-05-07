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
const widgetsByRecv = new Map();  // receiver -> { kind, setValue }

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
    if (!trimmed.startsWith("#X obj")) continue;
    const t = trimmed.split(/\s+/);
    const type = t[4];
    const a = t.slice(5);

    let kind = null, recv = null, min = 0, max = 1, init = 0, step = 0.001;
    let mutated = false;

    // iemgui init value lives in different slots depending on which
    // format Pd saved the patch in:
    //   - vanilla modern: position 5 (hsl/vsl/nbx) or 1 (tgl) is the
    //     loadinit *flag*; the saved value is the second-to-last token
    //     before steady/log_height/default_val.
    //   - older / hand-authored: that same position holds the init
    //     value directly; the trailing slot is 0.
    // Prefer the trailing value, but fall back to the legacy slot when
    // it's zero and the legacy slot has something usable. Trailing
    // fields are plain numbers, so a[len - 2] is safe even when labels
    // contain escaped spaces that shift earlier indices under /\s+/.
    const savedVal = (legacyIdx) => {
      const tail = parseFloat(a[a.length - 2]);
      if (tail) return tail;
      const legacy = parseFloat(a[legacyIdx]);
      return Number.isFinite(legacy) ? legacy : 0;
    };

    if (type === "r" || type === "receive") {
      if (isSym(a[0])) { kind = "slider"; recv = a[0]; }
    } else if (type === "hsl" || type === "vsl") {
      // hsl/vsl: [w, h, min, max, log, init, SEND, RCV, lbl, ..., val, steady]
      min  = parseFloat(a[2]);
      max  = parseFloat(a[3]);
      init = savedVal(5);
      step = (max - min) / 200 || 0.001;
      kind = "slider";
      if (isSym(a[7]))      recv = a[7];
      else if (isSym(a[6])) recv = a[6];
      else if (isFinite(min) && isFinite(max)) {
        recv = synth(); a[7] = recv; mutated = true;
      }
    } else if (type === "nbx") {
      min  = parseFloat(a[2]);
      max  = parseFloat(a[3]);
      init = savedVal(5);
      kind = "number";
      if (isSym(a[7]))      recv = a[7];
      else if (isSym(a[6])) recv = a[6];
      else { recv = synth(); a[7] = recv; mutated = true; }
    } else if (type === "bng") {
      kind = "bang";
      if (isSym(a[5]))      recv = a[5];
      else if (isSym(a[4])) recv = a[4];
      else { recv = synth(); a[5] = recv; mutated = true; }
    } else if (type === "tgl") {
      init = savedVal(1) ? 1 : 0;
      kind = "toggle";
      if (isSym(a[3]))      recv = a[3];
      else if (isSym(a[2])) recv = a[2];
      else { recv = synth(); a[3] = recv; mutated = true; }
    }

    if (mutated) {
      const leading  = body.match(/^\s*/)[0];
      const trailing = body.match(/\s*$/)[0];
      parts[i] = leading + t.slice(0, 5).join(" ") + " " + a.join(" ") + trailing;
    }

    if (kind && recv) {
      add({
        kind, receiver: recv,
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
  for (const c of controls) {
    const row = document.createElement("div");
    row.className = "ctrl";

    const label = document.createElement("label");
    // Hide the synthetic prefix for cleaner display while keeping the
    // wire-level receiver name available on hover.
    label.textContent = c.receiver.startsWith("__pdwa_")
      ? `(unnamed ${c.kind})`
      : c.receiver;
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

  await ctx.audioWorklet.addModule("./libpd-worklet.js");
  log("worklet module loaded");

  node = new AudioWorkletNode(ctx, "libpd", { outputChannelCount: [2] });
  node.port.onmessage = (e) => onWorkletMessage(e.data);

  gain = ctx.createGain();
  gain.gain.value = parseFloat(volume.value);
  node.connect(gain);
  gain.connect(ctx.destination);

  await readyPromise;
  loadCurrentPatch();

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
  if (node) loadCurrentPatch();
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
