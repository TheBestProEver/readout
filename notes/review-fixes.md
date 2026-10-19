# Review fixes (Readout 2.0, before release)

Fixes for the confirmed findings of the 2.0 review, each with a test where practical.
Rules as in notes/v2.md: headless Chrome only (`--headless=new`, fresh temp profile), no
commits, no private files or paths, no models or GPL code in the repo.

## 0. readkit copied in again (finding 6)

- `node tools/copy-into.mjs ../readout/readkit` from readkit (its working tree, as asked, with
  readkit's uncommitted fixes, so VERSION says `commit 5b42fd8...+changes`): 134 files,
  11.3 MB, nothing stale. The review's worry about a dirty copy reusing an older cache name
  is answered by the content hash in KIT_VERSION (below), not by copying from a clean tree. New: root entry points
  `voice.js` and `player.js`, `src/calendar/`, `src/layout/` (index.js re-exports the calendar
  and layout API, so about 340 KB more JS loads at start), `LICENSES/` (Apache-2.0 and two MIT
  texts; no GPL code, no models).
- It brings readkit's fixes for the issues in notes/v2.md: a scanned page with only one or two
  lines of print is OCR'd (was taken for blank), OCR lines at ~1.6x spacing stay one paragraph,
  'Dr. <lexicon name>' still expands, the player's endless 'buffering' retry after an
  unrequested AbortError, exportOgg clamps from/to.
- app.js now uses only readkit's supported entry points: `readkit/index.js` (plan, extract,
  autoName, chunkText, docToText, configure), `readkit/voice.js` (findVoice, createVoice,
  voiceStore), `readkit/player.js` (createPlayer, snapSpeed, SPEEDS, openClipStore,
  segmentKeys). No `readkit/src/...` imports are left.
- tools/readkit-files.mjs lists every top-level `readkit/*.js` (so voice.js and player.js are
  kept offline too), src/** and data/** (no .md), each with a fingerprint (SHA-256 with CRLF
  read as LF, 16 hex digits; a Windows checkout with autocrlf may have CRLF where Pages serves
  LF). KIT_VERSION is `<version>-<commit7>-<hash of all fingerprints>`
  (now `0.1.0-5b42fd8-6f0f2260`), so a copy with uncommitted changes, or a second copy at the
  same commit, never reuses an older cache name. It writes KIT_VERSION into sw.js and app.js.
- Release numbers: sw.js VERSION v6, `?v=5` for styles.css, core.js, app.js (index.html and
  the SHELL list).
- Tests: core.test.js checks the list (paths and fingerprints), that app.js and sw.js have the
  same KIT_VERSION as the tool computes, that app.js imports only the three entry points, that
  the SHELL list has the `?v=` files index.html asks for, and that sw.js's fingerprint() gives
  the tool's result (CRLF cases included). pdf.e2e: a scanned PDF whose second page has only
  two lines ("He closed the logbook for the night." / "The end.") reads both pages.

## 1. First tap on Play after the end did nothing (finding 1, app.js playAudio)

playAudio() marks playback started, then dropped the ended player with dropPlayer(), which
saw `engine === 'audio' && playing` and stopped playback again, so the start returned before
making a player. dropPlayer(opts) now takes `{ keepState: true }` (skip the
`tts.playing = false; onPlaybackStop()` part) and playAudio uses it; every other caller is
unchanged. Same fix for Play on a paused player of another voice.
Test (v2 piper): a two-sentence note played to the end with Ryan, then one real click on Play
(playing again from sentence 0, label Pause after 300 ms), then to the end again and one tap on
the second sentence (plays from there).

## 2. 'Check again' reused readkit's stored check (finding 2, app.js ensureVoice)

checkNaturalAgain() now calls ensureVoice(id, { recheck: true }), which loads the voice afresh
(also when a load of it is already under way) and calls `voice.calibrate({ speed: 1, force })`,
so the check sentence is rendered again and readkit's stored result is replaced. Playback of
the voice being checked pauses first (also while it is still loading). (The new readkit also no
longer reuses a failed check, but a stored pass would still be reused without force.)
Test (v2 kokoro): plant a stored passing check no real render gives (rt 99) and Readout's
record of a failed check, tap Check again: "Michael works on this device", the new record has
the measured rt, the planted entry is replaced, chooseEngine() is Michael again.

## 3. Old cached readkit for a new app.js after a release (finding 3, sw.js + app.js)

- sw.js answers `{ type: 'kit-version' }` messages (MessageChannel) with its KIT_VERSION.
- app.js kitSource() runs before readkit is imported: not controlled, or no `readout-kit-*`
  cache (1.x's worker, which passes readkit through) -> load at once. Otherwise ask the worker
  (1.5 s); if it keeps another readkit, call reg.update() and wait (up to 30 s, only while a
  newer worker is installing or about to take over) for a controller with this page's
  KIT_VERSION, then import. kit.from records which readkit the page got.
- The new worker's install takes every readkit file whose fingerprint matches from the older
  readout-kit-* cache and downloads only the rest, so that wait is short (one changed file in
  the test) and a readkit update no longer re-downloads 11 MB. Files are kept only when their
  fingerprint is the expected one (install and kitFile), so a host still serving another
  release's copy can't fill the new cache with old files.
- A page already running when another readkit's worker takes over (another tab, a long-open
  laptop tab after a release) is marked kit.stale and reloads: at once if hidden and idle,
  else it shows "Readout was updated. Reload to finish the update." (Reload) and reloads the
  next time it is hidden and idle. Not done: versioned readkit folders (readkit/<version>/)
  with the old cache kept for old tabs; such a tab may still load a part of the new readkit
  before it reloads.
- Tests (v2 sw): the cache holds exactly the listed files (voice.js and player.js too) under
  the current KIT_VERSION, and the worker reports it. Then a next release is put in place on
  the test server (sw.js VERSION and KIT_VERSION changed, app.js?v=next, readkit/src/config.js
  with a marker export): the first start runs the new app.js on the new readkit (marker present,
  kit.from = new), the old kit cache is gone, the new worker fetched only config.js; a second
  tab open since before the release is asked to reload and then runs the new release.

## 4. Reload to cross-origin isolation during a voice download (finding 4, app.js)

The busy check is now appBusy(), shared with the update reload: also `!!au.dl` and
`wake.reasons.size > 0` (downloads, file jobs, dictation). When skipped, the next start is
isolated anyway (the worker controls the page from the start). Not done: retrying the reload
after the download.
Test (v2 sw): a first visit in a fresh profile, the worker's precache slowed (one file held
12 s by the test server), Ryan's download held part way by the model server: once the worker
controls the page, the page has not reloaded and the download is still going; released, it
finishes.

## 5. Start hangs on a connection that carries nothing (finding 5, sw.js networkFirst)

networkFirst(req, event): for the app page, when a kept copy exists, the network fetch races a
3 s timer (NAV_TIMEOUT); the kept page opens if the network hasn't answered by then. The fetch
goes on under event.waitUntil and still refreshes the kept page. First visit (nothing kept)
and other pages wait for the network as before.
Test (v2 sw): the test server accepts connections but never answers; Readout opens from its
kept copy, with readkit, within 12 s (about 3 s plus start).

## Test harness

- tests/browser.mjs: a page that crashes or goes away (Inspector.targetCrashed, the target
  detached) now fails what waits on it instead of hanging the run. One full v2 run hung for
  over an hour in the private-document step because the phone page had gone (its target was
  no longer listed); it did not happen again in three later runs of that step (alone, after
  scan, and in the full run), and the private document takes the same time with the old
  readkit (112 s cold) as with the new one (120 s cold).
- tests/fixtures/servers.mjs: appServer's files map is read per request, and both servers have
  ctl.gate(req, path) (hold a request: a slow precache, a held download, a connection that
  answers nothing).
- Found by the new release test: the new worker takes over the page before its activate
  handler has deleted the old kit cache (controllerchange comes first), so the test waits for
  the deletion. Harmless for the page: its fetches wait until the worker is activated.

## Results

- Each new test was also run against a copy with its fix undone, and fails there: Play after
  the end ({playing: false, player: null}), Check again (rt 99 from the planted entry), the
  reload under a download (the page reloaded, download gone), the release (old config.js, no
  marker), and the silent connection (the start hung; the test now bounds each look at the
  page so it fails instead of hanging).
- Final runs (env READKIT_SCRATCH and READKIT_PRIVATE set in the shell only):
  core 27/27, sync 29/29, sync.e2e 79/79, pdf.e2e 35/35, v2.e2e 123/123 (Piper wasm 4 threads,
  64.5 s heard hidden, 0 of 653 behind; Kokoro WebGPU Intel Xe2, 65.1 s hidden, 0 of 653 behind;
  Check again 3.2x real time; next release start 1.4 s; silent connection start 3.7 s;
  private document 1: 100% of 646 golden words, no notes/footnotes/heads).
- No test processes or temporary profiles left; nothing committed.
