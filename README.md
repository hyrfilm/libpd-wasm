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

If extra-library submodules are checked out, the build also produces variants with each library statically linked:

| Variant | Sources | Outputs |
| --- | --- | --- |
| `basic`   | libpd + Pd's own `extra/`                          | `build-wasm/libpd{,-single}.js`, `webaudio/libpd-worklet.js`         |
| `cyclone` | basic + `extra-libs/cyclone/` (Max-style objects)  | `build-wasm/libpd-cyclone{,-single}.js`, `webaudio/libpd-worklet-cyclone.js` |
| `else`    | basic + `extra-libs/else/` (porres/else, large)    | `build-wasm/libpd-else{,-single}.js`, `webaudio/libpd-worklet-else.js`       |

The demo picks the worklet bundle per patch — each entry in `webaudio/manifest.json` can carry a `"library": "cyclone" | "else"` field, defaulting to `"basic"` when absent. Switching patches across libraries restarts the audio context (AudioWorklet modules can't be hot-swapped). If a requested bundle isn't deployed (e.g. CI built without `--recurse-submodules`), the demo logs a notice and falls back to basic.

## Extra libraries

### cyclone

[pd-cyclone](https://github.com/porres/pd-cyclone) ships as a submodule under `extra-libs/cyclone`. The build script:

1. Runs cyclone's own CMake (configure step only) to generate `single_lib.c`, the file that declares and calls every `*_setup()` in the library.
2. Compiles cyclone's `.c` files directly into the `libpd-cyclone*` bundles.
3. Defines `CYCLONE_SINGLE_LIBRARY=1` so `cyclone_setup()` invokes `setup_single_lib()`.
4. Embeds `cyclone_objects/abstractions/*.pd` into the wasm filesystem at `/extra/` alongside Pd's own extras.
5. Calls `cyclone_setup()` from the worklet right after `libpd_init()` (gated on the symbol's existence so the basic bundle still boots).

The submodule has 192 top-level C files under `cyclone_objects/binaries/{control,audio}`. The WASM build compiles 190 of them, excluding `coll.c` and `scope_dialog.c`. At runtime, cyclone's generated `setup_single_lib()` currently registers 189 setup functions: 90 control objects and 99 signal objects. `cyclone_setup()` also registers the `[cyclone]` meta object and the non-alphanumeric Max-style aliases.

<details>
<summary>Registered cyclone C objects, direct aliases, and abstractions</summary>

Control setup objects (90):

`accum`, `acos`, `anal`, `asin`, `bangbang`, `borax`, `bucket`, `cartopol`, `counter`, `cosh`, `cycle`, `decide`, `decode`, `flush`, `forward`, `fromsymbol`, `funnel`, `gate`, `histo`, `listfunnel`, `linedrive`, `maximum`, `mean`, `midiflush`, `midiformat`, `midiparse`, `minimum`, `next`, `onebang`, `past`, `peak`, `poltocar`, `sinh`, `spell`, `split`, `spray`, `sprintf`, `sustain`, `switch`, `tanh`, `togedge`, `trough`, `universal`, `unjoin`, `uzi`, `xbendin`, `xbendin2`, `xbendout`, `xbendout2`, `xnotein`, `xnoteout`, `zl`, `acosh`, `asinh`, `atanh`, `atodb`, `dbtoa`, `join`, `pong`, `pak`, `rdiv`, `rminus`, `round`, `scale`, `comment`, `capture`, `mtr`, `tosymbol`, `append`, `clip`, `prepend`, `thresh`, `substitute`, `speedlim`, `match`, `iter`, `buddy`, `bondo`, `pv`, `prob`, `active`, `mousefilter`, `mousestate`, `offer`, `funbuff`, `drunk`, `urn`, `table`, `seq`, `grab`

Signal setup objects (99):

`acos~`, `acosh~`, `allpass~`, `asin~`, `asinh~`, `atan~`, `atan2~`, `atanh~`, `average~`, `avg~`, `change~`, `click~`, `clip~`, `cosh~`, `cosx~`, `count~`, `comb~`, `curve~`, `cycle~`, `delta~`, `deltaclip~`, `edge~`, `line~`, `lores~`, `maximum~`, `minimum~`, `mstosamps~`, `onepole~`, `overdrive~`, `peakamp~`, `phasewrap~`, `pink~`, `pong~`, `pow~`, `rampsmooth~`, `rand~`, `reson~`, `sampstoms~`, `sinh~`, `sinx~`, `slide~`, `snapshot~`, `spike~`, `svf~`, `tanh~`, `tanx~`, `teeth~`, `train~`, `trapezoid~`, `triangle~`, `zerox~`, `atodb~`, `cross~`, `dbtoa~`, `degrade~`, `downsamp~`, `equals~`, `greaterthan~`, `greaterthaneq~`, `lessthan~`, `lessthaneq~`, `modulo~`, `notequals~`, `phaseshift~`, `rdiv~`, `rminus~`, `round~`, `scale~`, `thresh~`, `trunc~`, `frameaccum~`, `framedelta~`, `capture~`, `cartopol~`, `delay~`, `plusequals~`, `minmax~`, `poltocar~`, `matrix~`, `sah~`, `gate~`, `selector~`, `kink~`, `vectral~`, `bitand~`, `bitnot~`, `bitor~`, `bitsafe~`, `bitshift~`, `bitxor~`, `scope~`, `buffir~`, `lookup~`, `index~`, `peek~`, `poke~`, `record~`, `wave~`, `play~`

Additional classes registered directly by `cyclone_setup()`:

`cyclone`, `!-`, `!/`, `==~`, `!=~`, `<~`, `>~`, `<=~`, `>=~`, `!-~`, `!/~`, `%~`, `+=~`

Embedded `.pd` abstractions:

`buffer~`, `number~`

</details>

#### Skipped cyclone objects

Tracked in `scripts/build-wasm.sh` under `cyclone_skip_re` / `cyclone_skip_setups`:

| Object/source | Status | Reason | Could it be revisited? |
| --- | --- | --- | --- |
| `coll` / `control/coll.c` | intentionally skipped | Uses `pthread` mutexes + a save/load worker thread for async file I/O. | Not without enabling `-pthread`, which needs `SharedArrayBuffer` and therefore COOP/COEP cross-origin-isolation headers on every deployment. We've chosen to keep the build header-free, so `coll` stays out. The alternative would be patching cyclone to do file I/O synchronously on the audio thread, which is possible but invasive and would diverge from upstream. |
| `loadmess` / `control/loadmess.c` | not registered | The source is compiled by the current glob, but cyclone's generated `single_lib.c` does not declare or call `loadmess_setup()`, so no `[loadmess]` class is registered in the WASM bundle. | Yes. Either patch the generated `single_lib.c` the same way we remove skipped objects, or adjust the cyclone CMake generation upstream so `loadmess_setup()` is included. |
| `audio/scope_dialog.c` | skipped source, not a Pd object | Tcl/Tk snippet included by `scope.c`, not a standalone translation unit. `[scope~]` itself is built and registered. | No object work needed unless `scope~`'s GUI behavior is expanded. |

If you add an object to the skip list, also add a row here.

#### Build-time hacks worth cleaning up

- `-Wl,--allow-multiple-definition` — cyclone's `shared/control/s_cycloneutf8.c` is a near-copy of pd's `s_utf8.c` with only 3 of ~13 helpers actually prefixed with `cyclone_`. The rest collide with libpd's symbols. Bodies are byte-identical, so the linker flag is safe; the proper fix is upstreaming a PR that either prefixes the remaining helpers or has cyclone include libpd's `s_utf8.h` directly.
- `-DSHARED_HIOFFSET=1 -DSHARED_LOWOFFSET=0` — cyclone's `shared.h` has explicit endian branches for linux/win/apple/irix only. wasm32 is little-endian, so we predefine the offsets. Could be upstreamed as another `#elif defined(__EMSCRIPTEN__)` branch.
- Generated `single_lib.c` is post-processed with `sed` to drop calls for skipped classes — fine for now, would be cleaner if cyclone's CMake supported a class exclusion list.

#### Boot spam

Cyclone prints its banner, "Cyclone Browser plug-in installed" notice, and a deprecation warning per legacy class on every load. None of this means anything broke; it's the same output cyclone produces in stock Pd. We may want to call `libpd_set_verbose(0)` before `cyclone_setup()` if it gets in the way.

### ELSE

[porres/pd-else](https://github.com/porres/pd-else) is a submodule at `extra-libs/else/` pinned to `v.1.0-rc14`. The build script:

1. Walks `Source/{Audio,Control,Extra/Aliases}/*.c`, applies the skip-list, and generates `build-wasm/else-cfg/else_lib.c` — a small TU that declares each object's setup symbol and calls them all from `libpd_else_setup()`. ELSE doesn't ship a single-library build mode like cyclone does, so we synthesize the registration list ourselves. The generator handles both naming conventions ELSE uses side-by-side: legacy `<name>_setup` (e.g. `above_tilde_setup`) and newer `setup_<munged>` where `~`→`_tilde`, `.`→`0x2e` (e.g. `setup_bl0x2eimp2_tilde`).
2. Compiles every non-skipped external plus `Source/Shared/*.c` (top-level only — the bundled-dep subtrees are excluded).
3. Embeds `Abstractions/{Audio,Control,Extra}/*.pd` into `/extra/` alongside Pd's own.
4. Defines `libpd_else_setup()` as the registration entrypoint, exported and called by `webaudio/worklet.js` after `libpd_init()`.

The top-level ELSE external scan covers 327 C files. The WASM build registers 317 of them: 205 audio objects, 105 control objects, and 7 alias objects. It also embeds all 261 `.pd` abstractions from `Abstractions/{Audio,Control,Extra}` into `/extra/`.

<details>
<summary>Registered ELSE C externals</summary>

Audio objects (205):

`above~`, `add~`, `adsr~`, `allpass.2nd~`, `allpass.rev~`, `asr~`, `autofade.mc~`, `autofade2.mc~`, `autofade2~`, `autofade~`, `balance~`, `bandpass~`, `bandstop~`, `biquads~`, `bitnormal~`, `bl.imp2~`, `bl.imp~`, `bl.saw2~`, `bl.saw~`, `bl.square~`, `bl.tri~`, `bl.vsaw~`, `blocksize~`, `brown~`, `car2pol~`, `ceil~`, `cents2ratio~`, `chance~`, `changed2~`, `changed~`, `comb.filt~`, `comb.rev~`, `cosine~`, `crackle~`, `crossover~`, `cusp~`, `db2lin~`, `dbgain~`, `decay~`, `del.in~`, `del.out~`, `delace~`, `detect~`, `downsample~`, `drive~`, `dust2~`, `dust~`, `envgen~`, `eq~`, `fader~`, `fbdelay~`, `fbsine2~`, `fbsine~`, `fdn.rev~`, `ffdelay~`, `filterdelay~`, `floor~`, `fm~`, `fold~`, `follow~`, `freq.shift~`, `function~`, `gate2imp~`, `gatedelay~`, `gaussian~`, `gbman~`, `gendyn~`, `get~`, `giga.rev~`, `glide2~`, `glide~`, `gray~`, `group~`, `henon~`, `highpass~`, `highshelf~`, `ikeda~`, `impseq~`, `impulse2~`, `impulse~`, `lace~`, `lag2~`, `lag~`, `lastvalue~`, `latoocarfian~`, `lfnoise~`, `lin2db~`, `lincong~`, `logistic~`, `lop2~`, `lorenz~`, `lowpass~`, `lowshelf~`, `match~`, `median~`, `merge~`, `mix~`, `mov.avg~`, `mov.rms~`, `mtx.mc~`, `mtx~`, `nchs~`, `numbox~`, `nyquist~`, `op~`, `pan.mc~`, `pan.stereo~`, `pan2~`, `pan4~`, `pan~`, `parabolic~`, `peak~`, `phaseseq~`, `pick~`, `pimpmul~`, `pimp~`, `pink~`, `pluck~`, `pm2~`, `pm4~`, `pm6~`, `pm~`, `pol2car~`, `power~`, `pulsecount~`, `pulsediv~`, `pulse~`, `quad~`, `quantizer~`, `rampnoise~`, `ramp~`, `rand.f~`, `rand.i~`, `randpulse2~`, `randpulse~`, `range~`, `ratio2cents~`, `repeat~`, `rescale~`, `resonant~`, `resonator2~`, `resonator~`, `rint~`, `rms~`, `rotate.mc~`, `rotate~`, `saw2~`, `saw~`, `schmitt~`, `scope~`, `select~`, `sequencer~`, `shaper~`, `sh~`, `sig2float~`, `sine~`, `sin~`, `slew2~`, `slew~`, `slice~`, `smooth2~`, `smooth~`, `spread.mc~`, `spread~`, `square~`, `sr~`, `standard~`, `status~`, `stepnoise~`, `sum~`, `susloop~`, `svfilter~`, `tabplayer~`, `tabreader~`, `tabwriter~`, `tanh~`, `tempo~`, `timed.gate~`, `toggleff~`, `trig.delay~`, `trighold~`, `tri~`, `trunc~`, `unmerge~`, `velvet~`, `vsaw~`, `vu~`, `wavetable~`, `white~`, `width~`, `wrap2~`, `wt2d~`, `xfade.mc~`, `xfade~`, `xgate.mc~`, `xgate2.mc~`, `xgate2~`, `xgate~`, `xmod2~`, `xmod~`, `xselect.mc~`, `xselect2.mc~`, `xselect2~`, `xselect~`, `zerocross~`

Control objects (105):

`args`, `bend.in`, `bend.out`, `bicoeff`, `bicoeff2`, `break`, `buffer`, `button`, `canvas.active`, `canvas.bounds`, `canvas.edit`, `canvas.gop`, `canvas.mouse`, `canvas.name`, `canvas.pos`, `canvas.setname`, `canvas.vis`, `canvas.zoom`, `ceil`, `cents2ratio`, `chance`, `changed`, `click`, `colors`, `ctl.in`, `ctl.out`, `datetime`, `default`, `delace`, `dollsym`, `factor`, `float2bits`, `floor`, `fold`, `fontsize`, `format`, `function`, `gcd`, `hot`, `hz2rad`, `initmess`, `keyboard`, `keycode`, `knob`, `lace`, `limit`, `loadbanger`, `loop`, `merge`, `message`, `messbox`, `metronome`, `midi`, `mouse`, `mpe.in`, `note`, `note.in`, `note.out`, `noteinfo`, `openfile`, `order`, `osc.route`, `pack2`, `pad`, `panic`, `pgm.in`, `pgm.out`, `pic`, `pipe2`, `popmenu`, `properties`, `ptouch.in`, `ptouch.out`, `quantizer`, `rad2hz`, `rand.f`, `rand.hist`, `rand.i`, `rand.u`, `ratio2cents`, `rec`, `receiver`, `rescale`, `retrieve`, `rint`, `route2`, `routeall`, `router`, `routetype`, `selector`, `sender`, `separate`, `slice`, `sort`, `spread`, `suspedal`, `symbol2any`, `tabreader`, `touch.in`, `touch.out`, `trunc`, `unmerge`, `var`, `voices`, `wrap2`

Alias objects (7):

`del~`, `imp2~`, `imp~`, `lb`, `s2f~`, `trig.delay2~`, `wt~`

</details>

<details>
<summary>Embedded ELSE abstractions</summary>

Embedded `.pd` abstractions (261 total: 92 audio, 144 control, 25 extra):

`above`, `abs.pd~`, `add`, `allpass.filt~`, `allpass_unit`, `amean`, `any2symbol`, `arp`, `arpeggiator`, `autotune`, `autotune2`, `avg`, `bangdiv`, `batch.rec~`, `batch.write~`, `bin.shift~`, `biplot`, `bl.osc~`, `bl.wavetable~`, `blip~`, `bpbank~`, `bpclone`, `bpm`, `brickwall~`, `brown`, `car2pol`, `cents2frac`, `cents2scale`, `chorus~`, `chrono`, `circle`, `clock`, `coeff2pz`, `combine`, `compress~`, `count`, `crusher~`, `crush~`, `damp.osc~`, `db2lin`, `dec2frac`, `dec2hex`, `deg2rad`, `delete`, `dir`, `dispatch`, `display`, `drum.seq`, `drunkard`, `drunkard~`, `duck~`, `e`, `echo.rev~`, `echo_unit`, `envelope~`, `eqdiv`, `equal`, `euclid`, `expand~`, `f2s~`, `flanger~`, `float2imp.unit`, `float2imp~`, `float2sig.unit`, `float2sig~`, `frac.add`, `frac.mul`, `frac2cents`, `frac2dec`, `free.rev~`, `freeze.osc.clone~`, `freeze~`, `freq2midi`, `gain2~`, `gain~`, `gatedelay`, `gatehold`, `gatehold.unit`, `gatehold~`, `gaterelease`, `gaterelease.unit`, `gaterelease~`, `glide`, `glide2`, `gmean`, `grain.live.grain`, `grain.live~`, `grain.sampler.grain`, `grain.sampler~`, `grain.synth.grain`, `grain.synth~`, `gran.player~`, `gran~`, `graph~`, `group`, `hann~`, `hex2dec`, `hip.bw~`, `histogram`, `impulse`, `insert`, `interpolate`, `iterate`, `keymap`, `keypress`, `lastvalue`, `lcm`, `level~`, `lfnoise`, `lfo`, `lin2db`, `list.harm`, `list.inc`, `list.seq`, `lop.bw~`, `mag`, `mag~`, `makenote2`, `markov`, `maxpeak~`, `median`, `meter`, `meter2~`, `meter4~`, `meter8~`, `meter~`, `metronome~`, `midi.clock`, `midi.in`, `midi.learn`, `midi.out`, `midi2freq`, `midi2note`, `mix2~`, `mix4~`, `mono`, `mono.rev~`, `mono~`, `morph`, `morph~`, `mov.avg`, `ms.dec~`, `ms.enc~`, `ms2samps`, `ms2samps~`, `mtx.ctl`, `multi.vsl`, `multi.vsl.unit`, `nmess`, `noisegate~`, `nop~`, `norm~`, `note2midi`, `notedur2ratio`, `op`, `osc.receive`, `osc.send`, `oscbank.unit`, `oscbank~`, `oscnoise~`, `out.mc.hip~`, `out.mc~`, `out4~`, `out8~`, `out~`, `pattern`, `perlin~`, `phaser~`, `phasor`, `pi`, `pick`, `pimp`, `ping.pong~`, `pitch.shift~`, `plate.rev~`, `player~`, `pol2car`, `polymetro`, `polymetro~`, `presets`, `presets.send.clone`, `pulse`, `pvoc.freeze~`, `pvoc.live~`, `pvoc.player~`, `pvoc~`, `pz2coeff`, `rad2deg`, `rampnoise`, `rand.dev`, `rand.dist`, `rand.list`, `randpulse`, `randpulse2`, `range`, `range.hsl`, `rec.file~`, `rec2`, `remove`, `replace`, `resonbank.unit`, `resonbank2.unit`, `resonbank2~`, `resonbank~`, `retune`, `revdelay~`, `reverse`, `rm~`, `rotate`, `sample~`, `samps2ms`, `samps2ms~`, `scala`, `scale2cents`, `scale2freq`, `scales`, `schmitt`, `score`, `score2`, `scramble`, `send2~`, `sendmidi`, `sequencer`, `setdsp~`, `slew`, `slew2`, `slider2d`, `smooth`, `smooth2`, `spectrograph~`, `speed`, `stack`, `status`, `stepnoise`, `stereo.rev~`, `store`, `stream`, `stretch.shift~`, `sum`, `superosc.unit`, `superosc~`, `swap2`, `synth.voice.template`, `synth~`, `sysrt.in`, `sysrt.out`, `tabgen`, `tap`, `tempo`, `timed.gate`, `tremolo~`, `trig2bang`, `trig2bang~`, `unite`, `vca2~`, `vca~`, `vibrato~`, `vocoder.band_clone`, `vocoder~`, `voices~`, `zbiplot`

</details>

#### Skipped ELSE objects

| Object | Source | Reason |
| --- | --- | --- |
| `beat~` | `Source/Audio/beat~.c` | depends on bundled `aubio` |
| `conv~` | `Source/Audio/conv~.c` | depends on bundled `kiss_fft` |
| `play.file~` | `Source/Audio/play.file~.c` | depends on ffmpeg/file-decoding code that is not built into the WASM bundle |
| `pdlink~` | `Source/Audio/pdlink~.c` | depends on `libsamplerate`, `opus`, and Ableton Link networking |
| `else` | `Source/Control/else.c` | calls `lua_setup()`; pdlua/Lua is not compiled into the WASM bundle |
| `osc.format` | `Source/Control/osc.format.c` | `Shared/OSC.h` pulls in `<netinet/in.h>` |
| `osc.parse` | `Source/Control/osc.parse.c` | `Shared/OSC.h` pulls in `<netinet/in.h>` |
| `pdlink` | `Source/Control/pdlink.c` | depends on Ableton Link networking |
| `sfinfo` | `Source/Control/sfinfo.c` | depends on ffmpeg |
| `sfload` | `Source/Control/sfload.c` | depends on `pthread.h` background file-loading plus ffmpeg |

The bundled-dep subtrees under `Source/Shared/` are excluded wholesale: `aubio/`, `ffmpeg/`, `kiss_fft/`, `libsamplerate/`, `link/`, `opus/`.

#### Build-time gotchas

- **`sys_putmidibyte`** — ELSE's six MIDI-out objects (`bend.out`, `ctl.out`, `note.out`, `pgm.out`, `ptouch.out`, `touch.out`) call Pd-vanilla's `sys_putmidibyte()` directly. libpd refactored that path into `outmidi_byte()`, which routes through the hook installed by `libpd_set_midibytehook()`. `webaudio/pd_wasm_stubs.c` bridges the old name to the new one so the link succeeds and MIDI bytes still reach the JS hook.
- **`s_elseutf8.c` symbol collisions** — ELSE ships its own copy of Pd's `s_utf8.c` with only `else_u8_wc_nbytes` actually prefixed; the other `u8_*` helpers keep their original names and collide with libpd's `s_utf8.o`. Same workaround as cyclone: `-Wl,--allow-multiple-definition`.
- **Bundle size** — `webaudio/libpd-worklet-else.js` is ~5 MB single-file. That's the cost of statically linking 317 externals. If size matters for deploys, splitting wasm + JS via the non-`-single` build artefacts (`libpd-else.js` + `libpd-else.wasm`) is preferred.

#### Skip-list policy (cyclone + ELSE, identical)

A translation unit is excluded if it `#include`s any of:

`<pthread.h>`, `<sys/socket.h>`, `<arpa/inet.h>`, `<netinet/*>`, `<GL/*>`, `<sndfile.h>`, `<fftw3.h>`, `<samplerate.h>`, `<aubio/aubio.h>`

…or otherwise depends on threads, the host filesystem (beyond Pd's own search-path conventions), OpenGL, or third-party native libraries that aren't built into the wasm. Each skip gets a row in the relevant library's skip table (see cyclone's above) so the rationale is recoverable.

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
