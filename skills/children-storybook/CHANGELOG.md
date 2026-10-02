# Changelog

The version of this skill is the one line in [`VERSION`](VERSION). A `VERSION` file is used
rather than a `version:` field in `SKILL.md` frontmatter, deliberately:

- Claude Code does not have a `version` field and **silently ignores** unknown frontmatter
  keys, so a top-level `version:` would look like it worked.
- The strict packagers (claude.ai upload, the Skills API, `package_skill.py`) accept only
  `name`, `description`, `license`, `compatibility`, `metadata` and `allowed-tools`, and
  **fail hard** on anything else: `Unexpected key(s) in SKILL.md frontmatter`.
- Other hosts differ again — Hermes documents a `version` frontmatter field it does read.

One field, three behaviours, one of them silent: a plain file avoids the question entirely and
every host can read it. `scripts/where.mjs` reports it, so an installed copy can say which
version it is.

**Bump policy** (semver, and the CHANGELOG's newest heading must match `VERSION`):

| | When |
| --- | --- |
| **MAJOR** | a contract other things depend on changes — timeline format, an output path, a flag removed or renamed, a script's JSON shape |
| **MINOR** | a capability is added without breaking anything — a new flag, a new check, a new output field |
| **PATCH** | fixes, wording, docs — nothing anyone could have depended on |

Bumping `VERSION` and adding the entry here are part of the change, not a follow-up. The
`tests/script-entry.test.mjs` suite fails if `VERSION` and the newest heading disagree.

## [1.3.1] — 2026-10-02

- Fix `publish_bundle.mjs` reporting a false “H1 clipped” failure on every cover when the CJK font's
  ink extends past a tight line box (PingFang SC does). The fit loop and clip check now allow a
  quarter-em of glyph-box slack, so a real overflowed line is still caught but normal font metrics
  are not.
- Stop pulling the composed document back through `Runtime.evaluate` to persist fitted sizes. With a
  multi-megabyte embedded cover that `returnByValue` round-trip exceeded the 60 s deadline; fitted
  sizes are now returned as numbers and reapplied by `coverHtml`, which is faster and bounded.

## [1.3.0] — 2026-09-30

- Complete the normal MP4 skill workflow with a local publishing kit: 9:16, 16:9 and 3:4 covers, plus distinct titles, tags and short descriptions for 抖音、小红书 and B 站.
- Add dependency-free `publish_bundle.mjs`, composing existing original art with agent-written copy through the bundled Chromium driver. Include editable layouts, structured/copy-ready metadata and a bounded combined preview with automated layout checks.
- Add `--publish-copy` to the exporter and narration wrapper; run composition only after MP4 validation, preserve successful video on kit failure, and support independent retries and new kit versions.
- Keep publishing assets story-local, reject fixture/stale video input, and record video/art/copy hashes. Add a video hash to export reports. No account access, upload or paid generation is introduced.

## [1.2.0] — 2026-09-30

- Replace exhaustive image inspection with one sampled thumbnail sheet. Trust image generation, accept approximate character/style consistency and avoid minor-detail correction loops.
- Add `preview_art.py`: local ffmpeg sampling of up to four images, one JPEG capped at 960×640 and 250,000 bytes, story-local output and text-only tool results.
- Keep original artwork out of agent context, including base64 and embedded-image SVG text. Preserve full-quality inputs for generation, composition and export.
- Align art, layout and delivery guidance with sampled visual review while retaining automated loading/navigation checks. No per-reference visual approval gate.

## [1.1.0] — 2026-09-30

- Wait for image reference dependencies before launching pages with concurrent workers; block dependants of failed references and reject dependency cycles before generation.
- Track image input/output provenance, report stale or manually modified assets, and add selective `--refresh-stale`. Preserve overwritten artwork and provenance in story-local backups.
- Isolate TTS cache entries by normalized speech endpoint, request and optional voice fingerprint. Legacy entries remain on disk but are not reused because their endpoint is unknown; the first v2 run generates fresh clips.
- Make `narrate --plan` offline, treat unsupported metadata routes as inconclusive preflight warnings, and add repeatable `--refresh-page` for standard-body single-page retakes. Seed flags remain optional endpoint extensions.
- Route the skill by requested task, remove stale scaffold requirements and host-specific substitution examples, and separate endpoint operation from the portable story pipeline.
- Add offline regression coverage for dependency scheduling, provenance refresh/backup, endpoint isolation, planning and selective speech refresh.

## [1.0.0] — 2026-09-28

First stamped release. Everything before this was unversioned, so this entry records the whole
review that produced the first number rather than a delta from an earlier release.

### Fixed — output that leaves the machine

- **The exported video's AI disclosure was a brand name.** `prepare_narration.mjs` wrote
  `儿童童话英语屋` into `timeline.disclosure`, which is burned into the MP4, its `comment`
  metadata and the export report — while `references/narration-video.md` required a clear
  AI-generated disclosure. The reader's own export footer had the same string as its fallback.
  The default is now a real disclosure, `AI-generated narration (synthetic voice)`, configurable
  with `--disclosure` / `OPENAI_TTS_DISCLOSURE`; the reader and the builder share one constant
  in `media-core.mjs`. Fixture audio keeps its fixed `Timing test · tones, not narration` label,
  which is deliberately not configurable.

### Fixed — silent failure

- **A symlinked CLI did nothing and reported success.** The entry-point check compared
  `import.meta.url` with `path.resolve(process.argv[1])`, which does not resolve symlinks —
  while `references/project-setup.md` recommends installing the skill as one. `narrate.mjs`,
  `prepare_narration.mjs`, `export_video.mjs`, `shot_pages.mjs` and `qa_browser.mjs` exited 0
  with no output and no error. Added `isMain()` in `project.mjs`, which resolves both sides
  through the filesystem.

### Fixed — wasted money

- **`gen_art.py` discarded a paid image when `art/` did not exist.** The directory is now created
  before the first request and again immediately before each write, so a missing folder can no
  longer be what loses an image that was already generated.
- **A truncated response body killed the whole batch.** `http.client.IncompleteRead` inherits
  from `HTTPException`, not `OSError`, so it escaped the retry tuple and propagated out of the
  worker pool. It is now classified as a connection error and retried. Unexpected errors are
  also contained: one broken asset is reported and the rest of the batch continues.
- **Single-page re-record did not exist.** The documented advice was wrong twice over: deleting a
  cache file re-runs a deterministic server into byte-identical audio, and changing the preset's
  `seed` invalidates every clip at once because it feeds the fingerprint. Added request-level
  `--seed` and `--page-seed <page-id>=<n>`; the seed enters the request body, so it is part of
  that page's cache key and one page costs one generation.
- **Clips were assembled with no level matching.** Eighteen independently generated clips had
  nothing making them agree on a level, so one page could sit 6 dB under its neighbours.
  Every clip is now measured over its speech (−50 dBFS gate) and scaled toward −20 dBFS RMS,
  never past a −1 dBFS peak ceiling and never by more than ±12 dB. `--no-normalize` turns it off;
  `timeline.loudness` and `timeline.clips[].gainDb` record what was applied. The cache still
  holds the endpoint's raw audio, so retargeting the level does not invalidate it.

### Fixed — silent capability downgrade and false verification

- **`narrate.mjs --check` did not report a fallen-back voice.** A server that answers
  `ref_audio_ok: false` for a preset that declares a reference WAV has quietly dropped to its
  base voice. `--check` printed a fingerprint and a check mark. It now reports the reference
  explicitly and stops the run, with `--allow-fallback-voice` as the deliberate override. A
  preset that declares no reference audio reports the same flag and is correctly not treated
  as a downgrade.
- **`--verify` could verify the wrong endpoint.** Given an asset whose declared reference images
  do not exist yet, it silently fell back to `/images/generations` and reported success for a
  path the pages never use. It now refuses, states which references are missing, and suggests a
  free `--probe` or naming an asset without references.
- **Contract verification had no cheap path.** Added `--probe`: one `GET /models`, no generation,
  no cost. Documentation no longer presents a verified contract as general — it is scoped to the
  provider, model and date it was run against.

### Fixed — friction

- **No command previewed the book.** `static-server.mjs` exported `serveStory` but had no entry
  point, so a project without an app scaffold had no one-line preview. It now takes
  `--project/--story/--port/--title`, prints a URL and stays up until interrupted — the same
  server the exporter and browser QA use.
- **Failures were bare Python tracebacks.** `gen_art.py` reports a missing directory, an
  unwritable path or an unreachable endpoint as an actionable `Error: …` and keeps tracebacks for
  actual bugs.
- **"Output exists; choose a new --name" named neither the output nor the cost.** It now prints
  the full path and says the rename is free, because unchanged clips come from a content-addressed
  cache.
- **`where.mjs` conflated "no app scaffold" with "no story"**, which read as a missing story in a
  project that never had one. It now says which thing is missing. Its `--project` flag, advertised
  in its own output, was being ignored; it is now honoured.

### Added

- `VERSION` and this changelog, plus version reporting in `where.mjs`.
- `tests/script-entry.test.mjs`: symlink entry-point regression tests (including one that fails
  against the old guard), `--project` handling, and the `VERSION`/changelog agreement check.
- Regression tests for the narration and image-generation fixes.
