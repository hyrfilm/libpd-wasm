Patches for the libpd-wasm webaudio demo
==========================================

These .pd files are loaded by webaudio/main.js. The first entry in
webaudio/manifest.json is the patch shown on page load.

Authoring conventions
---------------------

1. Use [dac~ 1 2] for the master out, NOT [output~].

   The standard Pd 'extra' [output~] abstraction starts with its
   internal volume slider at 0 and gain = volume^4, so it is silent
   until something drives its $0-hsl. The DOM control panel
   (parseAndRewrite in main.js) only exposes top-level iemguis -- it
   does not recurse into subpatches -- so that slider is unreachable.
   The page already has a master volume slider wired through an
   AudioContext gain node, so [dac~ 1 2] is the right choice.

2. Give every iemgui (tgl, hsl, vsl, nbx, bng) a meaningful RCV
   symbol. The receiver name becomes the visible label in the
   control panel. Without one, the parser invents a synthetic
   receiver and the widget shows up as "(unnamed slider)" etc.

3. Set the iemgui's saved value to whatever the patch actually
   starts at. parseAndRewrite reads the saved value to populate
   the DOM widget; if a loadbang chain pushes a different value
   through a direct wire, the DOM and the running patch will
   disagree until the user touches the control.

4. Two iemgui save formats coexist in this directory:

      modern (Pd vanilla):  value lives in the trailing slot
                            (e.g. hsl ... <bg> <fg> <lblcol> VAL STEADY)
      legacy (hand-edited): value lives at position 5/1, trailing
                            slot is 0

   The parser tries the trailing slot first and falls back to the
   legacy slot. Either format works; do not mix them within one
   widget.

Adding a patch
--------------

1. Drop the .pd file into webaudio/patches/.
2. Add an entry to webaudio/manifest.json:

      {
        "file": "patches/your-patch.pd",
        "title": "Short title",
        "category": "Fundamentals" | "Effects" | "Sequencers" | ...,
        "description": "One-sentence pitch of what to listen for.",
        "defaults": { "cutoff": 2000, "resonance": 0.7 }
      }

   The "defaults" block is optional. Each key is matched against the
   control's RCV symbol first, then its label as a fallback. Listed
   values are pushed into the patch on load, so they override whatever
   the iemgui has saved AND whatever loadbang chains broadcast.
   Recommended: give every control a stable RCV symbol and key the
   defaults on that.

3. Reload the demo (the manifest is fetched at page load).

Available externals
-------------------

Stock Pd 'extra' objects are embedded into the wasm FS at /extra by
the build (worklet.js adds /extra to libpd's search path on every
patch load). Confirmed working: bob~, rev1~ / rev2~ / rev3~,
tabosc4~, expr / expr~, vline~, sigmund~, fiddle~, plus the
vanilla core set (osc~, phasor~, *~, +~, line~, sig~, metro,
random, loadbang, array define, ...).
