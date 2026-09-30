# Flipbook integration

## Manifest contract

All paths are relative to the manifest directory. Use a fresh lowercase slug for `id`.

```json
{
  "id": "milo-and-the-moon-v1",
  "title": "Milo and the Moon",
  "age_range": "4-7",
  "cover": {"text": "Milo and the Moon", "art": "art/cover.png"},
  "back_cover": {"text": "The End", "art": "art/back.png"},
  "spreads": [
    {
      "theme": "A Little Light",
      "left": {"text": "Milo sees a little light. It glows under a leaf.", "art": "art/page-01.png"},
      "right": {"text": "Hello, little light! Are you lost?", "art": "art/page-02.png"}
    }
  ]
}
```

The example shows one spread for brevity; default is four. Supply 1–12 spreads. Each page object needs `text` and `art`. Use plain English Unicode text (curly quotes allowed), not Markdown/HTML. Front/back covers use the same robust wrapped layout; no separate `title` field is needed inside their page object.

## Exact page ordering

For N spreads, build N+1 physical sheets and N+2 chapter states:

- sheet 0 front = front cover; sheet 0 back = spread 1 left.
- sheet 1 front = spread 1 right; sheet 1 back = spread 2 left.
- …
- sheet N front = spread N right; sheet N back = back cover.

`chapters = ["Cover", ...spread themes, "The End"]` and `chapters.length === sheets.length + 1`.

Use `number`, `label`, `text`, and `image` for interior sides; use `cover: true`, `title`, `text`, `image` and optionally `end: true` for covers. Text metadata is retained for later narration/accessibility. Currently the scaffold paints only `data.image` when an image exists; adding a `text` property alone will NOT display the story. The helper composes visible English into the page image so no renderer patch is required.

## Image composition

Page document: 1024×1400, warm paper background. Artwork: x=0, y=0, width=1024, height=900, center-cropped using SVG `preserveAspectRatio="xMidYMid slice"`. Typeset narration below the artwork within x=80…944. Body font 44px, line-height 60px; up to 6 conservative wrapped lines. Cover font 64px with up to 5 lines. Oversized text is rejected, never truncated or silently shrunk. Body text lengths are editorially chosen by age, not just the layout limit.

Art files may be PNG, JPEG, or WebP. They are embedded as base64 inside the SVG, so the browser does not need remote resources. XML text is escaped; fonts use available rounded/system sans-serif fallbacks. Page SVGs are layout documents wrapping original raster illustrations, not AI-generated vector substitutes. Keep original art files for editing. If browser/target policy disallows SVG image textures, use a browser to rasterize these page documents and update image URLs; do not assume they rendered.

For a continuous panorama, prepare actual matched half-page crops before building; the helper itself does not split a spread. Request artwork-only edits from imagegen when needed. This skill authorizes normal document typesetting, not replacement of generated art with fake illustrations.

## Commands and canonical output

Read [story-layout.md](story-layout.md) for the mandatory folder structure.

```bash
python3 $SKILL/scripts/build_book.py \
        "$PROJECT/stories/<id>/manifest.json" --check
python3 $SKILL/scripts/build_book.py \
        "$PROJECT/stories/<id>/manifest.json" --build v1
```

`--check` validates the plan and explicitly reports missing artwork. A full build requires real art and a manifest located at `stories/<id>/manifest.json`. It writes composed pages and a content version snapshot to `stories/<id>/pages/v1/`, then updates story-local `content.js` with a backup. It initializes story-local `narration.js` to null only if absent. Existing page versions are rejected rather than overwritten. Originals remain in art/; no second copy is made.

A story deliberately kept outside `<stories>/<id>/` is refused unless you name the project or the folder with `--project` or `--story-dir`. The default rule is kept strict because the app, the Vite plugin and the tests all depend on it.

Render composed pages to disk when layout sampling is useful; do not load every screenshot into the agent context:

```bash
node $SKILL/scripts/shot_pages.mjs --project "$PROJECT" --story <id>
```

Pages are discovered on disk and the PNGs land in the story's `qa/pages/`. Run `python3 "$SKILL/scripts/preview_art.py" --story "$PROJECT/stories/<id>" --source qa/pages` to view one small sampled sheet instead of the full screenshots. Never read composed SVGs as text into context: they embed base64 artwork.

A still page document shows the layout; the book itself needs the reader. This serves it without an app, a dev server or a bundler:

```bash
node $SKILL/scripts/static-server.mjs --project "$PROJECT" --story <id>
```

It prints a URL and stays up until interrupted. Use it to check page order and turning against the artwork and any installed narration.

Select the story via `src/active-story.js`, re-exporting both its content.js and narration.js. The Vite story-assets plugin serves `/stories/<id>/pages/v1/*.svg` directly and copies resources only when building dist. Do not copy story content into public/.

Run `npm run build` and meaningful interaction checks. Read automated results for page loading and navigation at both landscape viewports. Keep visual review sampled; check a targeted small screenshot only for a concrete layout issue. Trust generated artwork when its overall style and characters are broadly consistent; do not perform a second page-by-page art audit.
