#!/usr/bin/env python3
"""Generate story artwork through the OpenAI Images API, and run the whole batch.

One prompt file per asset lives in <story>/prompts/<name>.txt (see gen_prompts.py). Each
file may begin lines with "Reference image N: ...", which are resolved to the files in
<story>/art and sent in exactly that order, so the model receives the references in the
order the prompt describes.

  gen_art.py --story stories/<id> --dry-run          # show the plan; no network, no key
  gen_art.py --story stories/<id>                    # generate, skipping assets already on disk
  gen_art.py --story stories/<id> --workers 4        # only if the endpoint allows concurrency
  gen_art.py --story stories/<id> cover page-07      # a subset

Python standard library only, on purpose: an installed skill cannot assume a virtualenv,
and owning the retry policy matters more than the multipart encoder the SDK would provide.
"""
import argparse
import base64
import hashlib
import shutil
import http.client
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from env_file import load_env_local, resolve_project  # noqa: E402  (siblings, dependency-free)
from gen_prompts import parse as parse_book  # noqa: E402

DEFAULT_BASE_URL = 'https://api.openai.com/v1'
DEFAULT_MODEL = 'gpt-image-2'
QUALITIES = ('low', 'medium', 'high', 'auto')
# Fields the Images API types as numbers. JSON is typed, so these must go out as numbers: a
# strict OpenAI-compatible gateway rejects "n": "1" with "n must be a positive integer",
# where the official API quietly coerces it. multipart can only carry strings and every
# server coerces those, so this set matters on the JSON path alone.
NUMERIC_FIELDS = frozenset({'n', 'seed', 'steps', 'num_inference_steps', 'guidance_scale',
                            'cfg_scale', 'strength', 'scale', 'partial_images', 'output_compression'})
SIGNATURES = ((b'\x89PNG\r\n\x1a\n', 'image/png'), (b'\xff\xd8\xff', 'image/jpeg'))
RETRYABLE = {408, 409, 429}
# Everything that means "the connection, not the request, went wrong". http.client's
# HTTPException is listed separately and deliberately: IncompleteRead — a response body cut
# short by a proxy — inherits from it, *not* from OSError, so leaving it out let one truncated
# response escape the retry loop and take the whole batch down with it.
NETWORK_ERRORS = (urllib.error.URLError, TimeoutError, OSError, http.client.HTTPException)
REF_LINE = re.compile(r'^Reference image (\d+):\s*(.*)$', re.MULTILINE)
PATH_TOKEN = re.compile(r'([\w][\w./-]*\.(?:png|jpe?g|webp))', re.IGNORECASE)


class UsageError(Exception):
    """Bad inputs or configuration: exit 2 without touching the network."""


class ApiError(Exception):
    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status

    @property
    def retryable(self):
        return self.status is None or self.status in RETRYABLE or self.status >= 500


def image_kind(data):
    """Return the media type when the bytes really are an image, else None.

    Guards against writing an HTML error page to disk under a .png name, which would
    then satisfy the skip-existing check and poison every later build.
    """
    for signature, mime in SIGNATURES:
        if data.startswith(signature):
            return mime
    if data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        return 'image/webp'
    return None


def multipart(fields, files):
    """Encode fields and files as multipart/form-data, preserving file order."""
    boundary = '----bookart' + uuid.uuid4().hex
    body = bytearray()
    for name, value in fields:
        body += f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode('utf-8')
    for name, filename, data, mime in files:
        body += f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{filename}"\r\n' \
                f'Content-Type: {mime}\r\n\r\n'.encode('utf-8')
        body += data + b'\r\n'
    body += f'--{boundary}--\r\n'.encode('utf-8')
    return bytes(body), f'multipart/form-data; boundary={boundary}'


def _as_number(value):
    """Return value as an int or float when it is plainly a number, else None."""
    try:
        return int(str(value).strip())
    except ValueError:
        pass
    try:
        number = float(str(value).strip())
    except ValueError:
        return None
    return number if math.isfinite(number) else None


def json_body(fields):
    """Serialize fields as a JSON request body, typing the numeric parameters.

    Everything else stays a string: model, prompt, size and quality are strings to the API,
    and a prompt that happens to read "1" must not be sent as a number.
    """
    document = {}
    for name, value in fields:
        if name in NUMERIC_FIELDS:
            number = _as_number(value)
            if number is not None:
                value = number
        document[name] = value
    return json.dumps(document).encode('utf-8')


def _http(url, body, content_type, api_key, timeout):
    """The single network seam. Returns (status, payload); raises ApiError when unreachable."""
    request = urllib.request.Request(url, data=body, method='POST', headers={
        'Authorization': f'Bearer {api_key}', 'Content-Type': content_type,
        'Content-Length': str(len(body)), 'Accept': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()
    except NETWORK_ERRORS as error:
        if isinstance(error, http.client.HTTPException):
            raise ApiError(f'{url} sent an unusable response ({error.__class__.__name__}: {error}). '
                           f'The connection was cut mid-response; this is retried.')
        raise ApiError(f'Could not reach {url}: {error}')


def call_api(endpoint, fields, files, api_key, timeout):
    """POST to the Images API and return the parsed JSON. Never logs the key."""
    if files:
        body, content_type = multipart(fields, files)
    else:
        body, content_type = json_body(fields), 'application/json'
    status, payload = _http(endpoint, body, content_type, api_key, timeout)
    try:
        document = json.loads(payload.decode('utf-8', 'replace'))
    except ValueError:
        document = None
    if status >= 400 or (isinstance(document, dict) and document.get('error')):
        message = ''
        if isinstance(document, dict) and isinstance(document.get('error'), dict):
            message = str(document['error'].get('message', ''))
        if not message:
            message = payload[:400].decode('utf-8', 'replace').strip() or 'no response body'
        raise ApiError(f'Images API returned {status}: {message}', status)
    if not isinstance(document, dict) or not document.get('data'):
        raise ApiError('Images API returned no "data" array.')
    return document


def decode_image(document, api_key, timeout):
    """Accept either an inline base64 payload or a URL to download."""
    entry = document['data'][0]
    if entry.get('b64_json'):
        return base64.b64decode(entry['b64_json'])
    if entry.get('url'):
        host = urllib.parse.urlsplit(entry['url']).netloc
        try:
            with urllib.request.urlopen(entry['url'], timeout=timeout) as response:
                return response.read()
        except NETWORK_ERRORS as error:
            raise ApiError(f'Could not download the generated image from {host}: {error}')
    raise ApiError('Images API response had neither b64_json nor url.')


def resolve_references(text, story, ref_map):
    """Map the prompt's "Reference image N:" lines to files, in the order they appear.

    This order is the invariant the whole pipeline rests on: the model must receive the
    images in the same order the prompt text describes them.
    """
    art = story / 'art'
    resolved, unresolved = [], []
    # Longest keyword first, so a more specific name wins over one contained inside it.
    keywords = sorted(ref_map.items(), key=lambda item: len(item[0]), reverse=True)
    for match in REF_LINE.finditer(text):
        line = match.group(2)
        token = PATH_TOKEN.search(line)
        if token:
            candidate = (story / token.group(1)).resolve()
            if candidate.is_relative_to(story.resolve()):
                resolved.append(candidate)
                continue
        lowered = line.lower()
        hit = next((name for keyword, name in keywords if keyword in lowered), None)
        if hit is None:
            unresolved.append(line[:80])
            continue
        resolved.append(art / hit)
    return resolved, unresolved


def initial_targets(story):
    """Reference sheets first, then the covers, then the interior pages in page order."""
    names = sorted(path.stem for path in (story / 'prompts').glob('*.txt'))
    refs = [n for n in names if n.startswith('ref-')]
    rest = [n for n in names if not n.startswith('ref-')]
    order = {'cover': 0, 'back': 1}

    def rank(name):
        return (order.get(name, 2), name)
    return refs + sorted(rest, key=rank)


def load_ref_map(story, explicit):
    path = Path(explicit) if explicit else story / 'ref-map.json'
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError) as error:
        raise UsageError(f'{path} is not readable JSON: {error}')
    if not isinstance(data, dict):
        raise UsageError(f'{path} must map keywords to filenames.')
    return {str(k).lower(): str(v) for k, v in data.items()}


def plan_target(story, name, ref_map, out_dir):
    """Everything needed to generate one asset, without touching the network."""
    prompt_file = story / 'prompts' / f'{name}.txt'
    if not prompt_file.is_file():
        raise UsageError(f'no prompt file {prompt_file}. Run gen_prompts.py first.')
    text = prompt_file.read_text(encoding='utf-8')
    references, unresolved = resolve_references(text, story, ref_map)
    if unresolved:
        raise UsageError(f'{name}: cannot resolve reference line(s): {"; ".join(unresolved)}. '
                         f'Add a path or a keyword to {story / "ref-map.json"}.')
    return {'name': name, 'prompt': text, 'references': references, 'out': out_dir / f'{name}.png', 'story': story}


def provenance_path(task):
    return task['out'].with_suffix('.provenance.json')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def input_digest(task, settings):
    # Store only hashes: no credential or endpoint query can leak into the sidecar.
    inputs = {key: settings[key] for key in ('base_url', 'model', 'size', 'quality', 'extra')}
    inputs['prompt'] = task['prompt']
    inputs['references'] = [digest(ref.read_bytes()) if ref.is_file() else None
                            for ref in task['references']]
    return digest(json.dumps(inputs, sort_keys=True).encode())


def asset_state(task, settings):
    if not task['out'].is_file():
        return 'missing'
    try:
        saved = json.loads(provenance_path(task).read_text())
        if saved.get('version') != 1 or not saved.get('input') or not saved.get('output'):
            return 'untracked'
    except (OSError, ValueError, AttributeError):
        return 'untracked'
    if saved['output'] != digest(task['out'].read_bytes()):
        return 'modified'
    return 'reusable' if saved['input'] == input_digest(task, settings) else 'stale'


def dependency_layers(tasks):
    """Topological waves: a page cannot run until its selected references finish."""
    remaining = {task['out'].resolve(): task for task in tasks}
    if len(remaining) != len(tasks):
        raise UsageError('Duplicate output assets in this batch.')
    layers = []
    while remaining:
        ready = [task for task in remaining.values()
                 if not any(ref.resolve() in remaining for ref in task['references'])]
        if not ready:
            raise UsageError('Cyclic reference dependencies: ' + ', '.join(t['name'] for t in remaining.values()))
        # Finish reference sheets before unrelated page work too.
        refs = [task for task in ready if task['name'].startswith('ref-')]
        ready = refs or ready
        layers.append(ready)
        for task in ready:
            del remaining[task['out'].resolve()]
    return layers


def run_batch(tasks, settings, api_key, log_dir, workers, force=False, refresh_stale=False):
    failures, generated, skipped, auth_failed = 0, 0, 0, False
    failed = set()
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        for layer in dependency_layers(tasks):
            futures = []
            for task in layer:
                if any(ref.resolve() in failed for ref in task['references']):
                    failed.add(task['out'].resolve())
                    failures += 1
                    print(f'[FAIL] {task["name"]}: blocked by failed reference')
                    continue
                # Re-evaluate after reference generation: its bytes may have changed.
                try:
                    state = asset_state(task, settings)
                except OSError as error:
                    failed.add(task['out'].resolve())
                    failures += 1
                    print(f'[FAIL] {task["name"]}: could not inspect asset: {error}')
                    continue
                if not (force or state == 'missing' or refresh_stale and state == 'stale'):
                    skipped += 1
                    hint = ' (use --refresh-stale to regenerate)' if state == 'stale' else ''
                    print(f'[skip] {task["name"]}: {state}{hint}')
                    continue
                futures.append((task, pool.submit(run_target, task, settings, api_key, log_dir)))
            for task, future in futures:
                status, detail = future.result()
                print(f'[{"ok  " if status == "ok" else "FAIL"}] {task["name"]}: {detail}')
                if status == 'ok':
                    generated += 1
                else:
                    failures += 1
                    failed.add(task['out'].resolve())
                    auth_failed = auth_failed or status == 'AUTH'
    print(f'done, failures={failures} generated={generated} skipped={skipped}')
    return 3 if auth_failed else 1 if failures else 0


def note(log_path, message):
    """Best-effort logging. A run must not die because its own log line would not write."""
    try:
        with log_path.open('a', encoding='utf-8') as handle:
            handle.write(message + '\n')
    except OSError:
        pass


def run_target(task, settings, api_key, log_dir):
    """Generate one asset with retries. Returns a one-word status for the summary.

    Nothing raised here reaches the caller: a batch of paid requests must not be abandoned
    because one asset hit an error nobody anticipated. Every path returns a status.
    """
    name, references, destination = task['name'], task['references'], task['out']
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        return 'FAIL', f'could not create the log directory {log_dir}: {error}'
    log_path = log_dir / f'gen-art.log.{name}'
    missing = [ref.name for ref in references if not ref.is_file()]
    if missing:
        return 'FAIL', f'missing reference image(s): {", ".join(missing)} (generate the ref-* sheets first)'
    fields = [('model', settings['model']), ('prompt', task['prompt']),
              ('size', settings['size']), ('quality', settings['quality']), ('n', 1)]
    fields += [tuple(item.split('=', 1)) for item in settings['extra'] if '=' in item]
    try:
        fingerprint = input_digest(task, settings)
        if references:
            endpoint = f'{settings["base_url"]}/images/edits'
            files = [(name, path.name, data, image_kind(data) or 'image/png')
                     for name, path, data in ((f'image[]', ref, ref.read_bytes()) for ref in references)]
        else:
            endpoint = f'{settings["base_url"]}/images/generations'
            files = []
    except OSError as error:
        return 'FAIL', f'could not read a reference image: {error}'
    started = time.time()
    for attempt in range(1, settings['attempts'] + 1):
        try:
            document = call_api(endpoint, fields, files, api_key, settings['timeout'])
            data = decode_image(document, api_key, settings['timeout'])
            if image_kind(data) is None:
                raise ApiError('response was not a PNG/JPEG/WebP image')
            # The image is already paid for by the time we get here. A missing art/ directory
            # must not be what throws it away, so create it as late as possible and as
            # permissively as possible.
            destination.parent.mkdir(parents=True, exist_ok=True)
            temporary = destination.with_suffix('.png.tmp')
            temporary.write_bytes(data)
            # Keep accepted/older images recoverable, even on an explicit --force.
            if destination.is_file():
                backup = task['story'] / 'backups' / 'art' / uuid.uuid4().hex
                backup.mkdir(parents=True)
                shutil.copy2(destination, backup / destination.name)
                if provenance_path(task).is_file():
                    shutil.copy2(provenance_path(task), backup / provenance_path(task).name)
            os.replace(temporary, destination)
            metadata = provenance_path(task)
            try:
                metadata_tmp = metadata.with_suffix('.json.tmp')
                metadata_tmp.write_text(json.dumps({'version': 1, 'input': fingerprint,
                                                   'output': digest(data)}, indent=2) + '\n')
                os.replace(metadata_tmp, metadata)
            except OSError as error:
                # Never retry a paid generation just because provenance could not be saved.
                return 'ok', f'image saved; provenance unavailable: {error}'
            return 'ok', f'{time.time()-started:.0f}s {len(data)/1e6:.2f}MB refs={len(references)}'
        except ApiError as error:
            if attempt < settings['attempts'] and error.retryable:
                delay = min(settings['retry_delay'] * (1.5 ** (attempt - 1)), 120)
                note(log_path, f'attempt {attempt} failed ({error}); retrying in {delay:.0f}s')
                time.sleep(delay)
                continue
            note(log_path, f'attempt {attempt} failed: {error}')
            if error.status in (401, 403):
                return 'AUTH', str(error)
            return 'FAIL', str(error)
        except OSError as error:
            # Disk full, permissions, a read-only volume: never retryable, never fatal to the
            # rest of the batch.
            return 'FAIL', f'could not write {destination}: {error}'
        except Exception as error:  # noqa: BLE001 - one asset must not end the whole run
            note(log_path, f'unexpected error: {error.__class__.__name__}: {error}')
            return 'FAIL', f'{error.__class__.__name__}: {error}'
    return 'FAIL', 'exhausted attempts'


def probe(base_url, api_key, model, parser):
    """A free availability check: one GET against /models.

    This answers "is the endpoint up, is the key accepted, does it know this model" without
    spending anything. It says nothing about the Images contract — only --verify does, and
    only for the provider it was run against.
    """
    url = f'{base_url}/models'
    request = urllib.request.Request(url, headers={'Authorization': f'Bearer {api_key}'})
    try:
        with urllib.request.urlopen(request, timeout=30.0) as response:
            payload = response.read()
    except urllib.error.HTTPError as error:
        if error.code in (401, 403):
            parser.exit(3, f'Error: {url} rejected the credential (HTTP {error.code}).\n')
        parser.exit(2, f'Error: {url} returned HTTP {error.code}. The endpoint may not implement '
                       f'/v1/models; a relay often does not.\n')
    except NETWORK_ERRORS as error:
        parser.exit(2, f'Error: could not reach {url}: {error}. Is the endpoint running?\n')
    try:
        document = json.loads(payload.decode('utf-8', 'replace'))
    except ValueError:
        parser.exit(2, f'Error: {url} did not return JSON.\n')
    models = [entry.get('id') for entry in document.get('data', [])] if isinstance(document, dict) else []
    print(f'reachable  {url}   (credential accepted)')
    print(f'model      {model}   {"listed by the endpoint" if model in models else "NOT listed by the endpoint"}')
    if models:
        print(f'available  {", ".join(str(name) for name in models)}')
    print('No generation was made, so this checks availability only. The Images request shape '
          'and response are verified by --verify, once, against this provider.')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--story', required=True, type=Path, help='Story directory containing prompts/ and art/')
    parser.add_argument('--project', type=Path,
                        help='Host project root (default: $CHILDREN_STORYBOOK_PROJECT, $CLAUDE_PROJECT_DIR, or cwd)')
    parser.add_argument('names', nargs='*', help='Assets to generate (default: all)')
    parser.add_argument('--workers', type=int, default=1, help='Concurrent requests (default 1: most proxies refuse overlapping edits)')
    parser.add_argument('--attempts', type=int, default=3)
    parser.add_argument('--retry-delay', type=float, default=20.0, help='Seconds before the first retry (grows 1.5x)')
    parser.add_argument('--timeout', type=float, default=300.0, help='Seconds per request')
    parser.add_argument('--refresh-stale', action='store_true', help='Regenerate tracked stale assets; preserve untracked or manually modified images')
    parser.add_argument('--force', action='store_true', help='Regenerate assets that already exist')
    parser.add_argument('--model', help='Image model (default: $OPENAI_IMAGE_NAME or gpt-image-2)')
    parser.add_argument('--size', help='Image size, e.g. 1536x1024 (default: from characters.md, else 1536x1024)')
    parser.add_argument('--quality', help='low | medium | high | auto')
    parser.add_argument('--out-dir', type=Path, help='Where images land (default: <story>/art)')
    parser.add_argument('--ref-map', help='Keyword map (default: <story>/ref-map.json)')
    parser.add_argument('--extra', action='append', default=[], metavar='FIELD=VALUE', help='Extra API field (repeatable)')
    parser.add_argument('--dry-run', action='store_true', help='Print the plan without any network request')
    parser.add_argument('--probe', action='store_true', help='Free availability check: GET /models, no generation')
    parser.add_argument('--verify', action='store_true', help='Make one real request and report the API contract')
    args = parser.parse_args()

    project = resolve_project(args.project)
    load_env_local(project)
    story = args.story.resolve()
    if not story.is_dir():
        parser.exit(2, f'Error: no such story directory: {story}\n')
    prompts_dir = story / 'prompts'
    if not prompts_dir.is_dir():
        parser.exit(2, f'Error: {prompts_dir} does not exist. Run gen_prompts.py first.\n')

    # characters.md carries the art direction, including the size the prompts were written for.
    book = {}
    if (story / 'characters.md').is_file():
        book, _ = parse_book(story / 'characters.md')
    settings = {
        'base_url': (os.environ.get('OPENAI_BASE_URL') or DEFAULT_BASE_URL).rstrip('/'),
        'model': args.model or os.environ.get('OPENAI_IMAGE_NAME') or DEFAULT_MODEL,
        'size': args.size or book.get('size') or '1536x1024',
        'quality': args.quality or book.get('quality') or 'high',
        'attempts': max(1, args.attempts),
        'retry_delay': max(0.0, args.retry_delay),
        'timeout': max(1.0, args.timeout),
        'extra': args.extra,
    }
    if not re.fullmatch(r'auto|\d+x\d+', settings['size']):
        parser.exit(2, f'Error: --size must look like 1536x1024, got {settings["size"]}.\n')
    if settings['size'] != 'auto':
        width, height = (int(part) for part in settings['size'].split('x'))
        if width % 2 or height % 2 or not (256 <= width <= 4096) or not (256 <= height <= 4096):
            parser.exit(2, 'Error: image dimensions must be even and between 256 and 4096.\n')
    if settings['quality'] not in QUALITIES:
        parser.exit(2, f'Error: --quality must be one of {", ".join(QUALITIES)}.\n')

    out_dir = (args.out_dir or story / 'art').resolve()
    log_dir = story / 'qa' / 'art-logs'
    targets = args.names or initial_targets(story)
    if not targets:
        parser.exit(2, f'Error: no prompt files in {prompts_dir}.\n')
    try:
        ref_map = load_ref_map(story, args.ref_map)
        tasks = [plan_target(story, name, ref_map, out_dir) for name in targets]
        layers = dependency_layers(tasks)
    except UsageError as error:
        parser.exit(2, f'Error: {error}\n')

    if args.dry_run:
        print(f'endpoint  {settings["base_url"]}/images/edits (or /images/generations when a prompt has no references)')
        print(f'model     {settings["model"]}   size {settings["size"]}   quality {settings["quality"]}')
        print(f'out-dir   {out_dir}')
        print(f'workers   {args.workers}   attempts {settings["attempts"]}')
        for task in (task for layer in layers for task in layer):
            state = asset_state(task, settings)
            refs = ', '.join(ref.name for ref in task['references']) or '— (text to image)'
            gaps = [ref.name for ref in task['references'] if not ref.is_file()]
            print(f'  {task["name"]:14s} {state:6s} refs[{len(task["references"])}]: {refs}'
                  + (f'   MISSING: {", ".join(gaps)}' if gaps else ''))
        print('States use current reference bytes; downstream states are rechecked after references finish.')
        print(f'No requests were made. {len(tasks)} asset(s) planned.')
        return

    api_key = os.environ.get('OPENAI_API_KEY')
    if not api_key:
        parser.exit(2, 'Error: OPENAI_API_KEY is not set. Put it in the project .env.local '
                       '(never VITE_*). No requests were made.\n')

    if args.probe:
        probe(settings['base_url'], api_key, settings['model'], parser)
        return

    if args.verify:
        task = tasks[0]
        # Verifying an asset whose references do not exist yet would quietly fall back to
        # /images/generations, report success, and leave the /images/edits path — the one the
        # pages actually use — untested. Refuse instead of reporting a check that did not happen.
        gaps = [ref.name for ref in task['references'] if not ref.is_file()]
        if gaps:
            parser.exit(2, f'Error: --verify would not verify {task["name"]}: it declares '
                           f'{len(task["references"])} reference image(s) and {len(gaps)} do not exist yet '
                           f'({", ".join(gaps)}).\n'
                           f'It would silently test text-to-image on /images/generations instead of the '
                           f'/images/edits path this asset uses.\n'
                           f'Generate the reference sheets first (gen_art.py {" ".join(sorted(path.stem for path in (story / "prompts").glob("ref-*.txt"))) or "ref-*"}), '
                           f'or name an asset that has no references. For a free availability check, use --probe.\n')
        print(f'Verifying {task["name"]} against {settings["base_url"]} — this costs one generation.')
        print(f'provider   {settings["base_url"]}   model {settings["model"]}')
        files = [(name, path.name, data, image_kind(data) or 'image/png')
                 for name, path, data in ((f'image[]', ref, ref.read_bytes())
                                          for ref in task['references'])]
        endpoint = f'{settings["base_url"]}/images/edits' if files else f'{settings["base_url"]}/images/generations'
        fields = [('model', settings['model']), ('prompt', task['prompt']),
                  ('size', settings['size']), ('quality', settings['quality']), ('n', 1)]
        print(f'endpoint   {endpoint}')
        print(f'image order {[name for _, name, _, _ in files] or "— none (text to image; the edits path is NOT covered)"}')
        document = call_api(endpoint, fields, files, api_key, settings['timeout'])
        print(f'response[data[0]] keys: {sorted(document["data"][0].keys())}')
        print('This verifies this provider and model only; a relay or a different model needs its own run.')
        return

    # Create the output directory before the first paid request, so a typo or a permission
    # problem costs nothing. run_target creates it again defensively, because by then the
    # image has already been generated and paid for.
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        parser.exit(2, f'Error: cannot write the output directory {out_dir}: {error}\n')

    code = run_batch(tasks, settings, api_key, log_dir, args.workers,
                     force=args.force, refresh_stale=args.refresh_stale)
    if code:
        sys.exit(code)


if __name__ == '__main__':
    # A missing directory, a full disk or an unreachable endpoint is a message, not a Python
    # stack trace. Anything genuinely unexpected still raises, with the traceback intact.
    try:
        main()
    except OSError as error:
        sys.stderr.write(f'Error: {error}\n')
        sys.exit(1)
    except ApiError as error:
        sys.stderr.write(f'Error: {error}\n')
        sys.exit(1)
