# Still

A local Pomodoro room for study streams. Svelte + TypeScript, a terminal controller, and a 1080p OBS overlay with automatic music. No accounts, database, or hosted service.

## Start

Requires Node.js 22.12+ and pnpm 12.17.0. Install all dependencies, including development dependencies: the local server runs TypeScript through `tsx`.

```sh
pnpm install
pnpm build
pnpm start --music-dir /absolute/path/to/music
```

The music folder is optional. `pnpm start` runs the timer without a library or internet connection. All URLs use `127.0.0.1`; use the exact address printed by the terminal.

| URL | Purpose |
| --- | --- |
| `http://127.0.0.1:4173/` | Timer, playback controls, and settings |
| `http://127.0.0.1:4173/overlay` | OBS scene with automatic audio and read-only visuals |

Add `/overlay` as an OBS Browser Source, then select music in the terminal (`2` Open Lo-Fi, `3` RoyaltyMusicFree, or `1` local; `j/k` to choose, `Enter` to play). The overlay starts audio automatically; no speaker button, browser click, or separate player page is required. The operator page controls playback without producing a second audio output.

One overlay owns audio at a time, so duplicate sources do not double the music. Refreshing the active overlay automatically restarts the selected track from the beginning if playback was running. If that overlay closes, another connected overlay takes over automatically. The timer survives source/page refreshes. The old `/player` address redirects to the operator page.

Use `--port 4180` if the default port is busy. Preferences and caches live in the ignored `.still/` directory. `--data-dir /path` selects another data directory. Settings are validated and written atomically. If a settings file is invalid, startup explains the issue and leaves the file intact; fix or move it to restore startup. Live timer/queue state starts fresh each launch.

For development, `pnpm dev` runs the same local server with Vite middleware and hot reload. Production/OBS uses `pnpm build` followed by `pnpm start`.

## Terminal controls

The terminal uses [Ink](https://github.com/vadimdemedes/ink) for layout, keyboard input, resize handling, and terminal cleanup. Its top playback panel always shows `[h] Previous`, `[Space] Play/Pause`, and `[l] Next`, with volume and crossfade shortcuts beneath them. It also shows source tabs, a highlighted scrolling track list, search, queue status, and whether the OBS audio output is connected. It starts automatically in an interactive terminal. Piped output prints startup URLs once without enabling raw input. Quit with `q` or `Ctrl+C`; terminal mode is restored and connected audio stops. React is used only for the TUI; the website remains Svelte.

| Key | Action |
| --- | --- |
| `t` / `r` / `n` | Start/pause timer / reset phase / skip phase |
| `Space` | Play/pause music |
| `h` / `l` | Previous/next track |
| `j` / `k`, arrow keys | Move through the library |
| `Enter` | Play from the highlighted row; the filtered list becomes the queue |
| `a` | Append highlighted track to the queue |
| `1` / `2` / `3` | Local library / Open Lo-Fi / RoyaltyMusicFree |
| `4` | Open the timer control panel |
| `s` / `p` in panel 4 | Start/resume / pause the timer |
| `/` | Filter by title, artist, or category/album |
| `Enter` / `Esc` in search | Finish typing; shortcuts resume |
| `Esc` outside search | Clear the filter and close help |
| `g` | Refresh the current library/catalog |
| `-` / `+` | Volume down/up by 1 percentage point |
| `[` / `]` | Crossfade down/up by 1 second |
| `c` | Save queue credits to `credits.txt` in the data directory |
| `?` | Help |
| `q` / `Ctrl+C` | Quit |

Search text takes priority over shortcuts while search mode is active. To narrow categories, search their names (for example, `ambient` or an album title). A queue stops at its end; it does not repeat.

Panel **4 Timer** shows the countdown, phase, session progress, and timer commands: `s` start, `p` pause, `n` skip, `r` reset, and `Enter`/`t` start-pause toggle. Start and pause are explicit, idempotent commands: pressing start twice does not pause or restart the countdown. Press `1`, `2`, or `3` to return to a music library.

## Timer and appearance

Defaults: 25-minute focus, 5-minute short break, 15-minute long break after four completed focus sessions. Open the gear button to configure durations, sessions per cycle, auto-start, theme, motion, overlay transparency/title, and crossfade. Duration changes affect the next phase or an explicitly reset phase.

Completing or skipping a focus phase advances cycle progress toward a long break. Skipping a break moves to the next focus phase without adding a completion; finishing or skipping the long break resets the cycle. Resetting pauses the current phase at its full configured duration without advancing progress. On system sleep, an expired phase completes once and the next is paused. The local process owns the countdown, so background tabs, duplicate overlays, and page refreshes do not restart it. The display reconnects automatically after a connection loss.

The browser anchors its countdown to a local monotonic clock when the server deadline changes, rather than restarting it on every update. Music/settings broadcasts and delayed packets therefore do not make the timer count backward. Pausing, resetting, skipping, and reconnecting synchronize it with the authoritative server state.

Each natural focus or break completion plays a short synthesized bell through the active OBS overlay, including when music is paused or no track is selected. The placeholder sound is generated from sine tones locally, without third-party recordings or samples. It uses the TUI master volume. Skip, reset, repeated state updates, and refreshing an overlay do not play/replay the bell.

Short breaks gradually shift the entire page to teal, while long breaks use a lighter sky-blue palette. Both transitions take 2.8 seconds and include panels, controls, text, and background shapes. Focus restores the original palette. Both dark and light themes follow the phase colors; transparent OBS backgrounds stay transparent. Reduced-motion preferences disable the color transition.

The single-page interface shows only the timer, phase/session indicators, icon controls, and a selected song’s title, artist/category, source, and playback controls. Settings stay behind the gear icon; there are no headings, slogans, placeholder music messages, or separate audio room. The design uses a dark evergreen palette or soft daylight theme, a large stable-width countdown, and slow blurred shapes. Enable a static background in settings or use your system's reduced-motion preference. The rounded Nunito variable font is bundled locally under its SIL Open Font License (`public/fonts/OFL-Nunito.txt`); no external font service or image assets are required. The primary layout target is 1920×1080; smaller sources scale responsively. At 1080p, the OBS overlay uses a 320px countdown, 56px phase/session labels, and 32px song titles so they remain readable when the stream is scaled down on a phone. Long titles are limited to two lines.

## Music and crossfade

The OBS overlay audio backend uses two HTML audio decks through Web Audio with equal-power fade gains and a separate master volume. Default crossfade is 5 seconds; set it to zero for normal transitions. Fades are limited to half the duration of either track. The next song is preloaded; a transition waits for usable media. Pausing freezes both decks and the fade clock. Rapid skips stop obsolete audio.

Local discovery includes subfolders and excludes symlinks. MP3 and PCM WAV are verified in Chromium. Ogg, FLAC, M4A, and WebM files are discovered too, but actual codec support depends on the browser. Unreadable/unsupported tracks produce a player error; select another track. Original files are never modified. Titles use filenames without extensions.

Online browsing fetches catalog metadata on demand. `Enter` explicitly starts playback and permits loading the selected and upcoming track:

- [Open Lo-Fi](https://github.com/btahir/open-lofi): catalog and audio archive are pinned to `v1.0.0`. The provider publishes music under CC0-1.0 and states the tracks are AI-generated. HTTP range requests extract individual MP3 entries from its release ZIP; the complete 529 MiB archive is not downloaded. Individual tracks are limited to 32 MiB, and the disk cache is bounded to 256 MiB. A host that stops supporting ranges produces an actionable failure.
- [RoyaltyMusicFree](https://royaltymusicfree.com/): the public catalog supplies MP3 links, album metadata, and Purrple Cat credits. Media streams through the local server; no permanent audio cache is created. The site's CC BY 4.0 attribution needs are retained in queue credits. Its HTML parser is isolated and reports a clear error if the catalog markup changes.

Both providers retain the last successful catalog for offline browsing. Uncached online music still needs a network connection. Provider errors do not stop the timer or local playback. Download credits from operator settings, or press `c` in the terminal, for your stream description. Local music permissions remain your responsibility.

The music display shows a smaller, subdued title with artist, album/category, and source underneath. Online source labels link to the provider from the operator page; OBS shows plain text. Song details sit in a dedicated centered area below the timer, so showing, hiding, or changing them never moves the countdown. A rounded music-note SVG accompanies the details, which gently fade in and out on a 24-second cycle and crossfade when the track changes. Hovering or focusing the source link keeps its text visible; reduced-motion users get steady text. Song text uses reduced opacity, while playback controls stay fully visible. Volume stays in the terminal and no progress/seek bar is shown.

## OBS setup

1. Run `pnpm start` and add an OBS **Browser Source** using `http://127.0.0.1:4173/overlay`.
2. Set source width **1920**, height **1080**, and a frame rate matching your scene (30 fps is a reasonable starting point). Custom CSS is unnecessary.
3. In the operator settings, choose transparent composition or the full scene background. The overlay has no controls, local paths, or operational errors. A small status dot appears if it disconnects.
4. Enable **Control audio via OBS** in the Browser Source properties so the source appears in the OBS audio mixer. Choose a track from the terminal; the overlay plays it automatically. No regular browser tab is needed for sound. [OBS audio routing notes](https://github.com/obsproject/obs-studio/issues/7878).
5. Unmute that source in the mixer. Use **Monitor and Output** in Advanced Audio Properties if you also want to hear it locally; avoid capturing that monitored output again through desktop audio.
6. Reuse the same Browser Source across scenes for uninterrupted music. Leave **Shutdown source when not visible** and **Refresh browser source when scene becomes active** off if you want it to remain loaded. If it is refreshed/unloaded anyway, playback intent is preserved and the selected track restarts automatically when a source reconnects. [OBS source lifecycle settings](https://obsproject.com/kb/browser-source).
7. Record a short local clip and check countdown readability, music level, crossfades, and scene switches before streaming.

[OBS enables autoplay without a user gesture](https://github.com/obsproject/obs-browser/blob/master/browser-app.cpp). Browser integration tests use Chromium with that same autoplay policy and verify playback without clicking the overlay. A normal browser visiting `/overlay` may enforce its own autoplay restrictions; the target audio output is the OBS Browser Source. Actual OBS mixer routing and sustained 1080p recording still need verification on your setup.

## Checks

```sh
pnpm check          # Svelte diagnostics + strict TypeScript
pnpm test           # timer, parser, validation, file-boundary, and terminal tests
pnpm build
pnpm test:browser   # integration checks; requires /usr/bin/chromium
pnpm test:providers # optional live-network catalog/media and selective ZIP checks
```

Set `CHROMIUM_PATH` to another Chromium executable for browser tests. They start an isolated server on port 4197, create temporary WAV tones and settings, and close their browser/server afterwards. Screenshots go to `/tmp/still-dark-1080.png` and `/tmp/still-light-1080.png`. They check synchronized clients, a shortened full timer cycle, settings, 1080p themes, resized transparent overlays, reduced motion, byte ranges, request-origin validation, symlink rejection, real overlapping decks, pause/resume, rapid skips, queue completion, automatic overlay playback without clicks, refresh recovery, duplicate-source suppression, and automatic audio-owner handoff.

The terminal regression test uses Linux `/usr/bin/script` and port 4196 to verify rapid key presses, search priority, and terminal restoration; it skips when that utility is unavailable.

These automated audio checks establish media playback and overlap, not subjective listening quality. Actual speakers, OBS recording, every optional codec, and macOS/Windows are not yet verified.

## Scope and source notes

[PLAN.md](PLAN.md) tracks implementation and remaining manual acceptance checks. [project.md](project.md) preserves the original brief. The visual design is original CSS; no reference-site code, artwork, or fonts were copied. Reference descriptions informed the layout direction, but a full interactive comparison of all four reference sites remains open. No cloud deployment or Twitch account access is needed.
