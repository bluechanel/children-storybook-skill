# Publishing materials after MP4 export

This is the final step of the normal storybook MP4 workflow. Unless the user explicitly asks
for video only with no publishing materials, deliver covers and platform copy along with the
completed video. Also use this reference when asked to prepare materials for an existing
storybook MP4. A plan-only request produces a copy/layout plan without rendering or paid calls.
Preparing a kit does not upload, post, log in to accounts or schedule publication.

## Write the copy from this story

Read the selected story's manifest/manuscript and the completed video's export report. Use the
actual plot, tone, audience and narration language. For 抖音、小红书、B 站, default to Chinese
publishing copy, retaining the English book title; this does not translate the book itself.
Use the user's requested language, platforms and style when specified.

- **抖音:** lead with a concrete character, question or story moment; one short invitation to
  watch/read together and a few relevant hashtags.
- **小红书:** a concise title and a warm parent-facing description of the reading moment and
  story. Mention an age range only when the brief/manifest supports it.
- **B 站:** a searchable title identifying the story and English picture-book format; a short
  plot introduction and accurate format information.

Write one usable title, a 1–3 sentence description and 3–8 relevant tags per platform. Favor a
mix of story/character, format and audience tags. Do not invent trending tags, native-speaker
claims, bilingual content, learning guarantees, awards or plot events absent from the video.
Do not promise virality. Keep AI narration disclosure from the export report in the package;
the uploader can apply the platform's current declaration controls.

The script uses conservative **editorial budgets**, not authoritative platform API limits:
小红书 title ≤20 Unicode code points, other titles ≤60, descriptions ≤300, tags ≤24 each.
Tags are stored without `#`; `publish.md` supplies them. If a platform changes its limits or
crop UI, adapt at upload time rather than claiming these defaults are its current rules.

## Choose and compose the covers

Reuse the story's original cover art by default. Choose another original illustration when it
better captures the actual hook. Do not stretch art, screenshot player controls, use a text-heavy
typeset book page, or redesign the characters. The composer preserves the complete artwork with
`object-fit: contain`, and typesets exact copy separately. If new art is genuinely needed, follow
the existing art pipeline and store it inside this story; do not make an unrequested paid call
just to change the aspect ratio.

The kit contains three independently laid-out PNGs:

| Key | File | Size | Suggested use |
| --- | --- | --- | --- |
| portrait | cover-portrait-9x16.png | 1080×1920 | 抖音 / vertical video |
| landscape | cover-landscape-16x9.png | 1920×1080 | B 站 / horizontal video |
| rednote | cover-portrait-3x4.png | 1080×1440 | 小红书 feed |

These are composition defaults, not mandatory platform specifications. A portrait cover does
not convert a landscape MP4 into portrait video. Keep the main text and faces well within the
canvas; leave extra room at the bottom of vertical covers for UI overlays. Check the combined
preview for clear hierarchy, readable Chinese, no missing glyphs and no obvious obstruction.
The script checks image decoding, output dimensions and text overflow, but cannot certify glyph
coverage or editorial quality. A missing CJK font needs a host-provided font such as Noto Sans
CJK SC, PingFang SC or Microsoft YaHei; do not deliver tofu boxes as correct typography.

Use a short cover headline (usually 8–16 Chinese characters, optional `\n` line break), a one-line
subtitle and a small format label. Inherit the story palette or user's brand; optional `theme`
colors set background, text and accent. Do not turn every story into identical clickbait.

## Source and commands

Write a versioned source such as `stories/<id>/publishing/copy-v1.json`. Replace the example's
story-specific wording; the current agent writes this copy, with no extra text-generation API.
All three default platforms are represented in the schema; additional platforms may be supplied
as supplementary copy in the kit when requested.

```json
{
  "version": 1,
  "cover": {
    "art": "art/cover.jpg",
    "headline": "闯进小熊家\n之后呢？",
    "subtitle": "和金发姑娘一起，学着说对不起",
    "label": "英语绘本 · 亲子共读"
  },
  "theme": { "background": "#f7f1e5", "ink": "#204638", "accent": "#a4482d" },
  "platforms": {
    "douyin": {
      "title": "金发姑娘闯进三只熊的家，后来发生了什么？",
      "description": "一碗粥、一把小椅子，带来一场森林奇遇。一起听这个关于道歉与修补的英文绘本故事。",
      "tags": ["英语绘本", "金发姑娘和三只熊", "亲子共读", "儿童故事"]
    },
    "xiaohongshu": {
      "title": "亲子共读｜金发姑娘和三只熊",
      "description": "今天一起读 Goldilocks and the Three Bears。从闯进小熊家到一起修好椅子，陪孩子感受犯错后也可以认真道歉、动手弥补。",
      "tags": ["亲子阅读", "英文绘本", "金发姑娘和三只熊", "睡前故事"]
    },
    "bilibili": {
      "title": "【英语绘本】金发姑娘和三只熊｜Goldilocks and the Three Bears",
      "description": "金发姑娘走进森林里的小屋，遇见三只熊。一段关于道歉、修补与友谊的英文绘本朗读，配合插画翻页。",
      "tags": ["英语绘本", "儿童故事", "Goldilocks", "亲子共读"]
    }
  }
}
```

Prepare the copy before exporting when convenient, then let the exporter compose the kit
**after** the MP4 passes its checks:

Check just the copy schema offline (no built story, browser, credentials or video needed):

```bash
node "$SKILL/scripts/publish_bundle.mjs" --check-copy "$PROJECT/stories/<id>/publishing/copy-v1.json"
```

This checks editorial budgets and required fields, not factual accuracy or rendered layout.
Then export:

```bash
node "$SKILL/scripts/export_video.mjs" --project "$PROJECT" --story <id> \
  --timeline "$PROJECT/stories/<id>/audio/audio-v1/timeline.json" \
  --output "$PROJECT/stories/<id>/video/book-v1.mp4" \
  --publish-copy "$PROJECT/stories/<id>/publishing/copy-v1.json"
```

`narrate.mjs --video --publish-copy <file>` forwards the same option. The low-level exporter
retains its video-only behavior when the flag is omitted; the **skill workflow** must then
complete the following separate step. For an existing MP4 or a failed kit, do not regenerate
the video or narration:

```bash
node "$SKILL/scripts/publish_bundle.mjs" --project "$PROJECT" --story <id> \
  --video "$PROJECT/stories/<id>/video/book-v1.mp4" \
  --copy "$PROJECT/stories/<id>/publishing/copy-v1.json"
```

Outputs go to `stories/<id>/publishing/<video-stem>/`: three PNGs, self-contained editable HTML
layouts, normalized `copy.json`, `publish.json`, copy-friendly `publish.md` and one small
`preview.jpg` (960×600, ≤250 KB). `--name book-v2` creates a new version without overwriting
an accepted kit. Source copy and art stay inside the selected story, including through symlinks.
`--project` follows the usual host-neutral resolution. No npm package or remote font is needed.

The generator requires the paired `<video>.mp4.json` export report, checks current story identity,
video format/dimensions/duration and, for new exports, the video SHA-256. It rejects test tones,
stale content and changed videos. It records video/art/copy hashes for traceability. Legacy
reports without a video hash still get media checks; do not claim they prove original bytes.
If kit generation fails, the MP4/report and source copy remain; fix the cause and rerun only
`publish_bundle.mjs`. A successful independent retry updates the paired video's publishing
status. A hard process interruption can leave a partial kit directory; inspect it and choose
a new `--name` rather than overwriting it. Never label fixture tones or a partial kit ready to publish.

## Verify and deliver

Read the generated JSON check summary and open **only `preview.jpg`**, not all full-size covers.
If there is an obvious issue, revise the copy/art selection and create a new named version.
Record sampled visual review and editorial accuracy in the story's `qa.md`; the automated JSON
starts with visual review pending and must not be mistaken for human approval. Update its
`qa.visualReview` after reviewing, recording exactly what was checked.

Deliver the MP4, the publishing directory and `publish.md`, and show the small preview when
useful. A video export request is complete only after this package is generated and reviewed,
unless publishing was explicitly excluded. Report missing fonts/art or failed covers precisely.
Actual posting remains a separate user request.
