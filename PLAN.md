# Implementation plan

This plan expands [project.md](project.md) into an actionable first release. The original brief remains the source of product intent. Technical choices and defaults below are proposals until verified during implementation.

## 1. Goal and release scope

Build a lightweight TypeScript Pomodoro application for Twitch study streams. Start and operate it primarily from a terminal; display a polished local web page in an OBS Browser Source without sharing a browser window.

The first release must include:

- A configurable focus, short-break, and long-break timer.
- A calm, readable stream display with dark and light themes and tasteful lava-lamp-inspired motion.
- A layout and animation budget optimized for a 1920×1080 (1080p) OBS scene.
- A minimal web music player showing the current title and playback controls, with no progress bar or volume control.
- Local-folder music playback, configurable crossfade, and fine volume adjustment from the TUI.
- A TUI music browser for both RoyaltyMusicFree and Open Lo-Fi.
- Concise startup instructions and a repeatable OBS setup.

Accounts, cloud hosting, Twitch chat integration, analytics, task management, calendar integrations, and a theme marketplace are outside this release. Inspiration from a reference does not automatically add all its features to scope.

## 2. Reference research and design direction

Initial source review: 2026-11-12. The observations below come from public page content, not an interactive visual audit. Complete the visual comparison before finalizing the design.

| Reference | Observed addition to a basic timer | Direction for this project |
| --- | --- | --- |
| [Pomofocus](https://pomofocus.io/) | Custom durations, task estimates, finish estimates, and focus reports. | Borrow clear timer hierarchy and easy duration configuration; defer task tracking and reports. |
| [Study With Me](https://studywithme.io/aesthetic-pomodoro-timer/) | The fetched page did not expose readable controls or feature descriptions. | Inspect interactively for layout, scenery, typography, and motion; record findings rather than assuming features. |
| [Morgen](https://www.morgen.so/pomodoro-timer) | Session count, start/reset/skip controls, tasks, and ambient sound choices. | Borrow visible session progress and direct controls; use the requested music workflow for audio. |
| [Pomofox](https://www.pomofox.com/) | Characters, backgrounds, ambient sounds, cycle indicators, automatic cycles, and clock-based timing. | Borrow gentle personality, clear cycle progress, and reliable timing; express the atmosphere through lava-like motion. |

Research tasks:

- [ ] Compare the four sites visually at desktop and small overlay sizes: timer prominence, spacing, colors, controls, and transitions.
- [x] Note what each adds beyond the standard focus/break cycle and whether that addition serves this stream workflow.
- [ ] Look for official source repositories only if source inspection would resolve a concrete design or implementation question.
- [ ] If useful, clone a reference into a temporary folder, record its source and license, and keep it outside this project.
- [ ] Reuse code or assets only where their licenses permit it; otherwise implement the design ideas independently.
- [x] Summarize the final visual direction before building the full interface.

Visual principles:

- Make the countdown the strongest element, followed by phase and cycle progress.
- Prefer a dark background, soft gradients, restrained accents, generous spacing, and reassuring copy.
- Include a deliberate light theme with equally readable text and controls.
- Keep lava-like shapes slow, soft, and behind the content. Avoid flashing, abrupt color shifts, and motion that competes with the timer.
- Support reduced motion and a static background option.
- Use stable-width timer digits so the layout does not shift each second.
- Preserve keyboard focus indicators, accessible control labels, and adequate contrast in both themes.

## 3. Proposed runtime and ownership

Use one local application process and one shared session. Use Svelte for the web UI; avoid a database and accounts.

- **Runtime:** Node.js with TypeScript; select and document a supported version when bootstrapping.
- **Package manager:** prefer pnpm for installation and all documented commands; commit `pnpm-lock.yaml` and record the selected pnpm version in `package.json`.
- **Web UI:** Svelte with TypeScript and Vite. Use a plain Svelte application; no SvelteKit server layer is needed for the proposed local runtime.
- **Terminal:** an Ink interface with source tabs, a highlighted scrolling library, search, playback status, and existing keyboard shortcuts. Ink manages terminal rendering, input, resize handling, and cleanup.
- **State:** the local process owns timer state, settings, and the music queue. UI clients send commands and receive current state.
- **Transport:** begin with local HTTP commands and server-sent state updates. Add a different transport only if a demonstrated requirement needs it.
- **Persistence:** a small validated settings file, written atomically. Persist preferences, not an automatically resumed live stream session.
- **Serving:** provide a normal local start command that serves built assets; do not require OBS to depend on a development hot-reload session.

Proposed web surfaces:

| Surface | Purpose |
| --- | --- |
| `/` | Single minimal timer page: icon controls, settings, and the current song’s title/playback controls. |
| `/overlay` | OBS audio output with automatic playback plus countdown, phase, cycle, and optional title; no controls or operational errors. |
| `/player` | Compatibility redirect to `/`; there is no separate audio room. |

The OBS overlay owns audio automatically, using two audio decks and gain automation for crossfade. The operator page is a silent controller, with no speaker-activation step. Only one connected overlay may own audio; duplicates wait and take over when the owner disconnects. Source refreshes and reconnects preserve playback intent and automatically restart the current track. The browser test uses OBS's autoplay policy (`no-user-gesture-required`), rather than requiring a user gesture. Do not build a separate audio backend.

Bind the server to loopback by default. Validate commands and setting ranges, restrict local-file serving to explicitly configured music directories, reject traversal and symlink escapes, and protect mutation endpoints against cross-origin requests. Do not expose absolute music paths or terminal errors in the stream overlay.

## 4. Timer behavior

Proposed defaults: 25-minute focus, 5-minute short break, 15-minute long break, and a long break after four completed focus sessions. All durations and the long-break interval are configurable positive values.

- Support start, pause/resume, reset-current-phase, and skip-current-phase.
- Provide panel `4 Timer` in the TUI with explicit `s` start, `p` pause, `n` skip, and the existing toggle/reset controls.
- Play one original synthesized placeholder bell through the active OBS overlay on each natural focus/break completion; skip/reset and source reconnects must not replay it.
- Track phase, running/paused status, remaining time, and completed focus count.
- Count a focus session when it completes or is skipped. Skipping a break does not add a focus completion; resetting does not advance cycle progress.
- After a long break, start the next cycle with the completion count reset.
- Offer automatic phase start as a setting; default it off until the operator enables it.
- Apply duration changes to the next phase or an explicitly reset phase, without silently changing a running countdown.
- Calculate remaining time from an authoritative deadline rather than subtracting one second per UI tick. Browser throttling or overlay refresh must not alter the session.
- Keep the browser countdown anchored to one local monotonic deadline until a timer change or reconnection; music/settings updates and packet jitter must not restart it.
- Define system-sleep recovery: reconcile elapsed time on wake, then present the next phase paused rather than silently counting multiple unattended sessions.
- A fresh client receives the current snapshot immediately; reconnects do not restart the timer.
- Keep timer operation independent of music loading and provider availability.

Acceptance: terminal and web controls operate the same timer; multiple displays agree within one displayed second; refresh preserves the running session; the focus/break sequence and completion counts remain correct through pause, skip, reset, and reconnect.

## 5. Music behavior

### Local library

- Accept an optional music directory through startup configuration; the timer works without one.
- Enumerate supported audio files, including subdirectories, in a stable order.
- Use the filename as the initial title fallback; extract embedded metadata only if available through the chosen playback tooling without unnecessary dependencies.
- Document supported formats after testing the chosen backend. Handle unsupported or unreadable files with a concise terminal message.
- Provide browse/select, queue, play/pause, previous, and next. At queue end, stop; add repeat behavior only if requested later.
- Never modify or delete source audio files.

### Crossfade and volume

- Make crossfade duration configurable in seconds; zero disables it. Proposed default: 5 seconds.
- Overlap outgoing and incoming tracks with a smooth gain curve; keep master volume independent of fade gains.
- Preload the next track and clamp the fade for short tracks. Do not fade away the current song before the next is ready.
- Define next/previous during a fade so obsolete audio is stopped and at most two decks remain active.
- Pause/resume both decks consistently during a transition.
- Handle missing durations, decoding failures, and network stalls without crashing the timer; report when a transition cannot crossfade.
- Provide TUI volume changes in 1-percentage-point steps, clamped to 0–100%, and display the current level there.
- Omit both volume and progress controls from the web UI. Show title and playback state with previous/play-pause/next controls.

Acceptance: a two-track local queue overlaps audibly at the configured transition; zero fade gives a normal transition; volume changes remain smooth during a fade; pause and rapid skips never leave stray audio playing.

### Online catalog browser

Both providers are part of the first release, not optional follow-up work.

| Provider | Verified starting point | Implementation work |
| --- | --- | --- |
| [RoyaltyMusicFree](https://royaltymusicfree.com/) | Public searchable catalog with track metadata, MP3 links, and credit information. | Check for a supported machine-readable feed; otherwise isolate a small parser for public catalog data, subject to allowed access. Preserve source and credit information. |
| [Open Lo-Fi](https://github.com/btahir/open-lofi) | Repository exposes `catalog.json`, categories, and downloadable tracks. | Read the catalog, validate its actual schema, and resolve track URLs from the source data. |

- Browse by provider, filter titles, and navigate categories where available.
- Show title, artist where available, provider, and source link in the terminal; allow selection into the shared queue.
- Fetch catalog metadata on entering the provider, cache the last successful result, and provide explicit refresh.
- Bound network requests with timeouts and validate external catalog data and media URLs.
- Prefer direct permitted media access. If downloading is needed, make it explicit, bound the cache, and keep it separate from the user's local music folder.
- On provider failure, retain any usable cached catalog, explain the failure in the TUI, and keep local music and the timer usable.
- Preserve per-track license/source/credit metadata and provide copyable credits for stream descriptions. Confirm source terms at integration time; do not assume every provider has identical requirements.
- If a provider lacks a usable permitted interface, record the concrete blocker and resolve access before calling the first release complete.

## 6. Terminal workflow

Proposed command shape after installation/build:

```sh
pnpm start --music-dir /path/to/music
```

Print only the operator URL, OBS overlay URL, audio setup status, and a short help hint. Missing music is informational; an occupied port or invalid configuration gets an actionable error.

Suggested bindings, to validate in the first working TUI:

| Key | Action |
| --- | --- |
| `Space` | Play/pause music |
| `h` / `l` | Previous/next track in player view |
| `j` / `k` | Navigate library rows |
| `Enter` | Select the highlighted track |
| `-` / `+` | Decrease/increase music volume by 1 percentage point |
| `t` | Start/pause the timer |
| `r` | Reset the current timer phase |
| `n` | Skip the current timer phase |
| `/` | Search the current catalog |
| `Esc` | Exit search or return to the player |
| `?` | Show help |
| `q` / `Ctrl+C` | Quit cleanly |

While typing in search, text input takes precedence over playback shortcuts. Show active context and avoid key conflicts. Restore terminal mode and stop audio on normal shutdown and handled termination signals. For non-interactive output, print startup information without enabling raw keyboard mode or an endlessly redrawn interface.

## 7. OBS integration

- Publish a dedicated local overlay URL suitable for an OBS Browser Source.
- Support transparent overlay composition and an opaque scene background without requiring custom OBS CSS.
- Optimize layout, typography, spacing, and animation performance for a 1920×1080 OBS Browser Source at 100% scale. Use 1080p as the primary design and acceptance target.
- Use a 320px countdown, 56px phase/session labels, and 32px song titles at 1080p for phone viewers; keep long titles within two lines and preserve responsive sizing.
- Keep resized sources readable without clipped digits or controls; smaller layouts are secondary to the 1080p stream experience.
- Keep terminal errors, file paths, provider browsing, and settings off the overlay.
- Show a subtle disconnected state if the local process disappears; recover automatically when it returns.
- Make hiding, showing, refreshing, or duplicating the visual source safe for timer and audio ownership.
- Document one tested audio capture route, monitoring settings, and how to prevent duplicate capture. Browser audio versus application/system capture is resolved in the initial spike.

Acceptance: an OBS recording contains the correct countdown and exactly one music output; changing scenes and refreshing the source do not reset the session or duplicate playback. No browser-window screen sharing is needed.

## 8. Implementation milestones

### Milestone 1 — Resolve reference and audio questions

- [ ] Finish the visual reference comparison and record the chosen visual direction.
- [x] Inspect both online catalog formats and usable track URLs.
- [ ] Prove a two-track crossfade with terminal-driven volume adjustment.
- [ ] Capture the prototype in OBS, including automatic audio startup, scene changes, and source refresh.
- [x] Choose one audio backend and record any setup requirements.

Done when the riskiest integration works end to end and no first-release provider has an unexplained access assumption.

### Milestone 2 — Bootstrap and shared timer

- [x] Bootstrap Svelte, TypeScript, and Vite using pnpm; include the lockfile and record the package-manager version.
- [x] Add the minimal pnpm development, build, start, Svelte/TypeScript check, and test commands.
- [x] Implement validated settings, loopback serving, shared state, and client synchronization.
- [x] Implement the timer transitions and the basic terminal controls.
- [x] Build a plain operator view and read-only overlay before styling.
- [x] Test phase transitions, deadline timing, pause/reset/skip, and reconnect snapshots.

Done when the terminal and two web clients reliably control/display the same session.

### Milestone 3 — Local music and TUI

- [x] Add directory discovery and the shared queue.
- [x] Integrate the chosen audio backend, crossfade, and fine volume control.
- [x] Implement browsing, search, help, and clean terminal shutdown.
- [x] Add the minimal web music controls and current-title display.
- [x] Check empty libraries, unsupported tracks, short tracks, fade interruption, and duplicate-player prevention.

Done when a local study session can be run from the terminal with stable audio.

### Milestone 4 — Both online providers

- [x] Implement and validate Open Lo-Fi catalog loading.
- [x] Implement and validate RoyaltyMusicFree catalog loading.
- [x] Add provider selection, filtering, queue selection, cached metadata, and refresh.
- [x] Preserve track source and credit information.
- [x] Test a malformed catalog, unavailable provider, and failed media request with small fixtures.

Done when tracks from each provider can be browsed and played through the same queue and transition behavior as local tracks.

### Milestone 5 — Visual polish and OBS hardening

- [x] Apply the dark and light themes, typography, spacing, and subtle lava-like background.
- [x] Add reduced motion, static mode, keyboard focus, and accessible labels.
- [x] Tune the full layout at 1920×1080, then verify transparent composition, resized-source readability, and long-title handling.
- [ ] Verify OBS source lifecycle and exactly one audio capture path.
- [ ] Check animation load during an actual 1080p stream recording; simplify effects if they compete with OBS.

Done when the stream display meets the calm visual brief and stays usable in a sustained session.

### Milestone 6 — Documentation and release checks

- [x] Write a README covering pnpm install/build/start, settings, shortcuts, music formats, and 1920×1080 OBS setup.
- [x] Document the selected audio backend, activation/capture steps, crossfade limits, provider credits, and troubleshooting.
- [x] Verify a clean installation and startup without a music folder or provider/network requests; online catalogs are fetched only when selected.
- [x] Run Svelte/TypeScript checks, build, and focused automated checks through pnpm.
- [ ] Complete one full focus/break cycle and an extended OBS recording with theme changes, track transitions, and reconnects.

Done when another local installation can reproduce the documented stream workflow without reading the source.

## 9. Validation and completion checklist

Automate checks for timer transitions, settings validation, fade scheduling, volume bounds, provider parsing, and local-file access boundaries. Use small fixtures and controlled clocks where appropriate; avoid real-time waits and network-dependent unit tests.

Use manual checks for audible crossfade quality, actual OBS capture, automatic overlay audio startup, visual calmness, theme contrast, keyboard operation, reduced motion, and sustained resource use. These cannot be established by a passing build alone.

The release is complete only when all of the following are true:

- [x] One documented terminal command starts the application and prints useful local URLs.
- [x] The focus/break timer works independently of music or internet connectivity.
- [ ] OBS displays the timer without browser-window capture.
- [ ] The layout is readable and animations perform smoothly in a 1920×1080 OBS recording.
- [x] The UI feels calm, includes dark and light themes, and supports reduced motion.
- [x] Local music and both online catalogs work through the TUI.
- [x] Crossfade is configurable and TUI volume adjustment is fine-grained.
- [x] The web player shows title and playback controls, without a progress bar or volume control.
- [x] Refreshing displays never duplicates audio or resets the timer.
- [x] Setup, credits, failure recovery, and any verified limitations are documented.

## 10. Assumptions to validate during implementation

- Start with Linux as the first tested platform, matching the current development environment; do not claim macOS or Windows support until tested.
- OBS and the application run on the same machine. Remote control and remote streaming hosts are outside the first release.
- The OBS overlay must autoplay without a user gesture; ordinary browsers may enforce a different autoplay policy.
- Provider availability, media URLs, and terms can change. Validate the integrations when built and keep provider failures isolated from local operation.
- The initial repository contained only `project.md` and this plan. Implementation and verification status is recorded below.


## 11. Implementation status

The local application is implemented as **Still**. See [README.md](README.md) for startup, terminal controls, automatic overlay audio startup, provider credits, and OBS setup.

Implemented architecture: Svelte 5 + TypeScript + Vite, pnpm, a loopback Node server, shared timer and queue, HTTP commands/SSE, atomic JSON preferences, an Ink terminal UI, and one automatic OBS overlay audio owner. No reference code/assets were copied and no cloud deployment was added. Open Lo-Fi uses its v1.0.0 manifest and selective HTTP-range ZIP extraction, with a 256 MiB music cache; RoyaltyMusicFree uses its public catalog attributes and same-origin media streaming.

Verification performed:

- `pnpm check`, `pnpm test` (16 tests, including a real terminal regression), and `pnpm build` pass. A fresh temporary installation also builds and starts without a music folder or provider requests.
- `pnpm test:browser` exercises Chromium at 1920×1080, both themes, settings, timer synchronization, delayed-packet countdown regression and a shortened full cycle, larger overlay typography at 1080p and phone widths, overlay transparency/resizing, reduced motion, real two-deck audio overlap and pause/resume, rapid skips, player ownership, queue completion, and request/file boundaries.
- `pnpm test:providers` checks both live catalogs, direct audio availability, and selective Open Lo-Fi extraction. Interactive TUI selection and real Chromium MP3 playback were also checked against both providers.
- The chosen visual direction is evergreen/diffused light, a rounded Nunito font, a large tabular countdown, and slow original CSS background shapes. Nunito is bundled locally with its SIL Open Font License; there are no runtime font-service requests or external image assets.

Remaining manual acceptance work: a full interactive comparison of the four reference sites, subjective listening/crossfade quality, real OBS audio routing and scene changes, and a sustained 1080p recording/resource check. Browser lifecycle tests support the design but do not count as an OBS recording. The release remains pending those manual checks; unchecked tasks above are intentional. No reference repository was cloned because no source reuse was needed.

UI update: the operator is a single minimal timer page. Decorative text, branding, headings, the record illustration, empty music placeholders, and navigation between rooms are removed. The speaker button is removed too: `/overlay` now automatically owns audio for OBS, while the operator page only sends controls. Refreshing an audio-owning overlay preserves playback intent and automatically restarts the selected song; duplicate overlays cannot double the output.
