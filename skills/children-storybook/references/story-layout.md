# One folder per story

All content specific to a story belongs under `stories/<id>/`. The folder name equals `manifest.json`'s `id`; use a lowercase slug. This is a project requirement, not an optional output convention.

```text
stories/<id>/
  manifest.json           story metadata, exact text, relative original-art paths
  story.md                manuscript and brief
  storyboard.md           thematic page plan
  characters.md           character and style definitions
  prompts.md              actual image prompts and provenance
  content.js              active page data; includes storyId
  narration.js            selected real narration URL, initially null
  art/                    original generated images
  pages/<version>/        composed SVG pages and content.js version snapshot
  audio/<version>/        per-page WAVs, master.wav, timeline.json, requests.json
  audio/.cache/           reusable TTS cache for this story only
  audio/requests.json     non-generating TTS plan
  video/                  exported MP4s and export metadata
  qa/                     reports, screenshots, decoded test audio
  backups/                earlier active content/narration configuration
  archive/                preserved legacy packages, when needed
```

Version pages/audio/video inside the same story folder. Avoid creating another top-level story folder for each rendering run. A different story receives a different ID.

## Where the stories folder is

`stories/` is the default. Only its **filesystem** location is configurable, through
`STORYBOOK_STORIES_DIR`; `story-paths.mjs` and `story-assets.mjs` read the same variable so they
cannot disagree. The `/stories/<id>/` URL prefix is a fixed contract — it is shared with the
image URLs `build_book.py` writes, the plugin's middleware and allowlist, and the relative import
in `src/active-story.js`. Do not make the prefix configurable; change all three call sites
together if it ever must move.

Command-line tools find the project through `--project`, then `$CHILDREN_STORYBOOK_PROJECT`, then `$CLAUDE_PROJECT_DIR`, then the
working directory. See [project-setup.md](project-setup.md).

`skills/children-storybook/examples/` holds a runnable reference story. It is a **skill fixture**:
it lives outside `stories/`, `src/active-story.js` must never select it, and it is not app
content. That is a different thing from `skills/children-storybook-workspace/`, which holds
evaluation runs.

## Shared app and runtime resources

`src/active-story.js` is the single selected-story pointer and re-exports both bookContent and narrationConfig from one story. `src/content.js` and `src/narration.js` only re-export that pointer. Select a story by changing the two paths together in active-story.js after checking its content/narration files exist.

`vite.config.js` uses the skill's `story-assets.mjs` plugin:

- During development, `/stories/<id>/pages/<version>/*.svg` resolves to the canonical story files.
- Ready audio is served at `/stories/<id>/audio/<version>/master.wav` and `timeline.json`.
- Test audio, caches, prompts, backups, archives, and video files are not published by this route.
- During build, browser-needed page and ready-audio assets are copied to `dist/stories/`. `dist` is disposable build output, not another source directory to maintain.

Do not copy sources into `public/stories`, `public/narration`, root `exports`, or shared `stories/narration`. Do not put API keys in story folders. `.env.local` remains project-local and ignored.

## Enforced output paths

- `gen_prompts.py --story <dir>`: reads `characters.md` and `scenes.md`, writes that story's `prompts/`, `prompts.md` and `ref-map.json`. It never writes outside the story directory.
- `gen_art.py --story <dir>`: writes images into `<story>/art/` and per-asset logs into `<story>/qa/art-logs/`. Reference images are resolved only inside the story directory.
- `build_book.py ... --build v2`: requires `stories/<id>/manifest.json`; writes `pages/v2/`, updates story-local content.js and saves earlier content under backups/. `--output` is accepted only for a direct `pages/<version>` directory. A story kept outside `<stories>/<id>/` needs an explicit `--project` or `--story-dir`; without one it is refused.
- `prepare_narration.mjs` / `narrate.mjs`: use the selected storyId, check its manifest and write into its audio/. `--install` updates that story's narration.js with a backup; neither copies assets into public/. Local TTS models and voice reference WAVs belong to the separate `moss-tts` project, never inside a story folder.
- `export_video.mjs`: accepts timelines only from the selected story's audio/ and output only inside its video/. Default filename is the audio-version name plus .mp4.
- `verify_fixture_audio.mjs`: reads the selected story's audio/video and writes checks to qa/.
- `shot_pages.mjs`, `qa_browser.mjs`: write only into the selected story's `qa/`.
- Story-specific scripts such as demo typography adjustments must also read and write within the story directory.

## Migration and history

Move files rather than discarding them. Preserve old self-contained packages under archive/ when retaining their provenance is useful. Historical reports may retain original paths as evidence of the earlier run; add a migration note instead of silently rewriting their claims. Update active content URLs, current manifests, current audio timeline content keys, scripts, documentation commands, and test screenshot destinations. After moving paths, verify that audio words/order did not change before updating a timeline fingerprint.

Validate with page-builder tests, media tests, browser playback checks, a production build, and one local export when the resource-serving or exporter paths changed. Test fixtures also belong to their test story folder; unit tests may use an isolated temporary project with its own stories/<id>/ layout.
