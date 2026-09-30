#!/usr/bin/env python3
"""Make ONE small sampled contact sheet for agent review; never print image payloads.

python3 "$SKILL/scripts/preview_art.py" --story "$PROJECT/stories/<id>"
Use --source qa/pages for composed-page screenshots, or --names page-03.png for a
user-reported problem. Sources and output stay inside the story. Requires ffmpeg.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile

from env_file import load_env_local, resolve_project

MAX_BYTES = 250_000
EXTENSIONS = {'.png', '.jpg', '.jpeg', '.webp'}


def inside(story, candidate):
    resolved = candidate.resolve()
    if not resolved.is_relative_to(story):
        raise ValueError(f'Preview path must stay inside the story: {candidate}')
    return resolved


def sample(paths):
    """At most four evenly spaced assets; no requirement to see the rest."""
    if len(paths) <= 4:
        return paths
    return [paths[round(i * (len(paths) - 1) / 3)] for i in range(4)]


def ffmpeg(args, data=None):
    result = subprocess.run([os.environ.get('FFMPEG_PATH', 'ffmpeg'), '-v', 'error',
                             '-nostdin', *args], input=data, capture_output=True, timeout=90)
    if result.returncode:
        raise ValueError('ffmpeg preview failed: ' + result.stderr.decode(errors='replace')[-1000:])
    return result.stdout


def preview(story, source='art', names=None):
    story = Path(story).resolve()
    if not story.is_dir():
        raise ValueError(f'No story directory: {story}')
    source_dir = inside(story, story / source)
    if names:
        if len(names) > 4:
            raise ValueError('Choose at most four assets; review is sampled, not exhaustive.')
        paths = [inside(story, source_dir / name) for name in names]
    else:
        paths = sorted((inside(story, p) for p in source_dir.iterdir()
                        if p.is_file() and p.suffix.lower() in EXTENSIONS),
                       key=lambda p: (0 if p.stem == 'cover' else 2 if p.stem == 'back' else 1, p.name))
        # Reference sheets are generation inputs; no separate inspection gate is needed.
        pages = [p for p in paths if not p.stem.startswith('ref-')]
        paths = pages or paths
    if not paths:
        raise ValueError(f'No raster images in {source_dir}')
    if any(not p.is_file() or p.suffix.lower() not in EXTENSIONS for p in paths):
        raise ValueError('Preview inputs must be existing PNG, JPEG or WebP files.')
    selected = sample(paths)
    output_dir = inside(story, story / 'qa' / 'previews')
    output_dir.mkdir(parents=True, exist_ok=True)
    # A fixed output prevents agents from opening a growing collection of preview sheets.
    output = inside(story, output_dir / 'sample.jpg')
    report = inside(story, output_dir / 'sample.json')
    with tempfile.TemporaryDirectory(prefix='.preview-', dir=output_dir) as temporary:
        target = Path(temporary) / 'sample.jpg'
        for width in (480, 360, 240):
            height = width * 2 // 3
            cells = []
            for file in selected:
                filters = (f'scale={width}:{height}:force_original_aspect_ratio=decrease,'
                           f'pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=white,setsar=1')
                pixels = ffmpeg(['-i', str(file), '-vf', filters, '-frames:v', '1',
                                 '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'])
                if len(pixels) != width * height * 3:
                    raise ValueError(f'Could not decode preview: {file.name}')
                cells.append(pixels)
            cells += [bytes([255]) * width * height * 3] * (4 - len(cells))
            ffmpeg(['-y', '-f', 'rawvideo', '-pixel_format', 'rgb24',
                    '-video_size', f'{width}x{height}', '-i', 'pipe:0',
                    '-vf', 'tile=2x2:nb_frames=4', '-frames:v', '1', '-q:v', '8',
                    '-update', '1', str(target)], b''.join(cells))
            if target.stat().st_size <= MAX_BYTES:
                break
        else:
            raise ValueError('Could not meet preview byte budget; do not load the originals.')
        metadata = {'preview': str(output), 'bytes': target.stat().st_size,
                    'width': width * 2, 'height': height * 2,
                    'available': len(paths), 'sampled': len(selected),
                    'slots': [str(p.relative_to(story)) for p in selected],
                    'scope': 'Sample only, row-major order; remaining cells are blank. Not a full image audit.'}
        target.replace(output)
        temporary_report = Path(temporary) / 'sample.json'
        temporary_report.write_text(json.dumps(metadata, indent=2) + '\n')
        temporary_report.replace(report)
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--story', required=True, type=Path)
    parser.add_argument('--project', type=Path)
    parser.add_argument('--source', default='art', help='Story-relative raster directory (default: art)')
    parser.add_argument('--names', nargs='+', help='Up to four exact filenames for targeted follow-up')
    args = parser.parse_args()
    load_env_local(resolve_project(args.project))
    print(json.dumps(preview(args.story, args.source, args.names), indent=2))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        raise SystemExit(f'Error: {error}')
