#!/usr/bin/env python3
"""Recover artwork and manuscript text from a built story in dist/.

A composed page SVG embeds the original raster artwork as base64 and carries the exact
typeset text, and the narration timeline records every page's text in its contentKey. So
a story whose source directory was lost can be rebuilt from its build output.

  recover_example.py --dist dist/stories/<id> --out stories/<id>
  recover_example.py --dist dist/stories/<id> --manuscript /tmp/manuscript.json

Requires ffmpeg to re-encode the artwork (already a prerequisite of the video pipeline),
which keeps this script free of any Python imaging dependency.
"""
import argparse
import base64
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from xml.sax.saxutils import unescape

EMBEDDED = re.compile(r'href="data:image/(png|jpeg|webp);base64,([^"]+)"')
TEXT = re.compile(r'<text[^>]*>([^<]*)</text>')


def recover_art(dist, version, out, quality, max_width, ffmpeg):
    pages = sorted((dist / 'pages' / version).glob('*.svg'))
    if not pages:
        raise SystemExit(f'Error: no pages under {dist / "pages" / version}')
    art = out / 'art'
    art.mkdir(parents=True, exist_ok=True)
    total = 0
    with tempfile.TemporaryDirectory() as scratch:
        for page in pages:
            match = EMBEDDED.search(page.read_text(encoding='utf-8'))
            if not match:
                raise SystemExit(f'Error: {page.name} has no embedded artwork.')
            source = Path(scratch) / 'source.png'
            source.write_bytes(base64.b64decode(match.group(2)))
            target = art / f'{page.stem}.jpg'
            command = [ffmpeg, '-y', '-loglevel', 'error', '-i', str(source)]
            if max_width:
                command += ['-vf', f'scale={max_width}:-2']
            command += ['-q:v', str(quality), str(target)]
            result = subprocess.run(command, capture_output=True, text=True)
            if result.returncode != 0:
                raise SystemExit(f'Error: ffmpeg failed for {page.name}: {result.stderr.strip()[:300]}')
            size = target.stat().st_size
            total += size
            print(f'  {page.stem:10s} -> {target.name} ({size / 1e3:.0f} KB)')
    print(f'Recovered {len(pages)} images into {art} ({total / 1e6:.2f} MB total)')


def recover_manuscript(dist, destination):
    timelines = sorted((dist / 'audio').glob('*/timeline.json'))
    if not timelines:
        raise SystemExit(f'Error: no timeline.json under {dist / "audio"}')
    # The installed/final narration is the best authority; otherwise the newest one.
    timeline = next((t for t in timelines if 'final' in t.parent.name), timelines[-1])
    document = json.loads(timeline.read_text(encoding='utf-8'))
    pages = json.loads(document['contentKey'])
    if not isinstance(pages, list) or not pages:
        raise SystemExit('Error: the timeline contentKey holds no pages.')
    if destination:
        Path(destination).write_text(json.dumps(pages, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
        print(f'Wrote {len(pages)} pages of manuscript text to {destination}')
    else:
        for page in pages:
            print(f'{page["id"]}\t{page["text"]}')
    return pages, timeline


def cross_check(dist, version, pages):
    """The SVG text and the contentKey should agree; a mismatch means one of them is stale."""
    mismatches = []
    for page in pages:
        svg = dist / 'pages' / version / f'{page["id"]}.svg'
        if not svg.is_file():
            mismatches.append(f'{page["id"]}: no page document')
            continue
        drawn = unescape(' '.join(TEXT.findall(svg.read_text(encoding='utf-8')))).split()
        if ' '.join(drawn) != ' '.join(page['text'].split()):
            mismatches.append(f'{page["id"]}: page text differs from the timeline contentKey')
    return mismatches


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--dist', required=True, type=Path, help='Built story, e.g. dist/stories/<id>')
    parser.add_argument('--pages-version', default='v1')
    parser.add_argument('--out', type=Path, help='Story directory to write art/ into')
    parser.add_argument('--manuscript', type=Path, help='Write the recovered page text here as JSON')
    parser.add_argument('--quality', type=int, default=8, help='ffmpeg -q:v (2 best … 31 smallest)')
    parser.add_argument('--max-width', type=int, help='Downscale to this width, e.g. 768')
    parser.add_argument('--ffmpeg', default=None)
    args = parser.parse_args()

    dist = args.dist.resolve()
    if not (dist / 'pages' / args.pages_version).is_dir():
        parser.exit(2, f'Error: {dist} does not look like a built story.\n')
    ffmpeg = args.ffmpeg or os.environ.get('FFMPEG_PATH') or 'ffmpeg'
    try:
        pages, timeline = recover_manuscript(dist, args.manuscript)
        for problem in cross_check(dist, args.pages_version, pages):
            print(f'  ! {problem}', file=sys.stderr)
        if args.out:
            recover_art(dist, args.pages_version, args.out.resolve(), args.quality, args.max_width, ffmpeg)
        print(f'Source timeline: {timeline.relative_to(dist)}')
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        parser.exit(1, f'Error: {error}\n')


if __name__ == '__main__':
    main()
