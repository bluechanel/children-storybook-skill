# Writing the image prompts

Two human-edited files in the story folder drive every prompt. `gen_prompts.py` expands them
into `prompts/<name>.txt`, one file per asset, and `gen_art.py` sends those files to the
Images API. Never hand-edit `prompts/` — it is generated output and will be overwritten.

- `characters.md` — the shared art direction plus one section per **reference sheet**.
- `scenes.md` — one section per **generated asset** (cover, back, each page).

## Format

A line is read as a key only when it looks like `lowercase_key:` at the start of a line.
Anything else continues the value above it, joined with a single space — so prose may contain
colons, and wrapping a long value across lines is safe.

```markdown
# characters.md

size: 1536x1024
quality: high
style: warm hand-painted gouache and watercolour on textured cotton paper, ...
framing: one coherent scene, the main subjects inside the central 75 percent ...
constraints: no text, letters, numbers, captions, signage, logos or watermarks; ...
palette: moss and sage green, warm honey amber, cream paper, ...

## ref-goldilocks
keywords: Goldilocks
bible: Goldilocks, a human girl about six years old, golden-yellow springy curls ...
sheet: A full-length character sheet of one girl on a plain warm cream paper background, ...

## ref-bears
keywords: Papa Bear
bible: Papa Bear, the biggest and broadest, deep chestnut-brown fur, ...
sheet: A character sheet of three bears on a plain warm cream paper background, ...
```

```markdown
# scenes.md

## cover
refs: ref-goldilocks, ref-bears
scene: Front cover illustration. Goldilocks stands in a sunlit woodland clearing ...

## page-01
refs: ref-goldilocks
scene: A sunlit wildflower meadow at the edge of a green wood. ...
```

`refs` lists reference sections **in the order the model must receive them**. Omitting `refs`
produces a text-to-image prompt, which is what the reference sheets themselves use.

`keywords` are how `gen_art.py` maps a prompt's `Reference image N:` lines back to files. They
are written to `ref-map.json`. Make each keyword a distinctive phrase that appears in that
sheet's `bible` and nowhere else — `Papa Bear` works; `Bear` would not.

## Art direction defaults

`size`, `quality`, `style`, `framing`, `constraints` and `palette` have built-in defaults taken
from the art direction this pipeline was developed against; a story overrides any of them by
setting the same key at the top of `characters.md`. The defaults are worth keeping unless the
brief calls for something else, because each one is doing a specific job:

- **`framing` — the central 75 percent rule.** The page composer crops the artwork to a
  1024×900 band with `preserveAspectRatio="xMidYMid slice"`, so the left and right edges of a
  1536×1024 image are cut. Subjects pushed to the edges lose faces and hands. Keep the scene in
  the middle and leave headroom and footroom.
- **`constraints` — no text.** The model illustrates; `build_book.py` typesets. Any letters the
  model draws are unreadable at page size, not editable, and duplicated by the real text below
  the artwork. The same line rules out extra limbs, extra characters and frightening elements.
- **`palette`.** One coherent palette across pages is what makes separate generations read as
  one book.
- **`style`.** Concrete medium words ("gouache and watercolour on textured cotton paper")
  reproduce far more reliably than adjectives like "beautiful" or "storybook style".

## Prompt shape

Every generated prompt follows this order, which is the format `gen_art.py` parses:

```text
Use case: illustration-story
Asset type: children's picture-book page illustration, landscape frame
Reference image 1: <bible> Use it ONLY to copy those character designs and the painting
style. This is a NEW scene: change the background, camera angle, poses and lighting completely.
Reference image 2: ...
Character designs to keep identical to the references: <bibles, in order>
Style/medium: <style>
Scene: <scene>
Composition/framing: <framing>
Constraints: <constraints> Palette: <palette>
```

The "Use it ONLY to copy … This is a NEW scene" sentence is load-bearing: without it the model
tends to reproduce the reference sheet's pose and background instead of drawing the new scene.

## Relationship to storyboard.md

`storyboard.md` is the **editorial** document: themes, beats, register, why the page turns.
`scenes.md` is the **generation** document: what each drawing shows, and which references it
needs. They cover the same ground and should agree — `gen_prompts.py --check` cross-checks the
scene names against `manifest.json` and reports any page the scene list is missing. Write the
storyboard first, then transcribe it into `scenes.md`.

## Iterating

Trust the image API and accept approximate character/style consistency. Use the single
sampled thumbnail sheet described in [art-pipeline.md](art-pipeline.md); do not inspect
all images, load originals into context or iterate on minor details. Only a user-reported
problem or an obvious major mismatch in the sample warrants a targeted thumbnail and
possible correction of that one prompt/asset. Keep the other generated artwork intact.

A refused or moderated request comes back as HTTP 400 with no image. That is not a transient
failure — `gen_art.py` fails fast rather than retrying, and the fix is to change that prompt.
