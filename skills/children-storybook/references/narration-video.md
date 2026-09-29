# Narration, synchronized playback, and MP4

Use this workflow when narration/video is requested. If the user says to reserve the TTS interface for later configuration, implement/configure the plan only; do not use an available key to make live calls. Never substitute another provider or system voice silently.

Read [story-layout.md](story-layout.md) first. All commands below operate on the story selected in src/active-story.js.

> **No npm install is needed.** The narration builder and the exporter need only node,
> python3, ffmpeg/ffprobe and a Chromium-based browser. The reader ships prebuilt as
> `renderer/book.js`, `export_video.mjs` serves it from a plain `node:http` server, and frames
> are captured over the DevTools Protocol (`cdp.mjs`) — there is no Vite and no Playwright in
> this path. See [project-setup.md](project-setup.md).
>
> All of these resolve `--project`, then `$PROJECT`, then the working directory, and
> read `.env.local` from there, so they work installed globally and invoked by absolute path.
> The story is read from its own `content.js`; `src/active-story.js` is consulted only to learn
> which story is active.

## Architecture and sources

- TTS (single interface): the local Node script calls `POST {base}/audio/speech` with the OpenAI schema — `model`, `voice`, `input`, `response_format: 'wav'`, `speed`, and `instructions` for non-legacy models. Defaults `gpt-4o-mini-tts`, `marin`, speed 0.9. Read exact page text, including cover and ending.
- Endpoint: `OPENAI_TTS_BASE_URL` → `OPENAI_BASE_URL` → `https://api.openai.com/v1`. Credential: `OPENAI_TTS_API_KEY` → `OPENAI_API_KEY`. The TTS variables are deliberately separate because `OPENAI_BASE_URL` is the *Images* base used by `gen_art.py` — repointing it would silently redirect image generation too. A bare host is completed for you (`http://127.0.0.1:8123` → `…/v1`).
- TTS (local, offline): `moss-tts` — a **separate project**, not part of the host — serves the same OpenAI contract on `127.0.0.1:8123` in front of MOSS-TTS (mlx-audio, Apple Silicon). Point `OPENAI_TTS_BASE_URL` at it; nothing in this skill knows about MLX, model paths or voices, and no credentials or network are needed. Voice tuning — a reference WAV for zero-shot cloning, language, seed, sampling — lives in that server's `voices.json`, selected by the OpenAI `voice` field. See that project's README.
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
- `export_video.mjs`: validate assets/timeline, start isolated local Vite preview, await images/fonts, render frames, encode and verify MP4.
- `verify_fixture_audio.mjs`: decode the exported fixture and check that tone slots are audible and gaps/turns are silent; never treats this as speech-quality validation.

Existing frontend integration:

- `stories/<id>/narration.js` exports `{url:null}` until real narration is installed; src/narration.js re-exports the selected story.
- `src/narration-player.js` loads/validates timeline and master hash, uses a Web Audio clock, handles pause/resume and cancellation.
- `src/main.js` exposes `window.bookDemo.ready`, `setExportTimeline(timeline)`, `renderAt(seconds)` in `?export=1` mode. Frames are computed directly from time; seeking backward then forward gives the same picture. Preserve this contract if adapting the scaffold.
- `index.html` / `src/style.css` provide conditional status, AI disclosure and clean export layout.

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

**Against a local MOSS-TTS server (offline, Apple Silicon):** the `moss-tts` project runs the same contract, so only the endpoint changes. It lives outside this project (a sibling directory by default) and owns its own ~9 GB of models and its own `.env.local`.

```bash
cd ../moss-tts
uv sync                          # once: creates .venv with mlx-audio + fastapi
.venv/bin/python server.py       # starts 127.0.0.1:8123 and preloads the model
```

It keeps the model resident, so the ~50 s load is paid once at startup instead of once per run.

then in **this** project's `.env.local`:

```bash
OPENAI_TTS_BASE_URL=http://127.0.0.1:8123/v1
OPENAI_TTS_API_KEY=local                               # the local server accepts any token
OPENAI_TTS_VOICE=narrator                              # must name a preset in that server's voices.json
```

`narrate.mjs` wraps `prepare_narration.mjs` and `export_video.mjs`; it adds an endpoint check, a readable clip summary and a default version name (`audio-YYYYMMDD-HHMM`) when `--name` is omitted. Flags: `--name`, `--voice`, `--speed`, `--model`, `--seed`, `--page-seed`, `--disclosure`, `--plan`, `--check`, `--install`, `--video`, `--output <mp4>`, `--allow-fallback-voice`. CLI overrides set the same `OPENAI_TTS_*` variables `.env.local` uses, so either place works. Anything endpoint-specific — reference audio, language, sampling — is set in the server's `voices.json`, not here; `--seed`/`--page-seed` are the one exception, and they exist for re-recording (see below).

`--check` reports the endpoint, credential, models, the selected voice's fingerprint **and whether the server is actually using that voice's reference audio**. A server that reports `ref_audio_ok: false` has silently fallen back to its base voice, so the run stops with an error rather than spending money on clips that are not the voice that was asked for; `--allow-fallback-voice` proceeds anyway. That is the difference between "the endpoint works" and "the endpoint will produce what you asked for".

Voice: which voice you get is the endpoint's business. Against MOSS-TTS an unlisted `voice` name is an error listing the valid presets; its shipped `default` preset needs no reference audio. To clone a narrator, put 5–15 s of clean single-speaker speech at any sample rate in that project's `voices/` directory and reference it from a preset — keep reference WAVs there or in your own config, never inside a story folder, and do not use a real person's voice without their permission.

Regenerating one page — the case where one clip misreads a name. Use a **request-level seed**, which the builder puts into that page's request body:

```bash
node $SKILL/scripts/narrate.mjs --project "$PROJECT" --name v2 --page-seed page-14=7
```

Because the body is what the cache hashes, only that page's cache key changes: it is re-synthesized and the other clips are reused from `audio/.cache/`, so one page costs one generation. `--seed <n>` does the same for every page at once (a new take on the whole book). A page id is the id used in `timeline.json` — `cover`, `page-01` …, `back`; a name that is not in the book is rejected rather than silently doing nothing.

The other two routes do **not** work, which is why this flag exists:

- **Deleting a cache file** does not force a new take. The cache file is named `<request-hash>[.<preset-fingerprint>].wav`, and deleting it simply re-runs a deterministic server into the same bytes — the same text, voice and seed give the same audio. Delete it only to recover from a corrupt file.
- **Changing the preset's `seed` in the server's `voices.json`** invalidates **every** clip, not one: the preset feeds the fingerprint, which is part of every cache filename.

Neither route needs a new `--name` to save money, incidentally — a new name is free, because a name that does not exist yet builds from the same content-addressed cache.

Fallback order when generation is unavailable: `--check` reports exactly what is missing (unreachable endpoint, rejected credential, no ffmpeg, or a server that is still loading). Do not start or download a local model server on the user's behalf without asking; the models are large. Otherwise validate the pipeline with labeled test tones (`narration:fixture`) and say plainly that no speech was produced.

Generation speed on an M-series laptop with the 8-bit model: first load ~50 s when the server starts, then roughly 1.5× real time per clip; a six-page book takes about a minute.

Planning writes `stories/<id>/audio/requests.json` with exact inputs and parameters, without calling any endpoint. Credentials are not needed for planning or local fixtures. The default app remains a clearly labeled silent flip demo until real narration is installed. If the user says to reserve the interface, stop at planning.

## Underlying commands and output contract

```bash
npm run narration:plan                                       # plan only; no network
npm run narration:generate -- --name red-audio-v1 --install   # generate through the configured endpoint
```

Output: `stories/<id>/audio/<name>/`, containing per-page WAVs, `master.wav`, `timeline.json`, and `requests.json` (provider, the resolved base endpoint, exact per-page request bodies, hashes, the preset fingerprint, the seeds used and the disclosure). Each clip is 48 kHz mono PCM16; a response that already is that format is used as-is, otherwise it is normalized through ffmpeg. **Clips are level-matched before assembly**: each one is measured over its speech (a −50 dBFS gate, so silence is not counted as content) and scaled toward −20 dBFS RMS, never past a −1 dBFS peak ceiling and never by more than ±12 dB — a page 6 dB under its neighbours is a property of generating eighteen clips independently, not bad luck, and it lands in the master otherwise. The per-clip gain is in `timeline.clips[].gainDb` and `timeline.loudness`; `--no-normalize` (or `OPENAI_TTS_NORMALIZE=0`) turns the pass off. Durations use actual PCM sample counts, not word-count estimates or guessed speaking speed. Cache keys include the exact input and every generation parameter in the body (model, voice, speed, instructions, and any `--seed`/`--page-seed`) plus, when the endpoint offers `GET /v1/voices`, a fingerprint covering the voice's effective tuning and reference-audio bytes — so editing a preset invalidates the cache even though the body is unchanged. The cache stores what the endpoint returned, *before* level matching, so retargeting the loudness never invalidates it. Successful clips survive a later failure; rerun explicitly to reuse them. There are no automatic paid retries. A new output name prevents overwriting finished work — and is free when the clips have not changed, since the cache is content-addressed. `timeline.tts` records `provider: "openai-compatible"`, the base `endpoint`, model, voice, speed, instructions, the seeds and the preset fingerprint — never a credential.

`--install` updates `stories/<id>/narration.js`, saving its prior configuration in backups/. Audio stays in audio/<version>/ and is served by the Vite plugin; no duplicate public/ copy is created. Generated story assets remain together for management; only caches, temporary files and .env files are gitignored. Listen to every generated clip before delivery.

Missing credential, failed requests, changed story, missing WAVs, invalid durations or hash mismatches are errors. Do not silently fill missing speech with silence or call an incomplete narration ready. Changing text requires rebuilding audio. Changing page image URLs also invalidates the content fingerprint; rebuilding reuses unchanged speech cache entries. Replacing image bytes at an unchanged URL does not invalidate narration because the words/page order are unchanged; the next export loads the current artwork, so visually recheck it. Changing a server-side voice preset does invalidate the cache, via the fingerprint.

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

Look at the book, and listen to the narration against it, before exporting:

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

It loads the running dev server at 1366×768 and 844×390, waits for `bookDemo.ready`, fails on any
failed request or HTTP 4xx/5xx, checks that every `<img>` really decoded, captures one screenshot
per sheet into the story's `qa/screenshots/`, and writes `qa/browser-check.json`. The story id and
sheet count come from the project's `content.js`, never from a hardcoded value. If the page
exposes no `window.bookDemo`, it says so rather than passing silently.

QA must cover: left/right order, no speech during turns, pause/resume (including mid-turn), manual cancellation, stale content rejection, missing credentials without network calls, actual image loading, deterministic re-rendering, MP4 codec/frame count, audio/video duration and audible timing. Review 1366×768 and 844×390. Record which endpoint produced the speech — the official OpenAI API, a relay, a local MOSS-TTS server reached through the OpenAI-compatible API, mocked API audio, or fixture tones — and never conflate them. The provenance is in `timeline.tts.endpoint`.

Output directories are enforced: audio stays in the selected story audio/, video in video/, and verification reports in qa/. Use an isolated temporary project with the same layout for unit tests.
