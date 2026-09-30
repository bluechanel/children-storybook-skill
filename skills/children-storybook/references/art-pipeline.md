# Generating the artwork

From `scenes.md` to files in `art/`. Write the prompts first ([art-prompts.md](art-prompts.md)),
then run the batch.

```bash
python3 $SKILL/scripts/gen_prompts.py --story "$PROJECT/stories/<id>"
python3 $SKILL/scripts/gen_prompts.py --story "$PROJECT/stories/<id>" --check

python3 $SKILL/scripts/gen_art.py --story "$PROJECT/stories/<id>" --dry-run
python3 $SKILL/scripts/gen_art.py --story "$PROJECT/stories/<id>"
```

`--dry-run` is the step to actually read: it prints the endpoint, model, size, output directory,
and every asset with its resolved reference images **in order**. No key, no network, no cost.
Always look at it before generating — a wrong reference order is invisible afterwards and shows
up only as drifting characters.

## API contract

`gen_art.py` posts to the OpenAI Images API using the standard library only, so it needs no
virtualenv and no `openai` package.

| | |
| --- | --- |
| Endpoint | `${OPENAI_BASE_URL:-https://api.openai.com/v1}/images/edits`, or `/images/generations` when a prompt has no reference images |
| Model | `--model`, else `$OPENAI_IMAGE_NAME`, else `gpt-image-2` |
| Size / quality | `size` and `quality` from `characters.md`, else `1536x1024` / `high` |
| Fields | `model`, `prompt`, `size`, `quality`, `n`, then one `image[]` part per reference, in order |
| Response | `data[0].b64_json`, or `data[0].url` which is then downloaded |
| Check | `--probe` (free, `GET /models`) or `--verify` (one paid generation, one provider) |

`OPENAI_BASE_URL` keeps its `/v1` suffix, matching `.env.example`. Because the request goes
through `urllib`, `HTTPS_PROXY`/`HTTP_PROXY` work for a transparent proxy without any code
change. For parameters the API grows later, pass them through with `--extra field=value`.

Every response is checked for a PNG/JPEG/WebP signature before it is written. A response that
is not really an image is rejected rather than saved under a `.png` name, where it would
satisfy the skip-existing check and poison every later build.

Two checks, and they are not the same check:

```bash
# Free: is the endpoint up, is the key accepted, does it know this model? One GET, no cost.
python3 $SKILL/scripts/gen_art.py --story "$PROJECT/stories/<id>" --probe

# Paid: one real generation, printing the resolved endpoint, the reference order and the
# keys in data[0]. It costs one image and writes nothing.
python3 $SKILL/scripts/gen_art.py --story "$PROJECT/stories/<id>" cover --verify
```

Run `--probe` whenever a run starts failing and you need to know whether the endpoint or the
request is at fault; it costs nothing, so there is no reason to guess.

`--verify` **refuses to run when the named asset declares reference images that do not exist
yet**, because it would then silently test text-to-image on `/images/generations` and report
success for a path the pages never use. Generate the reference sheets first, or name an asset
that has no references. It also prints the provider and model it verified, because that is what
the result is worth: a contract verified against `gpt-image-2` on the official API says nothing
about a relay, and a relay can differ on request shape, accepted fields and response format.
Contract verified **2026-09-25** against `gpt-image-2` (size `1536x1024`, quality `high`, base64
response) on the official OpenAI API — re-verify per provider, and treat an unverified endpoint
as unverified rather than assuming the earlier result transfers.

## Choosing a concurrency level

**Default to `--workers 1`.** The proxy this pipeline was built against refused overlapping long
edit requests, which is why the original batch runner was strictly serial with retries. Raise it
only when the endpoint is known to accept concurrent edits — roughly 24 high-quality images take
minutes to tens of minutes serially.

```bash
# serial, with retries: the safe default
python3 $SKILL/scripts/gen_art.py --story "$STORY" --attempts 6 --retry-delay 20

# only where the endpoint tolerates it
python3 $SKILL/scripts/gen_art.py --story "$STORY" --workers 4
```

## Behaviour you can rely on

- **Dependencies.** References finish before dependent pages start, even with multiple workers or explicitly reordered targets. Cycles fail before any request. A failed reference blocks its dependants even if an old image still exists; independent assets can finish. There is no mandatory visual inspection gate between reference generation and page generation.
- **Resume and provenance.** Each generated image has an adjacent `<name>.provenance.json` with hashes of generation inputs (prompt, ordered reference bytes, endpoint, model, size, quality and extras) and output bytes. `--dry-run` reports `missing`, `reusable`, `stale`, `untracked` (legacy/no valid record) or `modified` (output changed manually). It uses current reference bytes; states are rechecked after reference generation.
- **Selective refresh.** Default runs generate missing files and preserve all existing images, reporting stale ones. `--refresh-stale` additionally regenerates tracked stale images; pass asset names to limit scope. Untracked and manually modified images remain untouched unless explicitly selected with `--force`. Replacing any image preserves it and its provenance under `backups/art/<run-id>/`. Image writes are atomic; metadata failure does not trigger another paid generation. A skipped stale image is not evidence that a requested revision is complete.

```bash
python3 "$SKILL/scripts/gen_art.py" --story "$PROJECT/stories/<id>" page-07 --dry-run
python3 "$SKILL/scripts/gen_art.py" --story "$PROJECT/stories/<id>" page-07 --refresh-stale
```

- **The output directory is created if it is missing**, once before the first paid request and
  again just before each write. An image that has already been generated and paid for is never
  discarded because `art/` was not there.
- **Retries.** 408, 409, 429, 5xx, connection errors, timeouts and **truncated response bodies**
  are retried with a growing delay (default 20 s, ×1.5, capped at 120 s). The last one matters:
  a proxy that cuts a response short raises `http.client.IncompleteRead`, which is *not* an
  `OSError`, so it is classified explicitly rather than being allowed to escape. **400, 401, 403
  and 404 are not retried**: a 400 is usually moderation or a malformed request, and repeating it
  just spends money. A 401/403 exits with status 3 so a bad key is obvious.
- **One asset cannot end the run.** An unexpected error is recorded against that asset and the
  rest of the batch continues; the summary reports the failure and the exit code is 1.
- **Bad news is a message, not a stack trace.** A missing directory, an unwritable path or an
  unreachable endpoint prints `Error: …` with what to do about it; a Python traceback means a
  bug in this script, and is worth reporting as one.
- **Logs.** Per-asset detail lands in `<story>/qa/art-logs/gen-art.log.<name>`. The API key is
  never written to a log, a story file or stdout.
- **Exit codes.** `0` all succeeded (skips count), `1` at least one failed, `2` usage or
  configuration problem, `3` authentication.

## Cost and consent

Generating a book is dozens of paid requests. Do not start a run on a "plan only" request, and
do not silently regenerate art to fix an unrelated problem — an audio-only update must not touch
the illustrations. When image generation is unavailable, keep `story.md`, `storyboard.md`,
`scenes.md` and the manifest, report exactly which assets are missing, and stop short of calling
the book finished. Never substitute stock photos, emoji, geometric placeholders or another paid
API. Placeholders are acceptable only if the user asked for a draft.

## When generation is not available

`build_book.py --check` reports `missing_art` by name without needing any image generation, and
the `examples/goldilocks` package ships with artwork so the whole compose-and-inspect path can be
exercised offline. Use it to validate layout and text before spending anything.

## Lightweight visual sampling

Trust the image API; approximate consistency is enough. Do not inspect every output, compare
pixel-level details or regenerate for minor variation. After a batch, run:

```bash
python3 "$SKILL/scripts/preview_art.py" --story "$PROJECT/stories/<id>"
```

The script samples at most four non-reference images across the available sequence, uses
ffmpeg locally and writes one JPEG to `qa/previews/sample.jpg` (at most 960×640, 250,000 bytes).
It prints only paths, dimensions, byte count and the row-major slot mapping, also saved in
`sample.json`. It does not change originals, prompts or generation reference inputs. Read
that one sheet once for broad character/style/palette consistency, then continue. Do not
load original art, base64, embedded-image SVG text, or a sequence of full-size screenshots
into the conversation. Do not expand the sample just to cover every image.

For a user-reported issue or obvious major mismatch only, `--names page-03.png` makes a
small targeted preview; up to four exact filenames are accepted. `--source qa/pages`
samples already-rendered page screenshots for layout. Sources and outputs stay inside
the story. If preview creation fails, report it instead of falling back to full originals.
A request-size error is a reason to stop visual loading, not to repeat the same payload.
Record review as a sample, not an exhaustive art audit.
