# Requirements, and what the skill needs from a host project

## What a user has to install

Four things, and nothing else — **no `npm install` anywhere**:

| | Why |
| --- | --- |
| **node** 22+ | every script; 22 is the floor for the built-in `WebSocket` the exporter uses |
| **python3** | prompt generation, artwork generation, page composition |
| **ffmpeg** + **ffprobe** | MP4 encoding and verification |
| **a Chromium-based browser** | Chrome, Chromium, Edge or Brave — the book is WebGL and needs a real browser to render |

`cdp.mjs` finds the browser automatically (`--chrome`, then `CHROME_PATH`, then the usual
install locations and `PATH`), and on failure lists every path it tried. The reader itself is
committed prebuilt as `renderer/book.js`, so there is no bundler to run.

Rebuilding that bundle is a **development** step and does need `vite` and `three`
(`node renderer/build.mjs`). A user of the skill never runs it.

## What runs where

**Needs only a story folder** — no app, no dependencies:

| Script | Needs |
| --- | --- |
| `gen_prompts.py` | `characters.md` + `scenes.md` |
| `gen_art.py` | `OPENAI_API_KEY` (only when actually generating) |
| `build_book.py` | the manifest and its artwork |
| `recover_example.py` | a built story in `dist/` and ffmpeg |
| `export_video.mjs` | the story's `content.js` and its timeline — that is all |
| `static-server.mjs` | the story's `content.js` — run it to preview the flipbook in a browser |
| `shot_pages.mjs`, `qa_browser.mjs` | the story's page documents / `content.js` |

`static-server.mjs` is the one command that shows the finished book, and it needs no app and no
dev server:

```bash
node $SKILL/scripts/static-server.mjs --project "$PROJECT" --story <id>
```

The story is passed to the reader as an argument, so none of these read the app's `src/`.
`resolveBook()` prefers the story's own `content.js`, consults `src/active-story.js` only to
learn *which* story is active, and falls back to the sole story present.

**Drives the host application** — these still assume the reader's contract:

| Script | Needs |
| --- | --- |
| `narrate.mjs`, `prepare_narration.mjs` | the story's `content.js`; a reachable OpenAI-compatible TTS endpoint (`OPENAI_TTS_BASE_URL` / `OPENAI_TTS_API_KEY`) |
| `qa_browser.mjs --url <dev server>` | a host dev server exposing `window.bookDemo` |

The contract below lives in `renderer/src/book.js`, so a host using this skill's reader gets it
for free. A host with its own renderer must provide it.

Copying the narration and export CLIs into an unrelated site will not add narration to it. The
frontend contract is the part that has to exist first.

## Locating things

This skill does not depend on any agent host's conventions.

Scripts derive the **skill root** from their own file location, so it is correct wherever the
skill is installed — `skills/children-storybook/`, `~/.claude/skills/children-storybook/`,
`~/.agents/skills/children-storybook/`, anywhere. No environment variable is needed, and none
is read for this purpose.

They find the **project root** in this order:

```
--project <dir>
  → $CHILDREN_STORYBOOK_PROJECT     (this skill's own neutral name; any host can set it)
  → $CLAUDE_PROJECT_DIR             (what Claude Code exports for its Bash tool)
  → the working directory
```

`$CHILDREN_STORYBOOK_PROJECT` comes first so a host that knows nothing about Claude Code can
configure the skill with a name that is obviously ours. Running from the project root needs
neither variable.

To find out what actually resolved, run:

```bash
node "$SKILL/scripts/where.mjs"          # or --json
```

`.env.local` is read from the project root by every entry point, so a globally installed script
invoked from anywhere still sees the project's configuration. An already-set variable always
wins, so `npm --env-file` and an explicit `export` are never overridden.

## The story folder

Stories live in `stories/<id>/` by default. Only the **filesystem** location is configurable, via
`STORYBOOK_STORIES_DIR`; `story-paths.mjs` and `story-assets.mjs` read the same variable, so they
cannot disagree.

The URL prefix `/stories/<id>/` is deliberately **not** configurable. It is a fixed contract
shared by `build_book.py`'s generated image URLs, `story-assets.mjs`'s middleware and allowlist,
and the relative import in `src/active-story.js`. Change one and you must change all three.

`build_book.py` requires the manifest to sit at `<stories>/<id>/manifest.json`. Pass `--project`
or `--story-dir` to build a story kept somewhere else — the escape hatch is explicit so the
default stays predictable for the app and its tests.

## Making the skill reachable from the project

This section is about the **dev server only**. Exporting a video, rendering pages and browser
QA all go through the skill's own static server, so they never need the app to resolve
anything. But a project that runs `npm run dev` does: the app mounts the skill's reader
(`src/main.js` imports `renderer/src/book.js`) and `vite.config.js` imports
`story-assets.mjs`.

The verified arrangement is a symlink:

```bash
# In the project root. The skill keeps its single source of truth elsewhere.
mkdir -p skills
ln -s "$SKILL" skills/children-storybook
```

A copy works too, at the cost of drifting from the original. Either way the import specifier in
the app stays the same, which is why this is the recommended arrangement.

A symlinked install is also fine for **every CLI in this skill when invoked directly**, which is
worth stating because it is easy to get wrong: the scripts decide whether they are the entry point
by resolving both their own path and `argv[1]` through the filesystem (`isMain()` in `project.mjs`),
not by comparing the strings. A raw string comparison treats `skills/children-storybook/scripts/x.mjs`
and `~/.claude/skills/children-storybook/scripts/x.mjs` as different files, and the script then exits
0 having printed nothing and done nothing — a failure that reads as success. If you add a script
here, use `isMain(import.meta.url)`; `node --test tests/script-entry.test.mjs` fails if anything
under `scripts/` goes back to comparing raw paths.

For a project with no skill directory at all, resolve the Vite plugin explicitly instead — but
note the app's own import still has to be changed to match:

```js
// vite.config.js
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { defineConfig } from 'vite';

const skill = process.env.CHILDREN_STORYBOOK_SKILL || path.resolve('skills/children-storybook');
const { storyAssets } = await import(pathToFileURL(path.join(skill, 'scripts/story-assets.mjs')).href);

export default defineConfig({ plugins: [storyAssets(process.cwd())] });
```

npm scripts can use the same override while keeping the in-repo path as the default:

```json
"narrate": "node --env-file-if-exists=.env.local ${CHILDREN_STORYBOOK_SKILL:-./skills/children-storybook}/scripts/narrate.mjs"
```

## The frontend contract

The exporter drives the real reader, so the app must expose these on `window` in `?export=1` mode
(see `src/main.js`):

| Member | Meaning |
| --- | --- |
| `bookDemo.ready` | a promise that resolves once every page image has loaded |
| `bookDemo.setExportTimeline(timeline)` | accept a validated timeline before rendering |
| `bookDemo.renderAt(seconds)` | draw the book at an absolute time, with no dependence on wall-clock waits, damping history or a running audio clock |

`renderAt` must be a pure function of the time argument — seeking forward then back must produce
the same picture, because the exporter renders frame *n* at `n/fps` in order and compares nothing
else. `qa_browser.mjs` needs the same `bookDemo.ready`.

## Optional local TTS

A separately managed local service can expose the same OpenAI-compatible speech interface.
Set `OPENAI_TTS_BASE_URL` and `OPENAI_TTS_API_KEY` to that service and select its supported
`voice`. This skill does not install models, configure server-side voice presets or require
another project’s files. See the service’s own documentation for those operations.

Without a reachable endpoint, prepare an offline narration plan or validate the pipeline with
labeled fixture tones. `--check` can inspect optional metadata but only a speech request and
listening can validate actual output.

## Platform notes

The command examples use POSIX shell syntax on macOS and Linux. Windows is untested — set `$env:CHILDREN_STORYBOOK_PROJECT`, pass `--project` explicitly, and
invoke the scripts by absolute path.
