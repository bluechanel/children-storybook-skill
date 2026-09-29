# Goldilocks and the Three Bears — runnable reference

A complete, offline-buildable story package used to exercise this skill end to end. It is a
**skill fixture**: never point the host app's `src/active-story.js` at it, and never copy it in
place of a story you are actually working on. (Compare `skills/children-storybook-workspace/`,
which holds evaluation runs rather than a reference story.)

## What is original and what was recovered

The story's source folder was lost. Everything here was rebuilt from build output, so be
precise about provenance:

| File | Provenance |
| --- | --- |
| `story.md` page text | **Verbatim.** Recovered from the narration timeline's `contentKey`, which records the text that was actually typeset and read aloud. |
| `art/*.jpg` | **Re-encoded.** The base64 inside each composed page SVG is the original 1536×1024 generation output; these are ffmpeg JPEG re-encodes of it, so they are lossy copies, not the generation originals. |
| `prompts/*.txt` | **Reproduced.** Regenerated from `characters.md` + `scenes.md`, which were derived from the original prompt-generator constants. Byte-for-byte identical to the prompts used for the real run. |
| `characters.md`, `scenes.md` | **Derived** from those same constants. |
| `manifest.json` | **Re-authored.** The page text is verbatim; the 11 spread `theme` labels were not recoverable and were written fresh. |
| `storyboard.md` | **Re-authored** from the same spread plan. |

Nothing here claims to be the unrecoverable original file. `scripts/recover_example.py`
performs the mechanical part of this recovery and can be pointed at any built story.

## Build it

`$SKILL` below is this skill's directory — the folder containing `SKILL.md`. Run these from
the project root.

```bash
# 1. Copy it into the project as a real story.
mkdir -p stories
cp -R "$SKILL/examples/goldilocks" stories/goldilocks-and-the-three-bears-v1

# 2. Validate, then compose the pages. The manifest sits at stories/<id>/manifest.json,
#    which is the layout the default rule expects, so no extra flags are needed.
python3 "$SKILL/scripts/build_book.py" \
        stories/goldilocks-and-the-three-bears-v1/manifest.json --check
python3 "$SKILL/scripts/build_book.py" \
        stories/goldilocks-and-the-three-bears-v1/manifest.json --build v1

# 3. Render the composed pages to PNG for a visual check. Needs a browser, nothing else.
node "$SKILL/scripts/shot_pages.mjs" --story goldilocks-and-the-three-bears-v1
```

`--check` reports `ready_to_build: true` offline because the artwork ships with the example —
no API key is needed to build and inspect the book.

## Regenerate the prompts

`prompts/` is generated. Edit `characters.md` or `scenes.md` and rerun:

```bash
python3 scripts/gen_prompts.py --story examples/goldilocks --check   # show drift only
python3 scripts/gen_prompts.py --story examples/goldilocks           # write
```

## Regenerate the artwork

Needs `OPENAI_API_KEY` in the host project's `.env.local`. This makes 26 paid image requests.

```bash
python3 scripts/gen_art.py --story examples/goldilocks --dry-run   # plan and reference order, no network
python3 scripts/gen_art.py --story examples/goldilocks             # reference sheets first, then pages
```

The reference sheets (`ref-goldilocks`, `ref-bears`) are generated first because every page
prompt cites them; `gen_art.py` refuses to run a page whose references are missing.
