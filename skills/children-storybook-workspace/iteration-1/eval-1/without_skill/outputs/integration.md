# Integration plan — not applied

Inspected `/Users/wileyzhang/Code/voice_book/src/content.js` and `/Users/wileyzhang/Code/voice_book/src/main.js` read-only. No application files changed, no images generated, no install/build commands executed.

## Renderer contract

`bookContent.sheets` supplies front/back face objects; `COUNT` is derived from array length. `makeTexture()` uses a 1024 × 1400 canvas and draws images with centered cover scaling. Images of exactly this size avoid cropping. Mesh ratio 2.55:3.45 differs slightly from texture ratio, so a slight display stretch already exists. With an image, the renderer does not draw story text, labels, page numbers, or cover title. Without an image it shows a blank numbered interior or the default cover. Adding a `text` field would not display the story. Back textures are flipped by the existing code; supply ordinary readable, unmirrored images.

## Deterministic text composition before installation

Generate only the illustration layer using prompts.md. Then produce one flattened PNG per face, combining art and exact manifest `text_lines`; never ask image generation to draw the words. Pin a locally available font file (for example Noto Sans Regular) and record its checksum and rendering library version when production starts. Use the same font file for all faces. At 1024 × 1400 draw an opaque warm cream rectangle over x=0–1024, y=1050–1400 on interiors; set dark brown #3A3028 text at x=130, baselines 1110, 1166, 1222, 1278 with 38 px type. Draw the four or fewer supplied lines without reflow. Verify each line width is <=764 px; if one exceeds this, reduce font size consistently for the entire book until all fit. Put the page number centered at baseline 1350 in 24 px type. Covers use a cream title panel x=80–944, y=70–460, dark text centered, 56 px type, 70 px line spacing; use the front-cover manifest `text_lines` exactly, at baselines 210 and 280. Back-cover text uses the manifest’s fixed line breaks. Inspect every resulting face and open-spread pair for clipping and gutter collisions.

## Physical sheet order

Zero-based sheet indices; each row below lists front then back. Turning the first sheet reveals pages 1 and 2 together.

| Sheet | Front | Back |
|---|---|---|
| 0 | front-cover | page-01 |
| 1 | page-02 | page-03 |
| 2 | page-04 | page-05 |
| 3 | page-06 | page-07 |
| 4 | page-08 | back-cover |

There are 5 physical sheets and 6 navigation states. `chapters` must have 6 entries, corresponding to front cover, 4 spreads, back cover. The supplied manifest `bookContent` has these lengths.

## Future installation

1. Complete and review all 10 missing illustrations and composed PNGs listed in manifest.json. This draft intentionally keeps every actual `image` value null; `planned_url` is a future destination, not an available asset.
2. Place each completed composed PNG at its `composed_path` under the project root. Only after the file exists, replace its corresponding `bookContent.sheets[s].front.image` or `.back.image` with `planned_url`, mapping consecutive pairs from `face_order`. Preserve cover/end flags.
3. Replace the exported object in `src/content.js` with the manifest `bookContent` object after those image values are filled. There is no direct manifest loader: exporting JSON text requires the JavaScript prefix `export const bookContent = ` and a trailing semicolon. Do not import this manifest as though the renderer consumes it directly. No change to `src/main.js` is needed with flattened pages.
4. Run the repository’s existing preview/build commands as declared by its package configuration (not inspected in this bounded exercise). Open the existing book UI; step through every state with next/previous and arrow keys. Check cover, facing-page order, text readability, unmirrored backs, all page numbers, final back cover and no missing-image warnings. Use `window.bookDemo.goTo(i)` for each state and wait until `window.bookDemo.state.current === i` and `animating === false` before capturing a visual check.

All installation and visual verification above remain future work because the request is planning-only.
