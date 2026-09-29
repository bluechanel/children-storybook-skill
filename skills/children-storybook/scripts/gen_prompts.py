#!/usr/bin/env python3
"""Expand a character bible and a scene list into one image prompt per asset.

Reads <story>/characters.md and <story>/scenes.md and writes <story>/prompts/<name>.txt,
one file per reference sheet and one per page. gen_art.py consumes those files, so the
prompt text stays the single source of truth rather than hiding inside a script.

  gen_prompts.py --story stories/<id> [--check]

Input format (see references/art-prompts.md): a block of `key: value` lines at the top of
characters.md holds the shared art direction; each `## <name>` heading starts a section
whose keys are `bible`/`sheet`/`keywords` (characters.md) or `refs`/`scene` (scenes.md).
A line is only read as a key when it looks like `lowercase_key:`, so ordinary prose
sentences — including ones containing colons — are safe as continuation lines.
"""
import argparse
import json
import re
from pathlib import Path

# Default art direction: the warm storybook look this pipeline was built around.
# A story overrides any of these by setting the same key at the top of characters.md.
DEFAULTS = {
    'size': '1536x1024',
    'quality': 'high',
    'style': 'warm hand-painted gouache and watercolour on textured cotton paper, rounded appealing '
             'silhouettes, expressive friendly faces, classic storybook illustration for ages 4-7, soft natural '
             'light, visible brush edges and paper grain.',
    'framing': 'one coherent scene, the main subjects inside the central 75 percent of the frame with space above '
               'the heads and below the feet, because the left and right edges will be cropped. Faces away from '
               'the left and right edges. No collage, no split panels, no borders, no frames.',
    'constraints': 'no text, letters, numbers, captions, signage, logos or watermarks; no extra characters; '
                   'no extra limbs; no sharp teeth, no claws, no frightening shadows.',
    'palette': 'moss and sage green, warm honey amber, cream paper, soft sky blue, butter yellow, rose pink, '
               'small strawberry-red accents.',
}

# A key line starts with a lowercase snake_case name and a colon. Anything else — prose,
# a wrapped continuation, a sentence with a colon in the middle — belongs to the value above.
_KEY = re.compile(r'^([a-z][a-z0-9_]*):\s?(.*)$')
_HEADING = re.compile(r'^##\s+(\S+)\s*$')


def parse(path):
    """Return (globals, sections) where sections maps a heading name to its keys."""
    try:
        text = path.read_text(encoding='utf-8')
    except FileNotFoundError:
        raise ValueError(f'Missing {path.name}. Run this from the story directory that has it.')
    book, sections, current, key = {}, {}, None, None
    for raw in text.splitlines():
        if not raw.strip():
            key = None
            continue
        heading = _HEADING.match(raw)
        if heading:
            current = heading.group(1)
            if current in sections:
                raise ValueError(f'{path.name}: duplicate section "## {current}".')
            sections[current] = {}
            key = None
            continue
        if raw.startswith('#'):
            continue
        match = _KEY.match(raw) if not raw[:1].isspace() else None
        if match:
            key = match.group(1)
            target = sections[current] if current else book
            if key in target:
                raise ValueError(f'{path.name}: duplicate key "{key}".')
            target[key] = match.group(2).strip()
        elif key is not None:
            # Continuation of the previous value, joined with a single space so the
            # rendered prompt does not depend on where the prose was wrapped.
            target = sections[current] if current else book
            target[key] = f'{target[key]} {raw.strip()}'.strip()
    return book, sections


def build_prompt(refs, scene, book):
    """Render one prompt file. The line order and wording are the format gen_art.py expects."""
    lines = ['Use case: illustration-story',
             "Asset type: children's picture-book page illustration, landscape frame"]
    for index, ref in enumerate(refs, 1):
        lines.append(f'Reference image {index}: {ref["bible"]} Use it ONLY to copy those character designs and '
                     f'the painting style. This is a NEW scene: change the background, camera angle, poses and '
                     f'lighting completely.')
    lines.append('Character designs to keep identical to the references: ' + ' '.join(ref['bible'] for ref in refs))
    lines.append('Style/medium: ' + book['style'])
    lines.append('Scene: ' + scene)
    lines.append('Composition/framing: ' + book['framing'])
    lines.append('Constraints: ' + book['constraints'] + ' Palette: ' + book['palette'])
    return '\n'.join(lines) + '\n'


def collect(story):
    """Read both input files and return the prompts to write plus their provenance."""
    book, references = parse(story / 'characters.md')
    _, scenes = parse(story / 'scenes.md')
    settings = {key: book.get(key, value) for key, value in DEFAULTS.items()}

    for name, section in references.items():
        if not name.startswith('ref-'):
            raise ValueError(f'characters.md: reference sections must be named "ref-<name>", found "{name}".')
        for field in ('bible', 'sheet'):
            if not section.get(field, '').strip():
                raise ValueError(f'characters.md: "{name}" needs a "{field}:".')
    if not scenes:
        raise ValueError('scenes.md has no "## <name>" sections.')

    prompts, provenance, ref_map = [], [], {}
    for name, section in references.items():
        # A reference sheet is generated from nothing but its own bible.
        prompts.append((name, build_prompt([], section['sheet'], settings)))
        provenance.append({'name': name, 'refs': [], 'kind': 'reference'})
        for keyword in [k.strip() for k in section.get('keywords', '').split(',') if k.strip()]:
            if keyword.lower() in ref_map:
                raise ValueError(f'characters.md: keyword "{keyword}" is claimed twice.')
            ref_map[keyword.lower()] = f'{name}.png'

    for name, section in scenes.items():
        if name.startswith('ref-'):
            raise ValueError(f'scenes.md: "{name}" collides with a reference section; rename it.')
        refs = [r.strip() for r in section.get('refs', '').split(',') if r.strip()]
        for ref in refs:
            if ref not in references:
                raise ValueError(f'scenes.md: "{name}" refers to "{ref}", which characters.md does not define.')
        prompts.append((name, build_prompt([{'bible': references[r]['bible']} for r in refs],
                                           section.get('scene', '').strip(), settings)))
        provenance.append({'name': name, 'refs': refs, 'kind': 'scene'})
    return settings, prompts, provenance, ref_map


def check_against_manifest(story, names):
    """Cross-check the scene list against the manifest so a missing page is caught early."""
    manifest_path = story / 'manifest.json'
    if not manifest_path.is_file():
        return []
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    expected = {'cover', 'back'}
    for index in range(len(manifest.get('spreads', []))):
        expected.update({f'page-{2*index+1:02}', f'page-{2*index+2:02}'})
    actual = {name for name in names if not name.startswith('ref-')}
    return sorted(expected - actual)


def write_provenance(story, settings, prompts, provenance):
    lines = ['# Image prompts', '',
             'Generated by `scripts/gen_prompts.py` from `characters.md` and `scenes.md`.',
             'Edit those two files and rerun; do not hand-edit `prompts/`.', '',
             f'- model size: `{settings["size"]}`', f'- quality: `{settings["quality"]}`', '',
             '| asset | references (in order) |', '| --- | --- |']
    for entry in provenance:
        lines.append(f'| `{entry["name"]}` | {", ".join(entry["refs"]) or "—"} |')
    lines += ['', '## Prompt text', '']
    for name, text in prompts:
        lines += [f'### {name}', '', '```text', text.rstrip('\n'), '```', '']
    (story / 'prompts.md').write_text('\n'.join(lines), encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--story', required=True, type=Path, help='Story directory holding characters.md and scenes.md')
    parser.add_argument('--check', action='store_true', help='Report drift without writing anything')
    args = parser.parse_args()

    story = args.story.resolve()
    if not story.is_dir():
        parser.exit(2, f'Error: no such story directory: {story}\n')
    try:
        settings, prompts, provenance, ref_map = collect(story)
        missing = check_against_manifest(story, [name for name, _ in prompts])
        out = story / 'prompts'
        changed = []
        for name, text in prompts:
            path = out / f'{name}.txt'
            previous = path.read_text(encoding='utf-8') if path.is_file() else None
            if previous != text:
                changed.append(name)
        print(json.dumps({'prompts': len(prompts), 'references': len(ref_map), 'changed': changed,
                          'missing_from_scenes': missing, 'size': settings['size'],
                          'quality': settings['quality'], 'written': not args.check}, ensure_ascii=False))
        if args.check:
            return
        out.mkdir(parents=True, exist_ok=True)
        for name, text in prompts:
            (out / f'{name}.txt').write_text(text, encoding='utf-8')
        # The keyword map lets gen_art.py resolve a prompt's "Reference image N:" lines to
        # files without hardcoding any character name in code.
        (story / 'ref-map.json').write_text(json.dumps(ref_map, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
        write_provenance(story, settings, prompts, provenance)
    except (ValueError, OSError, json.JSONDecodeError) as error:
        parser.exit(2, f'Error: {error}\n')


if __name__ == '__main__':
    main()
