# Narration, synchronized playback, and MP4

Use this workflow when narration/video is requested. If the user says to reserve the TTS interface for later configuration, implement/configure the plan only; do not use an available key to make live calls. Never substitute another provider or system voice silently.

Read [story-layout.md](story-layout.md) first. Select a story with `--story <id>`, or use the active/sole story resolved from the project.

> **No npm install is needed.** The narration builder and the exporter need only node,
> python3, ffmpeg/ffprobe and a Chromium-based browser. The reader ships prebuilt as
> `renderer/book.js`, `export_video.mjs` serves it from a plain `node:http` server, and frames
> are captured over the DevTools Protocol (`cdp.mjs`) — there is no Vite and no Playwright in
> this path. See [project-setup.md](project-setup.md).
>
> All of these resolve `--project`, then `$CHILDREN_STORYBOOK_PROJECT`, then `$CLAUDE_PROJECT_DIR`, then the working directory, and
> read `.env.local` from there, so they work installed globally and invoked by absolute path.
> The story is read from its own `content.js`; `src/active-story.js` is consulted only to learn
> which story is active.

## Architecture and sources

- TTS (single interface): the local Node script calls `POST {base}/audio/speech` with the OpenAI schema — `model`, `voice`, `input`, `response_format: 'wav'`, `speed`, and `instructions` for non-legacy models. Defaults `gpt-4o-mini-tts`, `marin`, speed 0.9. Read exact page text, including cover and ending.
- Endpoint: `OPENAI_TTS_BASE_URL` → `OPENAI_BASE_URL` → `https://api.openai.com/v1`. Credential: `OPENAI_TTS_API_KEY` → `OPENAI_API_KEY`. The TTS variables are deliberately separate because `OPENAI_BASE_URL` is the *Images* base used by `gen_art.py` — repointing it would silently redirect image generation too. A bare host is completed for you (`http://127.0.0.1:8123` → `…/v1`).
- Local/offline TTS uses the same interface. Model installation, voice tuning and reference-audio management belong to the endpoint operator, outside this skill.
- Current API schema: [Create speech](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create), [Text to speech](https://developers.openai.com/api/docs/guides/text-to-speech). Verified 2026-09-15; recheck if the provider rejects a model/parameter. Instructions are omitted for tts-1/tts-1-hd.
- Store credentials only in process environment or root `.env.local`. Never use `VITE_OPENAI_API_KEY`, browser requests, public assets, saved prompts, or logs for credentials.
- Clearly disclose AI-generated narration when enabled, including in exported video. The reader has a small AI badge; the export carries a footer caption, the same string as the MP4 `comment` metadata and in `<video>.mp4.json`. **The default is a real disclosure — `AI-generated narration (synthetic voice)` — and it is configurable**: pass `--disclosure "<wording>"` or set `OPENAI_TTS_DISCLOSURE` when a publisher or platform requires different words. Never set it to a brand, studio or product name: the exported file leaves this machine, and the thing a viewer needs to know is that the voice was synthesized. Fixture audio is the one exception — it keeps the fixed label `Timing test · tones, not narration`, because that label exists to stop tones being mistaken for narration. This follows the official TTS guide and is not part of the narrated story text.
- Rendering: the actual Three.js book at absolute frame times, captured over the Chrome DevTools Protocol → PNG stream → FFmpeg H.264/yuv420p + AAC/48kHz MP4. The full page capture includes the warm CSS background; export mode hides controls. No real-time screen recording and no second unrelated book renderer. The launch flags and the screenshot call in `cdp.mjs` mirror Playwright's, so frames are reproducible.

## Bundled scripts and frontend contract

Scripts live in `scripts/` inside this skill, wherever it is installed:

- `project.mjs`: resolves the skill directory, the project root, `.env.local`, and which story is active.
- `cdp.mjs`: finds and launches a Chromium-based browser, speaks the DevTools Protocol over node's built-in `WebSocket`, and captures frames. No Playwright.
- `static-server.mjs`: serves the prebuilt reader and one story's browser assets from `node:http`. No Vite.
- `media-core.mjs`: page ordering, content fingerprint, sample-based timeline, validation and absolute-time book poses. Shared by the app and both CLIs.
- `narrate.mjs`: one-shot front door: endpoint check, generate, print clip summary, optional install and MP4 export.
- `prepare_narration.mjs`: plan requests, explicitly generate TTS over the OpenAI speech API, normalize/measure clips, assemble master WAV, cache requests, optionally install audio. Exports `resolveTts()` (endpoint/credential resolution) and `voiceFingerprint()` (the preset-hash lookup described below).
- `export_video.mjs`: validate assets/timeline, start the bundled static reader, await images/fonts, render frames, encode and verify MP4.
- `verify_fixture_audio.mjs`: decode the exported fixture and check that tone slots are audible and gaps/turns are silent; never treats this as speech-quality validation.

Existing frontend integration:

- `stories/<id>/narration.js` exports `{url:null}` until real narration is installed; src/narration.js re-exports the selected story.
- `renderer/src/narration-player.js` loads/validates timeline and master hash, uses a Web Audio clock, handles pause/resume and cancellation.
- `renderer/src/book.js` exposes `window.bookDemo.ready`, `setExportTimeline(timeline)`, `renderAt(seconds)` in `?export=1` mode. Frames are computed directly from time; seeking backward then forward gives the same picture. Preserve this contract if adapting the scaffold.
- `renderer/src/shell.js` / `renderer/src/style.css` provide conditional status, AI disclosure and clean export layout.

`narrate.mjs` and `prepare_narration.mjs` write into the story folder and read its `content.js`; the exporter and QA scripts mount the skill's own reader, so they need nothing from a host app. What they *do* assume is the `window.bookDemo` contract, which `renderer/src/book.js` provides — a host with its own renderer must supply it. Copying the CLIs alone does not add narration to an arbitrary site.

The `npm run ...` forms below are conveniences of a project that keeps the skill in-repo. Installed globally, invoke the scripts directly and name the project:

```bash
node $SKILL/scripts/narrate.mjs --project "$PROJECT" --check
node $SKILL/scripts/export_video.mjs --project "$PROJECT" \
     --timeline "$PROJECT/stories/<id>/audio/<version>/timeline.json"
```

Both forms behave identically; only the `.env.local` discovery differs, and the scripts read it themselves from the project root either way.

## Quick start

Requirements: Node 22+ (`--env-file` flags and the built-in `WebSocket`; this project uses Node 24), `python3`, FFmpeg and ffprobe in PATH, and a reachable OpenAI-compatible TTS endpoint. No npm install is required.

**Against the official API or any relay:**

```bash
cp .env.example .env.local
# Set OPENAI_TTS_API_KEY (falls back to OPENAI_API_KEY). Do not commit this file.
npm run narration:plan                                 # writes requests.json; no API calls
npm run narrate -- --check                             # probes GET {base}/models; generates nothing
npm run narrate -- --name red-audio-v1                 # generate every page; prints per-clip duration + text
# listen to stories/<id>/audio/red-audio-v1/*.wav, then:
npm run narrate -- --name red-audio-v2 --install --video
```

For a separately managed local endpoint, set `OPENAI_TTS_BASE_URL`, `OPENAI_TTS_API_KEY` and a supported `OPENAI_TTS_VOICE`. Do not install or modify its inference implementation from this skill.

For a standalone project, use the scripts directly:

```bash
node "$SKILL/scripts/narrate.mjs" --project "$PROJECT" --story <id> --plan
node "$SKILL/scripts/narrate.mjs" --project "$PROJECT" --story <id> --check
node "$SKILL/scripts/narrate.mjs" --project "$PROJECT" --story <id> --name audio-v1
```

`narrate.mjs` wraps the builder/exporter. Flags include `--project`, `--story`, `--name`, `--voice`, `--speed`, `--model`, `--disclosure`, `--plan`, `--check`, `--install`, `--video`, `--output <mp4>`, `--refresh-page <id>` (repeatable) and `--allow-fallback-voice`. `--plan` runs before preflight and makes no network calls or credential checks. It cannot be combined with `--check`, `--install` or `--video`.

`--check` inspects credentials, ffmpeg and optional endpoint metadata. A missing `/models` route (404/405/501) is a warning, not proof that `/audio/speech` fails. Authentication errors, unreachable hosts and other server errors remain failures. Optional `/voices` metadata can report a fingerprint or an explicit voice fallback; an explicitly reported fallback still stops generation unless accepted with `--allow-fallback-voice`. Absence of metadata is not a voice-quality check. Preflight never claims speech synthesis or spoken content has been verified.

For a single-page retake, use a new version name and bypass only that page’s local cache:

```bash
node "$SKILL/scripts/narrate.mjs" --project "$PROJECT" --story <id> --name audio-v2 --refresh-page page-02
```

This sends the standard speech request again without extra API fields, leaving the other cached clips and earlier audio versions intact. Invalid page IDs fail before generation. Each explicit refresh makes another paid request even when its text is unchanged. A deterministic endpoint may return identical audio; consult its supported controls rather than repeatedly retrying. Existing `--seed <n>` and repeatable `--page-seed <id>=<n>` are optional extensions for endpoints known to support a request-level seed, not portable requirements. They are never sent by default.

To clone a voice, use the endpoint’s own supported setup and obtain the speaker’s permission. Keep inference configuration and model assets outside story folders. If the service is unavailable, prepare a plan or use labeled fixture tones; do not silently switch services or voices.

Planning writes `stories/<id>/audio/requests.json` with exact inputs and parameters, without calling any endpoint. Credentials are not needed for planning or local fixtures. The default app remains a clearly labeled silent flip demo until real narration is installed. If the user says to reserve the interface, stop at planning.

## Underlying commands and output contract

```bash
npm run narration:plan                                       # plan only; no network
npm run narration:generate -- --name red-audio-v1 --install   # generate through the configured endpoint
```

Output: `stories/<id>/audio/<name>/`, containing per-page WAVs, `master.wav`, `timeline.json`, and `requests.json` (provider, the resolved base endpoint, exact per-page request bodies, hashes, the preset fingerprint, the seeds used and the disclosure). Each clip is 48 kHz mono PCM16; a response that already is that format is used as-is, otherwise it is normalized through ffmpeg. **Clips are level-matched before assembly**: each one is measured over its speech (a −50 dBFS gate, so silence is not counted as content) and scaled toward −20 dBFS RMS, never past a −1 dBFS peak ceiling and never by more than ±12 dB — a page 6 dB under its neighbours is a property of generating eighteen clips independently, not bad luck, and it lands in the master otherwise. The per-clip gain is in `timeline.clips[].gainDb` and `timeline.loudness`; `--no-normalize` (or `OPENAI_TTS_NORMALIZE=0`) turns the pass off. Durations use actual PCM sample counts, not word-count estimates or guessed speaking speed. Version-2 cache keys include the normalized speech endpoint, page ID (so repeated text can have independent retakes), the exact input and every generation parameter in the body (model, voice, speed, instructions, and any `--seed`/`--page-seed`) plus, when the endpoint offers `GET /v1/voices`, a fingerprint covering the voice's effective tuning and reference-audio bytes — so changing a reported fingerprint invalidates the cache even though the body is unchanged. Without fingerprint support, use explicit refresh when server-side voice settings change. Legacy cache files omit endpoint identity and are preserved but not reused; the first generation with v2 creates fresh entries. The cache stores what the endpoint returned, *before* level matching, so retargeting the loudness never invalidates it. Successful clips survive a later failure; rerun explicitly to reuse them. There are no automatic paid retries. A new output name prevents overwriting finished work — and is free when the clips have not changed, since the cache is content-addressed. `timeline.tts` records `provider: "openai-compatible"`, the base `endpoint`, model, voice, speed, instructions, the seeds and the preset fingerprint — never a credential.

`--install` updates `stories/<id>/narration.js`, saving its prior configuration in backups/. Audio stays in audio/<version>/ and is served by the Vite plugin; no duplicate public/ copy is created. Generated story assets remain together for management; only caches, temporary files and .env files are gitignored. Listen to every generated clip before delivery.

Missing credential, failed requests, changed story, missing WAVs, invalid durations or hash mismatches are errors. Do not silently fill missing speech with silence or call an incomplete narration ready. Changing text requires rebuilding audio. Changing page image URLs also invalidates the content fingerprint; rebuilding reuses unchanged speech cache entries. Replacing image bytes at an unchanged URL does not invalidate narration because the words/page order are unchanged; the next export loads the current artwork; use the sampled thumbnail workflow if a visual check is needed. Server-side voice changes invalidate the cache only when the endpoint reports a changed fingerprint; otherwise request an explicit refresh.

## Timing and playback

Each spread follows: settle → left speech → gap → right speech → pause → silent page-turn → settle. Cover and ending have their own clips. Defaults in media-core: lead 0.6s, left/right gap 0.4s, pre-turn pause 0.65s, turn 1.35s, settle 0.55s, tail 0.8s.

The master track includes these silent intervals. The app drives scene time from Web Audio’s playback clock. Pausing freezes voice and scene; resuming keeps the offset. Manual chapter selection, arrows, reset and drag cancel the old audio. Starting again reads the selected spread from its start. Playback reaches the ending once; it does not loop the narrated book unexpectedly. The separate unconfigured silent demo retains visual-only behavior and is explicitly identified as unvoiced.

This is page-level synchronization. Do not claim word-level highlighting, forced alignment or lip sync; none is implemented.

## Export real MP4

```bash
npm run video:export -- \
  --timeline stories/little-red-demo-v1/audio/red-audio-v1/timeline.json \
  --output stories/little-red-demo-v1/video/little-red-v1.mp4
```

Defaults: 1920×1080, 30 fps. Optional `--width`, `--height`, `--fps`, `--project`; dimensions must be even. Environment overrides: FFMPEG_PATH, FFPROBE_PATH, CHROME_PATH. Existing output files are rejected. A new output name is required for another export.

Exporter verifies that the timeline matches current content and master samples/hash before rendering; it rejects test fixtures unless explicitly opted in. It waits for every page image/font. Frame n is rendered at n/fps with no dependence on wall-clock waits, damping history, browser tab timing or audio playback hardware. The last fractional frame is rounded up; audio is padded to video duration. Export report `<video>.mp4.json` records counts, duration, codecs, mode and provenance hash. The visible disclosure is `timeline.disclosure`, burned into the video and repeated in its `comment` metadata.

Render time can exceed video length, especially on CPU/software WebGL. Temporary files and the local server are cleaned on completion/failure. Cancellation or crashes can leave a `.render-*` folder; inspect before deleting only that run’s temporary assets.

### Finish with publishing materials

For a normal MP4 request, continue with [publishing.md](publishing.md): compose horizontal and
vertical covers and write platform-specific titles, tags and descriptions. Prepare story-local
copy and pass `--publish-copy <file>` to this exporter (also supported by `narrate --video`), or
run `publish_bundle.mjs` after export. New export reports include the video SHA-256. A failed
publishing step preserves the MP4 and can be retried separately. Skip this step for test tones
or when the user explicitly excludes publishing materials; no upload is performed.

## Offline verification without TTS

```bash
npm run test:media
npm run narration:fixture -- --name sync-fixture-v1
npm run video:export -- \
  --timeline stories/little-red-demo-v1/audio/sync-fixture-v1/timeline.json \
  --allow-test-audio --output stories/little-red-demo-v1/video/sync-check.mp4
npm run video:verify-fixture -- --video stories/little-red-demo-v1/video/sync-check.mp4 \
  --timeline stories/little-red-demo-v1/audio/sync-fixture-v1/timeline.json
npm run test:e2e
```

Fixtures are short deterministic tones, **not spoken English**. The fixture builder refuses `--install`, exporter requires `--allow-test-audio`, and the video visibly says “Timing test · tones, not narration”. Do not provide it as a narrated story. Keep the live reader’s narration unconfigured during such tests. Live API testing remains a separate, explicitly configured step.

Use a sampled thumbnail view of the book and listen to the narration before exporting; do not load every illustration or full-size screenshot into agent context:

```bash
node $SKILL/scripts/static-server.mjs --project "$PROJECT" --story <id>
```

It serves the prebuilt reader and that story's page documents, audio and timeline from a plain
`node:http` server, prints a URL and stays up until interrupted. **No app scaffold is needed** —
this is the same server the exporter and `qa_browser.mjs` start, so what you see is what the MP4
will contain. `--port <n>` picks a fixed port when the default ephemeral one is inconvenient.

Reader QA in a real browser:

```bash
node $SKILL/scripts/qa_browser.mjs --project "$PROJECT"
```

It starts the bundled reader (or uses an explicit `--url`) at 1366×768 and 844×390, waits for `bookDemo.ready`, fails on any
failed request or HTTP 4xx/5xx, checks that every `<img>` really decoded, captures one screenshot
per sheet into the story's `qa/screenshots/`, and writes `qa/browser-check.json`. The story id and
sheet count come from the selected story’s `content.js`, never from a hardcoded value. If the page
exposes no `window.bookDemo`, it says so rather than passing silently.

QA must cover: left/right order, no speech during turns, pause/resume (including mid-turn), manual cancellation, stale content rejection, missing credentials without network calls, actual image loading, deterministic re-rendering, MP4 codec/frame count, audio/video duration and audible timing. Review 1366×768 and 844×390. Record which endpoint produced the speech — the official OpenAI API, a relay, a local MOSS-TTS server reached through the OpenAI-compatible API, mocked API audio, or fixture tones — and never conflate them. The provenance is in `timeline.tts.endpoint`.

Output directories are enforced: audio stays in the selected story audio/, video in video/, and verification reports in qa/. Use an isolated temporary project with the same layout for unit tests.
