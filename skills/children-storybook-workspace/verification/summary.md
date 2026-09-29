# Skill verification

- SKILL.md YAML frontmatter parsed successfully with Ruby Psych; name/description checks passed. The skill-creator Python quick validator could not run because PyYAML is not installed.
- Eight helper unit tests passed: physical sheet mapping, XML text escaping, missing-art handling, path traversal/symlink rejection, overflow rejection, invalid image signature, invalid schema, and no-overwrite portable builds.
- Chrome decoded both composed page fixtures, drew them to canvas, found visible text, and exported PNG successfully. Fixture artwork is a solid-color test asset, not generated story illustration.
- Two planning prompts ran both with and without the skill. Both configurations passed all five planning checks. This small comparison does not establish improved writing quality or generated artwork quality.
- Built-in image generation and complete story installation were not exercised in these planning-only tests.
- Generated review.html using the specified skill-creator viewer.
- Global installation was declined at the time. The completed skill remains in the project under skills/children-storybook/.

## Superseded: global installation (2026-09-25)

The user later asked for the skill to be installable and installed globally, so the earlier
decision above is superseded. `install.sh` now links `~/.claude/skills/children-storybook` to
`skills/children-storybook/` in this repository, which stays the single source of truth. See
`references/project-setup.md`.

Portability work done at the same time, verified by `scripts/test_gen_prompts.py`,
`test_gen_art.py`, `test_example_story.py` and a clean-project run (build → prompts → art plan →
24 composed pages → 24 narration clips → a 336-frame MP4 export, all invoked by absolute path
from `/`):

- The ad-hoc scripts that produced the Goldilocks book and video — the prompt generator, the
  three art-batch shell variants and the two QA scripts — are now consolidated into the skill as
  `gen_prompts.py`, `gen_art.py`, `shot_pages.mjs` and `qa_browser.mjs`.
- Prompts are now generated from `characters.md` + `scenes.md` instead of a hardcoded script;
  the regenerated prompts for the reference story are byte-identical to the originals.
- Artwork generation no longer depends on an external Codex CLI; `gen_art.py` calls the OpenAI
  Images API with the standard library only.
- `scripts/project.mjs` resolves the skill directory, the project root and `.env.local`, and
  loads the host's `vite`/Playwright, which a bare `import` from a globally installed skill
  cannot do.
- The reference story ships at `examples/goldilocks/`, rebuilt from build output. Its page text
  is verbatim; its artwork is a lossy JPEG re-encode of the original generation output; its
  spread themes were re-authored because they were not recoverable.

Still not exercised: real paid image generation and real TTS. Artwork and speech *quality* are
therefore unverified — only the orchestration, prompts and paths are.

## Dependency-free export (2026-09-25)

Skill users now need only **node, python3, ffmpeg/ffprobe and a Chromium-based browser** — no
`npm install`. Vite and Playwright are gone from every runtime path.

How: the reader moved into the skill (`renderer/src/`, mounted as `mount({bookContent,
narrationConfig, exportMode})`), is committed prebuilt as `renderer/book.js` (636 KB, Three.js
included), is served by `scripts/static-server.mjs` over `node:http`, and its frames are
captured over the DevTools Protocol by `scripts/cdp.mjs` using node's built-in `WebSocket`.
`project.mjs` no longer loads any host package, and the narration/export scripts read the
story's own `content.js` rather than the app's `src/`.

Verified:

- **Pixel-identical to the previous implementation.** `export_video.mjs` already drove system
  Chrome (not Playwright's bundled Chromium), so a like-for-like comparison was possible:
  671 frames at 640×360@12fps gave **PSNR = inf** against the reference export. All 24
  `shot_pages` PNGs are **byte-identical** to the Playwright baseline.
- **Deterministic**: two exports of the same story/timeline/size produced the same
  `frameDigestSha256` (`1449f69e…`).
- **No host dependencies**: the export project contained only `stories/`, with no
  `node_modules` anywhere up the tree, and the skill's scripts import only `node:` builtins.
- The narration fixture, MP4 export, ffprobe checks and `verify_fixture_audio.mjs`'s 73
  interval checks all pass in that story-only project.
- The Vite dev path still works: `vite build` + `qa_browser.mjs --url` on the built app loaded
  24 page images at both viewports with no failures.

Two limits worth stating plainly. **A browser is still required** — WebGL cannot be rendered
without one, so the real prerequisite list is node + python3 + ffmpeg + a Chromium browser.
And the repo's own e2e suite (`tests/*.spec.js`, `playwright.config.js`, `npm run test:e2e`)
still uses Playwright; that is development-only and never reaches a skill user.

## Host-neutral variables (2026-09-25)

The skill no longer depends on Claude Code's conventions, so another agent host can install
and run it unchanged. Three things were host-specific:

- **`${CLAUDE_SKILL_DIR}`** is a text substitution Claude Code performs while rendering
  `SKILL.md` — it is *not* an exported variable, and any other agent would see the literal
  string. Commands in `SKILL.md` and the references now use a plain `$SKILL` the session
  defines, with the Claude form given as a convenience. Scripts never needed it: they derive
  the skill root from their own file location.
- **`$CLAUDE_PROJECT_DIR`** is genuinely exported, but only by Claude Code. Resolution is now
  `--project` → `$CHILDREN_STORYBOOK_PROJECT` → `$CLAUDE_PROJECT_DIR` → cwd, in both
  `project.mjs` and `env_file.py` so the Node and Python tools agree. The neutral name comes
  first so any host can configure the skill without knowing about Claude Code.
- **`install.sh`** defaulted to `~/.claude/skills`. It now takes `--target <dir>`, then
  `$SKILLS_DIR`, then `$CLAUDE_SKILLS_DIR`, then the first existing of `~/.claude/skills` and
  `~/.agents/skills`.

Added `scripts/where.mjs`, which reports the resolved skill, project, story, browser, ffmpeg
and `.env.local` (and what is missing) without needing to know any of the above.

Verified with **no Claude variables set at all**: from `/` with only
`CHILDREN_STORYBOOK_PROJECT`, and from the project root with no variables whatsoever —
`where.mjs`, `build_book.py`, fixture narration and a 447-frame MP4 export all succeeded. The
`CLAUDE_PROJECT_DIR` path and the neutral-over-Claude precedence were checked separately.
