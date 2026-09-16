# Local USB SDR layer — design plan

Status: **Phase 0 implemented and merged locally (mocked + logic-tested), not
yet verified against real hardware, not yet upstreamed.** Nothing in this
document describes shipped/upstream behavior — for that, see
`docs/CURRENT-STATE.md`, which stays the authoritative runtime reference and
only records verified behavior. This file is a design record for a feature
under development on branch `feat/local-usb-sdr`, kept under version control
(rather than only in a GitHub issue) so the plan stays reviewable alongside
the code that implements it, and gets folded into the real docs
(`docs/CURRENT-STATE.md`, `DATA_SOURCES.md`, `CHANGELOG.md`, `README.md`)
once shipped, per `CONTRIBUTING.md`.

Revision history: originally written on `feature/local-usb-sdr`/
`feat/local-adsb-tap` (both now deleted — their content is superseded by this
revision and by the code already merged into `mi-main`, which this branch is
based on). This revision (2026-09-16) updates the plan for two things that
changed since: the device is now physically connected and enumerating, and
upstream opened [PR #382](https://github.com/bilawalsidhu/gods-eye-view/pull/382),
a shared address-validation contract this plan should adopt rather than
duplicate.

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
work; the two layers can coexist. (Confirmed still open/unmerged as of
2026-09-16.)

## Target hardware — now physically present

Nooelec NESDR SMArt v5 — RTL2832U demodulator + R820T2/R860 tuner, 0.5 PPM
TCXO. Mainstream RTL-SDR chipset: supported out of the box by `librtlsdr`
(`rtl_tcp`, `rtl_power`, `rtl_fm`), most single-protocol decoders below, and
SoapySDR, on macOS/Linux/Windows.

**Confirmed on 2026-09-16:** the device enumerates on macOS as
`RTL2838UHIDIR` (vendor `0x0bda`, product `0x2838`) when connected through a
powered external USB hub. It did **not** enumerate through the Mac's
monitor's built-in USB-C hub even though other USB devices (an Epson
scanner) passed through that same hub fine — cause undiagnosed (a specific
downstream port on the monitor hub, or a power-negotiation quirk with this
device specifically), not investigated further since the external-hub path
works. Worth keeping in mind if real-hardware testing later behaves
inconsistently.

`librtlsdr` (`rtl_test`/`rtl_sdr`/`rtl_tcp`) is **not yet installed** on the
dev machine (`brew install rtl-sdr`). This is the next concrete unblock for
any real-hardware verification below.

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
RTL-SDR / dump1090 receiver tap layer") asks for exactly Direction A's
simplest case: poll a user's already-running `dump1090`/`readsb` process
(typically `http://localhost:8080/data/aircraft.json`, tar1090-compatible)
and plot those aircraft distinctly from the public Flights layer. Opt-in,
user-configurable base URL.

**A maintainer-quality design comment from `Lob26` sits on this issue** (as
of 2026-09-16, still the only comment, issue still unassigned/no linked PR
upstream — our local implementation below is ahead of upstream's own tracking
of it). Its points, and where our implementation currently stands against
each:

| Lob26's point | Our current implementation |
|---|---|
| **Overlap with Flights**: three options — (1) draw both always, (2) local suppresses the same ICAO in Flights, (3) local wins + says so via a provenance field. Recommends (1) as default, (3) behind a toggle. | We currently do (1) implicitly — no suppression logic exists between `localAdsb.js` and `flights.js` at all. That matches the recommended default. The (3) toggle (local-wins + provenance popup field) is **not built** — worth doing as a follow-up, not a Phase 0 blocker. |
| **Receiver presence should be level-triggered**, derived from `aircraft.json`'s own `now`/`seen`/`seen_pos` rather than inferred from request success/failure — "0 aircraft, antenna fine" must not read as an error. | Already correct: `fetchLocalAdsbSnapshot()` in `src/data/localAdsbProxy.js` throws a typed error (`reason: 'unreachable'\|'http_error'\|'malformed'`) only for actual fetch/HTTP/parse failure. An empty `aircraft: []` array from a reachable receiver is a valid, non-error snapshot. This is the distinction Lob26 asked for. |
| **Staleness should be per-aircraft** (via `seen`/`seen_pos`), not one blanket feed-level flag — an aircraft heard once at the edge of range shouldn't ghost on the globe until the whole layer is toggled. | **Gap.** `normalizeLocalAdsbAircraft()` does carry each row's `seenS` through to the client, but `localAdsb.js` frontend only tracks one feed-level `_stale` boolean (from `body.stale`), not a per-aircraft `maxPositionAgeS` drop. Worth fixing before calling Phase 0 fully done — the data is already there, just unused on the frontend. |
| **Client vs. server fetch** or the receiver URL: server-side is the safer default but puts a user-supplied host under SSRF review (SECURITY.md's "no arbitrary-URL fetching" rule). | We chose server-side, but **sidestepped the SSRF question rather than solving it**: `LOCAL_ADSB_BASE_URL` is an env var read server-side only, never taken from the request at all. That satisfies SECURITY.md, but it means the base URL is fixed at deploy time, not truly "user-configurable" the way issue #57's acceptance criteria ask (a runtime UI setting). See [Migrating to PR #382's tap contract](#migrating-to-pr-382s-tap-address-contract) below — this is the real fix. |
| No writing to the receiver, no MLAT, no persisting local traffic. | Matches — the current implementation is read-only, no persistence beyond the 2s in-memory cache TTL. |
| Sequence after #305 (shared flight-tracking engine) if it lands, to reuse its ingestion seam rather than reimplement polling/marker lifecycle. | Not checked in this revision — worth a quick look at upstream issue/PR #305's status before doing further Phase 0 work, in case it changes where `localAdsb.js` should plug in. |

#### Acceptance criteria (verbatim from issue #57's "Scope")

- [x] User-configurable local receiver base URL (default to the common
      dump1090-fa/readsb default of `http://localhost:8080`) — **partially**:
      configurable via `LOCAL_ADSB_BASE_URL` env var at deploy time, not yet
      by the end user at runtime. See the tap-contract migration below.
- [x] Poll `aircraft.json` (or tar1090-compatible equivalent) on a short
      interval — 2s cache TTL server-side (`LOCAL_ADSB_CACHE_TTL_MS`).
- [x] Plot received aircraft on the globe, visually distinguished from the
      public Flights layer — bright magenta markers, deliberately distinct
      from Flights' white/amber/cyan palette, separate `local-adsb` layer
      token (`'1'` in `layerState.js`), never merged into Flights' entity
      collection.
- [x] Off by default (opt-in local-network layer) — `disposition:
      'enabled-only'` in `layerState.js`.

All four acceptance criteria are technically met; the "user-configurable"
one is met at deploy-time-config granularity rather than
end-user-runtime-config granularity, which is the gap Migrating to PR #382
below closes.

### Phase 0 — what's actually built (verified 2026-09-16)

Already merged into `mi-main` (and therefore into this branch, which is cut
from `mi-main`) via commit `d2ca846` ("Merge branch 'feat/local-adsb-tap'
into mi-main"):

- `src/data/localAdsbProxy.js` + `src/data/localAdsbProxy.test.mjs` — pure
  fetch/cache/normalize mechanics for `/api/local-adsb`, no real dump1090
  instance involved (18 tests, all passing as of this revision).
- `src/data/localAdsb.js` + `src/data/localAdsb.test.mjs` — the frontend
  layer (`init/enable/disable/update/destroy/getStats`), tested against a
  fake viewer with `fetch` monkeypatched (7 tests, all passing).
- `server/providers/aircraft/local-adsb.js` — `localAdsbProxy()` plugin,
  registered into `server/providers/local.js`'s `localProviderPlugins()`
  list. Confirms the repo's `server/providers/*` architecture (post-refactor;
  `vite.config.js` is now a thin shim) was already the target when this was
  built — no architecture migration needed here, unlike what an earlier
  draft of this plan assumed.
- `src/data/layerState.js` — `local-adsb` registered, token `'1'`,
  `enabled-only`.
- `src/standalone/data.js` — layer registered with `DataLayerManager`; no
  manual `index.html`/`ui.js` changes needed (panel is built dynamically
  from each registered layer's `icon`/`name`).
- `LOCAL_ADSB_MOCK=1` (documented in `.env.example`) serves a static
  4-aircraft fixture near Austin, TX through the real
  `normalizeLocalAdsbSnapshot` path — verified live in-browser previously
  (toggle enabled, 4 magenta `MOCK0x` points rendered, ~3s polling
  confirmed via server-side logging).
- Full repo test suite green at time of writing this revision (4398 pass, 0
  fail, 1 environment-gated skip — see the mi-main sync work done alongside
  this planning pass).

**Not yet done:**
- Real-hardware verification against the actual Nooelec v5 + a real
  dump1090/readsb instance (blocked only on `brew install rtl-sdr` +
  standing up dump1090/readsb now that the device enumerates — no longer
  blocked on hardware access itself).
- Per-aircraft staleness (`maxPositionAgeS` drop) instead of one feed-level
  `_stale` flag — see Lob26's table above.
- Migrating the base-URL config from env-var-only to PR #382's
  `parseTapAddress`/`tapUrl` contract for genuine runtime configurability.
- Voice tools.
- `docs/CURRENT-STATE.md` / `DATA_SOURCES.md` / `CHANGELOG.md` / `README.md`
  updates — deliberately deferred per `CONTRIBUTING.md` ("same PR as the
  implementation," not before), and this work isn't in a PR yet.
- Deciding whether/when to open this against `bilawalsidhu/gods-eye-view`
  to actually close issue #57 upstream, vs. keeping it local-only on
  `mi-main`. Not decided in this revision.

### Migrating to PR #382's tap-address contract

[PR #382](https://github.com/bilawalsidhu/gods-eye-view/pull/382) (open,
unmerged upstream as of 2026-09-16) adds `src/data/tapAddress.js`:
`parseTapAddress(raw)` / `tapUrl(address, path)`, a positive-allowlist
address validator (loopback + RFC1918 private ranges + `localhost`/`*.local`
mDNS names only; rejects anything URL-shaped, malformed, or public; no
hostname resolution beyond the two named forms; no IPv6). Its own module
header names issue #57 by number as a layer it's meant to cover "if built
server-side" — which is exactly our situation.

**This is the real fix for Phase 0's one acceptance-criteria gap.** Concretely:

1. Once #382 merges upstream (or we cherry-pick/vendor `tapAddress.js`
   directly — it's a small, dependency-free, pure module, so vendoring it
   ahead of the upstream merge is low-risk if we don't want to block on
   their review cycle), change `/api/local-adsb` to accept the receiver
   address as a request parameter — mirroring Rayhunter's (`#56`) own
   `?base=host:port` convention that `tapAddress.js` was written against —
   and validate it with `parseTapAddress()` before ever building a fetch
   URL with `tapUrl()`.
2. Keep `LOCAL_ADSB_BASE_URL` as the *default* the frontend pre-fills, not
   the only option — this is what actually satisfies issue #57's "user-
   configurable" criterion at the granularity a end user (not just an
   operator setting an env var) can use.
3. A tap whose address fails `parseTapAddress()` gets a 400, no fallback to
   a default host — per the contract module's own stated caller
   obligation.
4. This also directly answers Lob26's "client vs. server fetch" open
   question from the issue-#57 comment: server-side, same as we already
   chose, now with the SSRF question actually solved by the shared contract
   rather than sidestepped by fixing the URL at deploy time.

### Phase 1 — GEV owns the dongle (Direction B foundation)

Build the general spectrum/waterfall layer described in
[Architecture](#architecture-direction-b) below. This is the heavier lift and
where hardware-in-hand matters most (protocol correctness against the actual
dongle, gain/PPM behavior, USB enumeration on the target OS) — and unlike
when this plan was first written, **the hardware is now available** for
exactly this verification, pending `librtlsdr` installation.

### Phase 2 — decoders on the shared connection (Direction A, generalized)

Once Phase 1's `rtl_tcp` connection exists, spike whether `dump1090`/`readsb`,
`rtl_433`, an AIS decoder, etc. can point at it as a remote IQ source rather
than each owning the USB device. Each that works becomes another thin
decoded-JSON layer per Direction A, sharing Phase 1's one physical connection.
Layers still respect the single-tuner constraint: switching which protocol is
"live" retunes the shared device.

### What's blocked on the Nooelec v5 vs. what's just blocked on tooling

| Can build/test now (mocked upstream) | Needs `librtlsdr` installed + the device | Needs upstream #382 to merge (or vendoring it now) |
|---|---|---|
| Phase 0 layer + `/api/local-adsb` proxy — **already built**, tested against a fake dump1090 JSON response | Confirming Phase 0 against a real dump1090 instance actually fed by the dongle | Runtime-configurable receiver address (vs. today's env-var-only default) |
| Phase 1 `/api/local-sdr` middleware + protocol parsing, tested against a mocked `rtl_tcp` TCP stub | Confirming `rtl_tcp` enumerates this exact dongle over USB on macOS (`rtl_test`) | — |
| Phase 1 FFT pipeline, unit-tested against synthetic IQ | Real gain/PPM calibration (0.5 PPM TCXO should mean minimal drift, unverified until measured) | — |
| Phase 1 frontend layer, panel UI, layer-state registration, voice tools | Verifying actual usable frequency range/sensitivity with the bundled antennas | — |
| Phase 2 spike research (reading each decoder's docs for remote-`rtl_tcp` support) | Confirming a spiked decoder integration end-to-end against the real shared stream | — |

## Architecture (Direction B)

This app's existing live-data layers (AIS live vessels, Radio Browser, CelesTrak,
TomTom, …) share one pattern: **the browser never opens a live socket.** A
`server/providers/*` plugin owns any live upstream connection server-side
(e.g. `/api/ais-live` keeps an outbound `ws` connection to aisstream.io alive
and serves a buffered snapshot on each poll). Phases 0–2 all keep that
pattern rather than introducing browser-side WebSockets, so they stay
consistent with every other layer's failure/staleness handling and test
style. (Phase 0 already follows this — see above.)

Consequence: Phase 1 **is** the first layer in the app that spawns a local
child process and touches real hardware, which is a new capability class here
(every existing integration is a pure network fetch, or in AIS's case an
outbound `ws` client to a remote server — never `child_process`, never USB).
That's worth calling out in review, and worth gating hard behind an explicit
opt-in env var (`LOCAL_SDR_ENABLED=1`) so:
- every other contributor's `npm run dev` / CI run stays a no-op for this
  feature — no surprise subprocess, no USB enumeration attempt;
- the middleware only starts `rtl_tcp` (external prerequisite, documented,
  not bundled — `brew install rtl-sdr` on macOS / `apt install rtl-sdr` on
  Linux) when a developer has actually asked for this layer.

Phase 0's `/api/local-adsb` proxy needs no such gate beyond its own opt-in
toggle — it's a plain HTTP fetch to a (soon: tap-contract-validated)
user-configured local URL, the same risk class as every other proxy in
`server/providers/*`.

### Backend (Phase 1)

- New `server/providers/radio/local-sdr.js` (or similar — mirrors the shape
  of the existing `server/providers/radio/*` modules), a plugin registered
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
  fabricated placeholder, layer shows a clear "offline" state. (Phase 0
  already establishes this pattern via its typed `reason` errors — Phase 1
  should follow the same shape.)

### Frontend (Phase 1)

- `src/data/localSdr.js`, implementing this app's layer interface:
  `init/enable/disable/update/destroy/getStats` (+ `getDetectableObjects` if
  it makes sense to expose spectrum peaks as detectable entities later).
- Registered in `src/data/layerState.js` with a new single-char token
  (following the existing registry pattern Phase 0 already used for
  `local-adsb`'s `'1'`).
- Panel UI: enable toggle, frequency/gain inputs, a spectrum/waterfall
  canvas, a marker at the device's location on the globe (device location =
  wherever GEV itself is running, so likely the user's own configured "home"
  location rather than something looked up — still undecided, see below).
- Voice tools (declared server-side, executed client-side in
  `src/voice/gevActions.js`), e.g. "tune the SDR to 14.233 MHz", "show me the
  local SDR spectrum".

## Testing strategy (no hardware required for most of it)

- Phase 0: mock the dump1090/readsb JSON response — **already done** this
  way in `localAdsbProxy.test.mjs`/`localAdsb.test.mjs`.
- Phase 1: the middleware only ever talks to `rtl_tcp` over a documented TCP
  protocol, so tests mock that TCP server — same style as
  `webReceiversProxy.test.mjs` and `aisWatchdogTransport.test.mjs` mock their
  respective upstreams. A synthetic `rtl_tcp` stub can emit deterministic fake
  IQ samples (e.g. a pure tone + noise floor) so the FFT pipeline has a
  known-correct output to assert against.
- `scripts/qa-local-adsb.mjs` / `scripts/qa-local-sdr.mjs`, headless, run the
  whole pipeline against the synthetic stub — never against real hardware —
  matching the existing `scripts/qa-*.mjs` pattern. (Not yet written for
  Phase 0 — `LOCAL_ADSB_MOCK=1` currently covers manual verification; a real
  headless `qa-local-adsb.mjs` script is still open work.)
- Real-hardware verification is a separate, manual, one-time pass per phase,
  not part of the automated suite — now unblocked for Phase 0 pending
  `librtlsdr` install + a running dump1090/readsb instance.

## Open questions

- Does issue #305 (shared flight-tracking engine, referenced in Lob26's
  comment) exist and, if so, what's its status? If it's landed or landing
  soon, Phase 0 should plug into its ingestion seam rather than keep its
  current standalone polling/marker lifecycle. Not checked in this revision.
- Does dump1090/readsb have a usable no-hardware test mode (recorded IQ
  replay, or similar) for verifying Phase 0 end-to-end before doing a full
  live-antenna test, or is a live antenna the fastest path to a first real
  verification?
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
- Whether/when Phase 0 goes upstream as a real PR against
  `bilawalsidhu/gods-eye-view` to close issue #57, vs. staying local-only on
  `mi-main` — not decided.
- Lob26's (3) "local wins + provenance" overlap toggle with Flights: worth
  building, but not a Phase 0 blocker given (1) "draw both" is already the
  de facto (and Lob26-recommended default) behavior.

## Reference material (not part of the plan, kept for later)

The abandoned upstream [PR #134](https://github.com/bilawalsidhu/gods-eye-view/pull/134)
("Add browser-local RTL-SDR FM and ADS-B support", closed by its own author,
unmerged) took the *opposite* architecture from this plan — browser-side
WebUSB via `@jtarrio/webrtlsdr`, no server involvement — which conflicts with
this repo's server-side-hardware-access convention and is likely why it
wasn't merged. **Don't repeat the WebUSB approach.** Its DSP/decode code is
still a useful algorithmic reference if a from-scratch decode path is ever
wanted instead of leaning on mature external decoders: a radix-2 FFT + Hann
window + directional FM peak search, and a full Mode S DF17 decoder (CRC,
local/global CPR position decoding, callsign charset) — neither needed for
Phase 0 (dump1090 already decodes Mode S) or most of Phase 1/2 (mature
external decoders per the phase plan above), but worth knowing it exists.

## Docs to update once each phase actually ships

Per `CONTRIBUTING.md`, in the same PR as the implementation (not before):
`docs/CURRENT-STATE.md` (verified runtime behavior), `DATA_SOURCES.md` (new
local-only, non-network "source" — worth documenting even though it's not a
licensing concern like the rest of that file), `CHANGELOG.md`, and the layers
table in `README.md`. If/when Phase 0 goes upstream, its PR should also
reference and close [issue #57](https://github.com/bilawalsidhu/gods-eye-view/issues/57).
