# Project instructions

## Scope

This repository is about the storybook skill and the flipbook app. It does not own TTS inference: the local MOSS-TTS server lives in a **separate project**, `moss-tts` (a sibling directory by default), which serves an OpenAI-compatible `/v1/audio/speech` API. Narration here reaches it purely over HTTP through `OPENAI_TTS_BASE_URL` / `OPENAI_TTS_API_KEY`; nothing in this repository imports, requires or vendors it, and there are no `tts/` paths or `npm run tts:*` scripts here. Do not reintroduce that coupling or add MOSS-specific flags, providers or env vars to the skill — it must work against any OpenAI-compatible endpoint.

## Project skill

`children-storybook` is a project-local skill at `skills/children-storybook/SKILL.md`.

When the user asks to turn a story outline into an illustrated English children's book and populate this project's flipbook, read and follow that skill. It covers story development, age-appropriate English, thematic spreads, illustration generation, page composition, and integration. Also use its narration-video reference for page narration, sound-picture synchronization, and MP4 export requests. Do not apply it to UI-only changes or translation-only requests.

All content belonging to one story must live in `stories/<id>/`, including art, page versions, audio, video, QA and backups. Follow `skills/children-storybook/references/story-layout.md`. Do not create duplicate source content in `public/stories`, `public/narration`, root `exports` or a shared `stories/narration`. `src/active-story.js` selects the story; dist is generated output.

The flipbook reader itself lives in the skill, at `skills/children-storybook/renderer/src/`. `src/main.js` only supplies the story and calls `mount()`; do not move the rendering code back into `src/`, and do not add a second copy — the exported video and the dev page must render from the same source. `renderer/book.js` is a committed build artifact: after editing anything under `renderer/src/`, run `npm run build:renderer`, and keep `npm run test:skill` green.

Skill users need only node, python3, ffmpeg/ffprobe and a Chromium-based browser. Do not add a runtime dependency on vite, Playwright or any npm package to the skill's scripts; they are development-time tools for this repository only.

The skill must stay host-neutral so another agent can install it. Scripts locate themselves and resolve the project through `--project`, then `$CHILDREN_STORYBOOK_PROJECT`, then `$CLAUDE_PROJECT_DIR`, then the working directory — never through a Claude-only name alone. In documentation use the `$SKILL` / `$PROJECT` placeholders, not `${CLAUDE_SKILL_DIR}`: that one is a Claude Code text substitution, not a real variable, and other hosts would see it literally. `node skills/children-storybook/scripts/where.mjs` reports what resolved.

Keep the skill and its supporting scripts in this repository. This repository is the **development**
copy and the single source of truth. `~/.agents/skills/` is the **production** installation that
other agents and other projects read, and **nothing here deploys to it**: never write, copy, delete
or re-link anything under `~/.agents/skills/`, and never touch the `~/.claude/skills/*` symlinks
that point into it. Deployment is a manual step the owner performs; a change is finished when it
lands here, passes here, and is reported — not when it has been pushed at the installed copy.
That also means the installed copy being behind is the normal state, not a fault to repair.

Do not edit through the global path. Evaluation artifacts live separately in `skills/children-storybook-workspace/` and should not replace the app's content; `skills/children-storybook/examples/` holds a runnable reference story that `src/active-story.js` must never select.

The skill carries its own version: the one line in `skills/children-storybook/VERSION`, with the
entry in its `CHANGELOG.md`. Bumping both is part of a change, not a follow-up —
`npm run test:skill` fails when the two disagree, and `scripts/where.mjs` reports the version so
an installed copy can say which one it is. A `version:` field in `SKILL.md` frontmatter is
forbidden: Claude Code ignores unknown frontmatter silently while the strict packagers reject it,
so it would pass every check here and fail on publication.

<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.
<!-- CODEGRAPH_END -->
