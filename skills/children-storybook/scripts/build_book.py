#!/usr/bin/env python3
"""Validate a story manifest and compose self-contained SVG page documents."""
import argparse
import base64
import json
import os
import re
import shutil
import tempfile
import time
from pathlib import Path
from xml.sax.saxutils import escape


def wrapped(text, font, limit):
    if not isinstance(text, str) or not text.strip():
        raise ValueError('Every page needs non-empty text.')
    if any(ord(c) < 32 and c not in '\n\t\r' for c in text):
        raise ValueError('Text contains unsupported control characters.')
    # Conservative character widths allow long English words without clipping.
    def width(word):
        return sum(1.05 if c in 'MW@%' else .34 if c in 'il.,!\' ' else .66 for c in word) * font
    lines, line = [], ''
    for word in text.split():
        if width(word) > 864:
            raise ValueError(f'Word does not fit the page: {word}')
        candidate = f'{line} {word}'.strip()
        if width(candidate) > 864:
            lines.append(line)
            line = word
        else:
            line = candidate
    if line:
        lines.append(line)
    if len(lines) > limit:
        raise ValueError(f'Text needs {len(lines)} lines; maximum is {limit}. Rewrite more concisely.')
    return lines


def artwork(path):
    data = path.read_bytes()
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        mime = 'image/png'
    elif data.startswith(b'\xff\xd8\xff'):
        mime = 'image/jpeg'
    elif data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        mime = 'image/webp'
    else:
        raise ValueError(f'Unsupported artwork signature: {path}')
    return f'data:{mime};base64,' + base64.b64encode(data).decode('ascii')


def validate(manifest, root, require_art):
    if not isinstance(manifest, dict):
        raise ValueError('Manifest must be an object.')
    slug = manifest.get('id', '')
    if not isinstance(slug, str) or not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', slug):
        raise ValueError('id must be a lowercase ASCII slug.')
    for field in ('title', 'age_range'):
        if not isinstance(manifest.get(field), str) or not manifest[field].strip():
            raise ValueError(f'{field} is required.')
    spreads = manifest.get('spreads')
    if not isinstance(spreads, list) or not 1 <= len(spreads) <= 12:
        raise ValueError('Provide 1–12 spreads.')
    pages = [('cover', manifest.get('cover'), True)]
    for i, spread in enumerate(spreads):
        if not isinstance(spread, dict) or not isinstance(spread.get('theme'), str) or not spread['theme'].strip():
            raise ValueError(f'Spread {i + 1} needs a theme.')
        pages.extend([(f'page-{2*i+1:02}', spread.get('left'), False), (f'page-{2*i+2:02}', spread.get('right'), False)])
    pages.append(('back', manifest.get('back_cover'), True))
    missing = []
    for name, page, cover in pages:
        if not isinstance(page, dict):
            raise ValueError(f'Missing page object: {name}')
        wrapped(page.get('text'), 64 if cover else 44, 5 if cover else 6)
        art = page.get('art')
        if not isinstance(art, str) or not art or Path(art).is_absolute():
            raise ValueError(f'{name}: art must be a relative file path.')
        path = (root / art).resolve()
        if not path.is_relative_to(root.resolve()):
            raise ValueError(f'{name}: artwork path escapes the manifest directory.')
        if not path.is_file():
            missing.append(art)
        else:
            artwork(path)
    if require_art and missing:
        raise ValueError('Missing artwork: ' + ', '.join(missing))
    return pages, missing


def compose(page, cover, root):
    font, spacing = (64, 76) if cover else (44, 60)
    lines = wrapped(page['text'], font, 5 if cover else 6)
    text = '\n'.join(f'<text x="80" y="{985 + i*spacing}">{escape(line)}</text>' for i, line in enumerate(lines))
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1400" viewBox="0 0 1024 1400">
<rect width="1024" height="1400" fill="#f8f0df"/>
<svg width="1024" height="900" viewBox="0 0 1024 900" overflow="hidden">
<image width="1024" height="900" preserveAspectRatio="xMidYMid slice" href="{artwork(root / page['art'])}"/>
</svg>
<g fill="#263e53" font-family="Arial Rounded MT Bold,Arial,sans-serif" font-size="{font}" font-weight="{'600' if cover else '400'}">{text}</g>
</svg>\n'''


def content(manifest, version="v1"):
    slug = manifest['id']
    def side(name, page, **extra):
        return dict(text=page['text'], image=f'/stories/{slug}/pages/{version}/{name}.svg', **extra)
    sheets = [dict(front=side('cover', manifest['cover'], cover=True, title=manifest['title']))]
    for i, spread in enumerate(manifest['spreads']):
        sheets[-1]['back'] = side(f'page-{2*i+1:02}', spread['left'], number=f'{2*i+1:02}', label=spread['theme'])
        sheets.append(dict(front=side(f'page-{2*i+2:02}', spread['right'], number=f'{2*i+2:02}', label=spread['theme'])))
    sheets[-1]['back'] = side('back', manifest['back_cover'], cover=True, title=manifest['back_cover']['text'], end=True)
    return dict(storyId=slug, title=manifest['title'], subtitle='', sheets=sheets,
                chapters=['Cover'] + [s['theme'] for s in manifest['spreads']] + ['The End'])


def layout(args, manifest):
    """Resolve the story root, keeping the conventional layout as the default rule.

    Without --project or --story-dir the manifest must sit at <stories>/<id>/manifest.json,
    which is what the host app and its tests rely on. Naming a project or a stories folder
    explicitly is the caller saying the story legitimately lives somewhere else.
    """
    root = args.manifest.parent.resolve()
    if root.name != manifest['id']:
        raise ValueError('The manifest must live in a folder named after its id: <stories>/<id>/manifest.json.')
    stories = args.story_dir or os.environ.get('STORYBOOK_STORIES_DIR') or 'stories'
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]*', stories):
        raise ValueError('--story-dir must be a simple folder name.')
    if root.parent.name != stories and not (args.project or args.story_dir):
        raise ValueError(f'Build manifest must live at {stories}/<id>/manifest.json, '
                         f'or pass --project/--story-dir to build a story kept elsewhere.')
    return root


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest', type=Path)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--check', action='store_true')
    mode.add_argument('--output', type=Path, help='Must be <story>/pages/<version>')
    mode.add_argument('--build', help='New page version, e.g. v2')
    parser.add_argument('--project', type=Path, help='Host project root; allows a story kept outside <project>/stories/')
    parser.add_argument('--story-dir', help='Folder holding the stories (default: $STORYBOOK_STORIES_DIR or stories)')
    args = parser.parse_args()
    try:
        manifest = json.loads(args.manifest.read_text(encoding='utf-8'))
        pages, missing = validate(manifest, args.manifest.parent, not args.check)
        if args.check:
            print(json.dumps({'valid_plan': True, 'ready_to_build': not missing, 'missing_art': missing, 'interior_pages': len(pages)-2}, ensure_ascii=False))
            return
        root = layout(args, manifest)
        output = args.output.resolve() if args.output else root / 'pages' / args.build
        if output.parent != root / 'pages' or not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', output.name):
            raise ValueError('Page output must be <story>/pages/<version>.')
        if (root / 'pages').exists() and (root / 'pages').resolve() != root / 'pages':
            raise ValueError('Page output may not leave the story through a symlink.')
        if output.exists():
            raise ValueError('Output already exists; choose a new versioned directory.')
        output.parent.mkdir(parents=True, exist_ok=True)
        staging = Path(tempfile.mkdtemp(prefix='.storybook-', dir=output.parent))
        module = 'export const bookContent = ' + json.dumps(content(manifest, output.name), ensure_ascii=False, indent=2) + ';\n'
        try:
            for name, page, cover in pages:
                (staging / f'{name}.svg').write_text(compose(page, cover, root), encoding='utf-8')
            (staging / 'content.js').write_text(module, encoding='utf-8')
            staging.rename(output)
            active = root / 'content.js'
            if active.exists():
                backups = root / 'backups'
                backups.mkdir(exist_ok=True)
                shutil.copyfile(active, backups / f'content-{time.time_ns()}.js')
            temporary = root / '.content.tmp'
            temporary.write_text(module, encoding='utf-8')
            temporary.replace(active)
            if not (root / 'narration.js').exists():
                (root / 'narration.js').write_text('export const narrationConfig = {url:null};\n')
        finally:
            if staging.exists():
                shutil.rmtree(staging)
        print(json.dumps({'output': str(output), 'story': str(root), 'pages': len(pages), 'sheets': len(manifest['spreads'])+1}))
    except (ValueError, OSError, TypeError, KeyError) as error:
        parser.exit(1, f'Error: {error}\n')


if __name__ == '__main__':
    main()
