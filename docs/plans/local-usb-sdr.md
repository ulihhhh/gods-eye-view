# Local USB SDR layer — design plan

Status: **planning, no code yet.** Nothing in this document describes shipped
behavior — for that, see `docs/CURRENT-STATE.md`, which stays the authoritative
runtime reference and only records verified behavior. This file is a design
record for a feature under development on branch `feature/local-usb-sdr`, kept
under version control (rather than only in a GitHub issue) so the plan stays
reviewable alongside the code that implements it, and gets folded into the
real docs (`docs/CURRENT-STATE.md`, `DATA_SOURCES.md`, `CHANGELOG.md`,
`README.md`) once shipped, per `CONTRIBUTING.md`.

## Goal

Add data layers driven by a **physical USB SDR device** plugged into the
machine running GEV — a real receiver, not a link to someone else's. Two
shapes of that, built in phases:

1. Already-decoded protocol data (aircraft, ships, weather sensors, …) via
   mature local decoder tools.
2. Raw, general-purpose spectrum/waterfall with live tuning, owned directly
   by GEV.

## Not to be confused with PR #279 ("Web Receivers")

[PR #279](https://github.com/bilawalsidhu/gods-eye-view/pull/279) adds a
layer that indexes ~1,850 **internet-hosted** KiwiSDR/WebSDR/OpenWebRX
receivers (from Receiverbook + the community KiwiSDR map feed) and lets you
open/tune them by building a URL to the operator's own web page
(`?f=…`, `?tune=…`, `#freq=…`). It never touches real IQ data, never proxies
audio/control, and needs no hardware. This plan is unrelated hardware-facing
work; the two layers can coexist.

## Target hardware

Nooelec NESDR SMArt v5 — RTL2832U demodulator + R820T2/R860 tuner, 0.5 PPM
TCXO. Mainstream RTL-SDR chipset: supported out of the box by `librtlsdr`
(`rtl_tcp`, `rtl_power`, `rtl_fm`), most single-protocol decoders below, and
SoapySDR, on macOS/Linux/Windows. No custom driver work expected. Not
physically available during initial development — see
[Phasing](#phasing) below for what that blocks vs. doesn't.

## The physical constraint that shapes everything below

One RTL-SDR is **one tuner**: it captures roughly 2.4–3.2 MHz of instantaneous
bandwidth around a single center frequency at a time. It cannot simultaneously
decode, say, 1090 MHz ADS-B and a 433 MHz ISM sensor — those require
retuning, not just more CPU. This bounds "add multiple layers on top":
with one dongle, multiple *layer definitions* can exist, but only one can
hold the tuner (and therefore have live data) at a time — enabling one
should be understood to mean tuning the shared device away from whatever
else was using it, mirroring how enabling one exclusive map style replaces
another. Nooelec explicitly markets the v5's narrow form factor for running
**several side by side** on one host — true simultaneous multi-band coverage
is a real, anticipated use case, just not a v1 requirement, and not solvable
in software alone with a single dongle.

## Two architectural directions, and how they combine

**Direction A — decoded-JSON layers.** Point GEV at a mature local decoder's
already-decoded output: `dump1090`/`readsb` for ADS-B, `rtl_433` for ISM-band
sensors (weather stations, tire-pressure monitors, etc.), an AIS decoder
(`AIS-catcher`/`rtl-ais`) for marine traffic, `acarsdec` for ACARS,
`direwolf` for APRS. Each becomes a thin `/api/local-<protocol>` proxy
polling that tool's own JSON/HTTP output — architecturally identical to the
existing Flights/adsb.lol layer, just pointed at `localhost`. No `rtl_tcp`
client code, no FFT, no new "touches hardware" capability class in GEV
itself — the decoder owns the hardware, GEV just reads its output.

**Direction B — GEV owns the dongle directly.** GEV's own middleware speaks
`rtl_tcp` to the device, runs its own FFT, and exposes a general tunable
spectrum/waterfall — no decoding, but works for anything, not just protocols
someone already wrote a decoder for. This is the "poll it live" approach —
one direct connection, more general, and the nicer end state, but real new
engineering (first child-process/hardware-touching layer in the app).

**These aren't mutually exclusive.** `rtl_tcp` is designed to serve more than
one TCP client reading the same IQ stream from one physical device. Once GEV
owns the dongle via `rtl_tcp` (Direction B's foundation), the same
mature decoders from Direction A can, per-tool support permitting, point at
that shared `rtl_tcp` instance as their IQ *source* instead of opening the
USB device themselves — one physical connection GEV manages, multiple
derived layers riding on it (subject to the one-tuner-one-band constraint
above: a decoder pointed at the shared stream still only sees whatever band
GEV last tuned to). Confirming which decoders actually support a remote
`rtl_tcp` source (vs. requiring direct device ownership) is real spike work,
not assumed — see [Open questions](#open-questions).

## Phasing

### Phase 0 — proof of concept: local ADS-B tap (closes issue #57)

[Issue #57](https://github.com/bilawalsidhu/gods-eye-view/issues/57) ("Local
RTL-SDR / dump1090 receiver tap layer", opened by Tom-Neverwinter, no
comments, no assignee, no linked PR — nothing started on it) asks for exactly
Direction A's simplest case: poll a user's already-running `dump1090`/`readsb`
process (typically `http://localhost:8080/data/aircraft.json`,
tar1090-compatible) and plot those aircraft distinctly from the public
Flights layer. Opt-in, user-configurable base URL.

This is the plan's **Phase 0**, not a separate track: it's the cheapest
possible way to prove GEV can show real SDR-derived data at all, before
committing to the heavier Direction B engineering.

#### Acceptance criteria (verbatim from issue #57's "Scope")

Phase 0 is done when all four hold:

- [ ] User-configurable local receiver base URL (default to the common
      dump1090-fa/readsb default of `http://localhost:8080`).
- [ ] Poll `aircraft.json` (or tar1090-compatible equivalent) on a short
      interval.
- [ ] Plot received aircraft on the globe, visually distinguished from the
      public Flights layer.
- [ ] Off by default (opt-in local-network layer).

Mapped to implementation:

| Criterion | Implementation |
|---|---|
| Configurable base URL, default `http://localhost:8080` | A setting (persisted like other layer options in `layerState.js`) holding the base URL; `/api/local-adsb` proxy reads it per-request rather than hardcoding the host |
| Poll `aircraft.json`/tar1090-compatible on a short interval | `/api/local-adsb` proxy fetches `<baseUrl>/data/aircraft.json`; frontend polls that proxy on the same short cadence the Flights layer already uses for its own public source |
| Visually distinguished from public Flights layer | Separate marker style/color and a distinct layer-state token — never merged into the same entity collection as Flights, so the two are always visually and structurally separable |
| Off by default, opt-in, local-network | Layer starts disabled; enabling it is a user action like any other optional layer. Unlike Phase 1's `LOCAL_SDR_ENABLED` (a build/dev-time gate on spawning a subprocess), this is a runtime per-user toggle — the proxy itself is cheap, keyless, same-origin HTTP, no subprocess, so it doesn't need an env-level kill switch, just the same enabled-by-default:false every optional layer already has |

Concretely, beyond the acceptance criteria:

- `src/data/localAdsb.js` (or similar), same layer interface as everything
  else, polling a `/api/local-adsb` proxy that fetches the configured
  dump1090/readsb JSON URL — no `rtl_tcp`, no FFT, no child process.
- Ships independently, closes #57, and needs **no hardware in hand beyond a
  running dump1090 instance to test against** (dump1090 itself can run
  against a recorded IQ file or `--net` in a no-device mode for local
  testing — verify during implementation).
- What we learn from it feeds the Phase 1/2 decision: how the app's existing
  patterns (poll cadence, degrade/offline states, layer-state registration,
  voice tools) hold up for a *local* rather than *public* source, before
  spending effort on `rtl_tcp`/FFT plumbing.

### Phase 1 — GEV owns the dongle (Direction B foundation)

Build the general spectrum/waterfall layer described in
[Architecture](#architecture-direction-b) below. This is the heavier lift and
where hardware-in-hand matters most (protocol correctness against the actual
dongle, gain/PPM behavior, USB enumeration on the target OS).

### Phase 2 — decoders on the shared connection (Direction A, generalized)

Once Phase 1's `rtl_tcp` connection exists, spike whether `dump1090`/`readsb`,
`rtl_433`, an AIS decoder, etc. can point at it as a remote IQ source rather
than each owning the USB device. Each that works becomes another thin
decoded-JSON layer per Direction A, sharing Phase 1's one physical connection.
Layers still respect the single-tuner constraint: switching which protocol is
"live" retunes the shared device.

### Phase 0 status

Mocked implementation started on `feat/local-adsb-tap` (branched from `main`,
following this repo's `<type>/<kebab-description>` naming convention):

- `src/data/localAdsbProxy.js` + `src/data/localAdsbProxy.test.mjs` — pure
  fetch/cache/normalize mechanics for `/api/local-adsb`, no real dump1090
  instance involved (17 tests, all passing).
- `src/data/localAdsb.js` + `src/data/localAdsb.test.mjs` — the frontend
  layer (`init/enable/disable/update/destroy/getStats`), tested against a
  fake viewer with `fetch` monkeypatched (7 tests, all passing).
- `server/providers/aircraft/local-adsb.js` — `localAdsbProxy()` plugin,
  registered into `server/providers/local.js`'s `localProviderPlugins()`
  list (post-refactor: `vite.config.js` is now a thin re-export shim, no
  plugins are registered there directly — see `docs/CODE-BOUNDARIES.md`).
  Reads `LOCAL_ADSB_BASE_URL` (default `http://localhost:8080`)
  **server-side only**, never from the request — deliberate SSRF mitigation
  given this app's supported LAN-sharing mode (README "Sharing an
  instance"): a shared instance must not let a visitor redirect the proxy
  at an arbitrary internal host.
- Full repo test suite still green (2,838 pass, the same 2 pre-existing,
  environment-specific failures reproduce identically with this branch's
  changes removed — unrelated to this work).

**Update — wired into the running app and verified in-browser:**
- `src/data/layerState.js` — registered `local-adsb` (token `l`,
  `enabled-only`), `REGISTERED_LAYER_IDS` count bumped 16 → 17 in
  `layerState.test.mjs`.
- `src/standalone/data.js` (`createStandaloneData`) — imports and registers
  the layer with `DataLayerManager` (post-refactor: layer registration
  moved out of `src/main.js`, which is now just a 17-line entry point that
  constructs and starts the standalone application). The toggle-panel UI
  needed **no manual `index.html`/`ui.js` changes** — the panel is built
  dynamically from each registered layer's `icon`/`name`, so registering
  was enough to make it appear.
- `LOCAL_ADSB_MOCK=1` (documented in `.env.example`) makes the proxy serve a
  static 4-aircraft fixture near Austin, TX (this app's default camera
  location) instead of fetching a real receiver — for trying the layer
  before hardware is on hand. Shaped as a raw `aircraft.json` body and run
  through the real `normalizeLocalAdsbSnapshot`, not a shortcut around it.
- Verified live in the Browser pane: enabled the toggle, watched the count go
  to 4 and the four magenta `MOCK0x`-labeled points render on the globe at
  their configured positions/altitudes. Confirmed via server-side
  `Date.now()` logging (temporarily added, then removed) that polling
  actually happens every ~3 s as configured — the Browser pane's own
  network-log timestamps looked like a runaway loop but turned out to be a
  red herring in that tool's own instrumentation, not a real bug.

**Still not done:** voice tools, and no real-hardware testing yet (still
blocked on the device, see below).

### What's blocked on having the Nooelec v5 physically connected

| Can build/test now (mocked upstream) | Needs the device physically connected |
|---|---|
| Phase 0 layer + `/api/local-adsb` proxy, tested against a fake dump1090 JSON response | Confirming Phase 0 against a real dump1090 instance actually fed by the dongle |
| Phase 1 `/api/local-sdr` middleware + protocol parsing, tested against a mocked `rtl_tcp` TCP stub | Confirming `rtl_tcp` enumerates this exact dongle over USB on the target OS |
| Phase 1 FFT pipeline, unit-tested against synthetic IQ | Real gain/PPM calibration (0.5 PPM TCXO should mean minimal drift, unverified until measured) |
| Phase 1 frontend layer, panel UI, layer-state registration, voice tools | Verifying actual usable frequency range/sensitivity with the bundled antennas |
| Phase 2 spike research (reading each decoder's docs for remote-`rtl_tcp` support) | Confirming a spiked decoder integration end-to-end against the real shared stream |

## Architecture (Direction B)

This app's existing live-data layers (AIS live vessels, Radio Browser, CelesTrak,
TomTom, …) share one pattern, confirmed by reading `vite.config.js`: **the
browser never opens a live socket.** A Vite dev-middleware owns any live
upstream connection server-side (e.g. `/api/ais-live` keeps an outbound `ws`
connection to aisstream.io alive and serves a buffered snapshot on each poll).
Phases 0–2 all keep that pattern rather than introducing browser-side
WebSockets, so they stay consistent with every other layer's failure/staleness
handling and test style.

Consequence: Phase 1 **is** the first layer in the app that spawns a local
child process and touches real hardware, which is a new capability class here
(every existing integration is a pure network fetch, or in AIS's case an
outbound `ws` client to a remote server — never `child_process`, never USB).
That's worth calling out in review, and worth gating hard behind an explicit
opt-in env var (`LOCAL_SDR_ENABLED=1`) so:
- every other contributor's `npm run dev` / CI run stays a no-op for this
  feature — no surprise subprocess, no USB enumeration attempt;
- the middleware only starts `rtl_tcp` (external prerequisite, documented,
  not bundled — `brew install librtlsdr` / `apt install rtl-sdr` / etc.) when
  a developer has actually asked for this layer.

Phase 0's `/api/local-adsb` proxy needs no such gate beyond its own opt-in
toggle — it's a plain HTTP fetch to a user-configured local URL, the same
risk class as every other proxy in `vite.config.js`.

### Backend (Phase 1)

- New `createLocalSdrMiddleware()` in `vite.config.js` (or its own module, if
  it grows — mirrors the shape of `createRadioProxyMiddleware`), registered
  only when `LOCAL_SDR_ENABLED` is set.
- On first use it spawns `rtl_tcp` as a child process and opens a TCP client
  connection to it (rtl_tcp's wire protocol is well-documented: a 12-byte
  dongle-info header, then a stream of interleaved 8-bit I/Q samples; commands
  — set frequency, sample rate, gain, etc. — are 5-byte command packets sent
  back over the same socket).
- Continuously reads IQ samples, runs an FFT (candidate: `fft.js`, a small
  pure-JS library, added as a dependency scoped to server-side code only — it
  never ships to the browser bundle) to produce power-spectrum bins, and
  keeps a short rolling buffer (latest frame + backlog, enough for a
  waterfall history) in memory.
- Endpoints:
  - `GET /api/local-sdr/status` → `{connected, device, centerHz, sampleRateHz, gainDb}`
  - `GET /api/local-sdr/spectrum` → latest frame(s): `{atMs, centerHz, binHz, bins: number[]}`,
    polled by the browser at roughly 10 Hz — consistent with the rest of the
    app's poll-not-push convention, revisited only if 10 Hz proves too coarse
    for a usable waterfall.
  - `POST /api/local-sdr/tune` → `{centerHz?, sampleRateHz?, gainDb?}`, applied
    in-process against the open `rtl_tcp` connection.
- Absent/failed device: `status` reports `connected: false` with a reason
  (`no_device`, `rtl_tcp_not_found`, `busy`), and `spectrum` degrades the same
  way every other layer here does on a missing upstream — no data, no
  fabricated placeholder, layer shows a clear "offline" state.

### Frontend (Phase 1)

- `src/data/localSdr.js`, implementing this app's layer interface:
  `init/enable/disable/update/destroy/getStats` (+ `getDetectableObjects` if
  it makes sense to expose spectrum peaks as detectable entities later).
- Registered in `src/data/layerState.js` with a new single-char token
  (following the existing `RADIO_FILTER_CODES`-style registry) and added to
  `CONTEXT_COMPANIONS` in `src/contextModePolicy.js` if it should behave like
  a companion layer (mirrors how `web-receivers` was added in PR #279).
- Panel UI in `index.html`: enable toggle, frequency/gain inputs, a
  spectrum/waterfall canvas, a marker at the device's location on the globe
  (device location = wherever GEV itself is running, so likely the user's own
  configured "home" location rather than something looked up).
- Voice tools (declared server-side in `GEV_REALTIME_TOOLS`,
  executed client-side in `src/voice/gevActions.js`), e.g. "tune the SDR to
  14.233 MHz", "show me the local SDR spectrum".

## Testing strategy (no hardware required for most of it)

- Phase 0: mock the dump1090/readsb JSON response the same way the existing
  Flights/adsb.lol tests mock their upstream.
- Phase 1: the middleware only ever talks to `rtl_tcp` over a documented TCP
  protocol, so tests mock that TCP server — same style as
  `webReceiversProxy.test.mjs` and `aisWatchdogTransport.test.mjs` mock their
  respective upstreams. A synthetic `rtl_tcp` stub can emit deterministic fake
  IQ samples (e.g. a pure tone + noise floor) so the FFT pipeline has a
  known-correct output to assert against.
- `scripts/qa-local-adsb.mjs` / `scripts/qa-local-sdr.mjs`, headless, run the
  whole pipeline against the synthetic stub — never against real hardware —
  matching the existing `scripts/qa-*.mjs` pattern (e.g. PR #279's
  `scripts/qa-web-receivers.mjs` never contacts real receivers either).
- Real-hardware verification is a separate, manual, one-time pass per phase
  (see [Phasing](#phasing)), not part of the automated suite.

## Open questions

- Does dump1090/readsb have a usable no-hardware test mode for Phase 0
  development (recorded IQ replay, or similar), or does even Phase 0's local
  testing need the dongle sooner than expected?
- Which Direction-A decoders actually support reading from a remote `rtl_tcp`
  source rather than requiring direct USB ownership? Needs a real spike per
  tool (dump1090/readsb, rtl_433, AIS-catcher/rtl-ais, acarsdec, direwolf)
  before Phase 2 scope is real.
- Poll rate for `/api/local-sdr/spectrum` (Phase 1): is 10 Hz enough for a
  readable waterfall, or does this need to go higher (and if so, does the
  poll-based convention still hold, or does this layer need a documented
  exception)?
- Multiple simultaneous dongles (the v5's own pitch): out of scope through
  Phase 2, but worth keeping the device-ownership code in Phase 1 written so
  a second `rtl_tcp` instance on a different port isn't a rewrite later.
- Where the "device location" marker comes from (fixed home location vs.
  something configurable) is still undecided.

## Docs to update once each phase actually ships

Per `CONTRIBUTING.md`, in the same PR as the implementation (not before):
`docs/CURRENT-STATE.md` (verified runtime behavior), `DATA_SOURCES.md` (new
local-only, non-network "source" — worth documenting even though it's not a
licensing concern like the rest of that file), `CHANGELOG.md`, and the layers
table in `README.md`. Phase 0 should also reference and close
[issue #57](https://github.com/bilawalsidhu/gods-eye-view/issues/57) in its PR.
