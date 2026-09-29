import argparse
import base64
import copy
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

spec = importlib.util.spec_from_file_location('builder', Path(__file__).with_name('build_book.py'))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=')

class BookTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)/'stories/test-v1'
        self.root.mkdir(parents=True)
        (self.root/'art').mkdir()
        (self.root/'art/a.png').write_bytes(PNG)
        self.page = {'text': 'Milo & Pip say, "Let us try!"', 'art': 'art/a.png'}
        self.manifest = {'id': 'test-v1', 'title': 'Milo and Pip', 'age_range': '4-7', 'cover': self.page, 'back_cover': self.page, 'spreads': [{'theme': 'A New Friend', 'left': self.page, 'right': self.page} for _ in range(4)]}
    def tearDown(self):
        self.tmp.cleanup()
    def test_order(self):
        data = builder.content(self.manifest)
        self.assertEqual(len(data['sheets']), 5)
        self.assertEqual(len(data['chapters']), 6)
        self.assertTrue(data['sheets'][0]['front']['cover'])
        self.assertTrue(data['sheets'][-1]['back']['end'])
        numbers = [side['number'] for sheet in data['sheets'] for side in (sheet['front'], sheet['back']) if 'number' in side]
        self.assertEqual(numbers, [f'{i:02}' for i in range(1,9)])
    def test_xml_and_exact_text(self):
        root = ET.fromstring(builder.compose(self.page, False, self.root))
        self.assertIn(self.page['text'], ''.join(root.itertext()))
        self.assertIn('data:image/png;base64,', ET.tostring(root).decode())
    def test_missing_art_draft_vs_final(self):
        (self.root/'art/a.png').unlink()
        self.assertTrue(builder.validate(self.manifest, self.root, False)[1])
        with self.assertRaises(ValueError): builder.validate(self.manifest, self.root, True)
    def test_reject_escape_and_symlink(self):
        for art in ('../secret.png', '/tmp/secret.png'):
            m = copy.deepcopy(self.manifest); m['cover']['art'] = art
            with self.assertRaises(ValueError): builder.validate(m, self.root, False)
        (self.root/'art/link').symlink_to('/tmp')
        m = copy.deepcopy(self.manifest); m['cover']['art'] = 'art/link/out.png'
        with self.assertRaises(ValueError): builder.validate(m, self.root, False)
    def test_reject_overflow(self):
        with self.assertRaises(ValueError): builder.wrapped('Long story. ' * 200, 44, 6)
        with self.assertRaises(ValueError): builder.wrapped('W'*80, 44, 6)
    def test_reject_invalid_art(self):
        (self.root/'art/a.png').write_text('not an image')
        with self.assertRaises(ValueError): builder.validate(self.manifest, self.root, True)
    def test_reject_invalid_schema(self):
        for field, value in [('id', '../bad'), ('spreads', []), ('title', '')]:
            m = copy.deepcopy(self.manifest); m[field] = value
            with self.assertRaises(ValueError): builder.validate(m, self.root, False)
    def test_layout_rules(self):
        def options(**overrides):
            base = {'manifest': self.root/'manifest.json', 'project': None, 'story_dir': None}
            base.update(overrides)
            return argparse.Namespace(**base)
        # The conventional stories/<id>/ layout keeps building with no flags at all.
        # resolve() both sides: macOS resolves /var through the /private symlink.
        self.assertEqual(builder.layout(options(), self.manifest), self.root.resolve())
        # A story kept somewhere else is refused unless the caller says so explicitly.
        elsewhere = (Path(self.tmp.name)/'elsewhere/test-v1').resolve()
        elsewhere.mkdir(parents=True)
        with self.assertRaises(ValueError):
            builder.layout(options(manifest=elsewhere/'manifest.json'), self.manifest)
        for overrides in ({'project': Path(self.tmp.name)}, {'story_dir': 'elsewhere'}):
            self.assertEqual(builder.layout(options(manifest=elsewhere/'manifest.json', **overrides), self.manifest), elsewhere)
        # A folder whose name disagrees with the id is refused in every case.
        wrong = (Path(self.tmp.name)/'stories/other-id').resolve()
        wrong.mkdir(parents=True)
        with self.assertRaises(ValueError):
            builder.layout(options(manifest=wrong/'manifest.json', project=Path(self.tmp.name)), self.manifest)

    def test_build_and_no_overwrite(self):
        path = self.root/'manifest.json'; path.write_text(json.dumps(self.manifest))
        output = self.root/'pages/v1'
        cmd = [sys.executable, str(Path(builder.__file__)), str(path), '--output', str(output)]
        run = subprocess.run(cmd, capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(len(list(output.glob('*.svg'))), 10)
        self.assertTrue((self.root/'art/a.png').is_file())
        self.assertTrue((self.root/'content.js').is_file())
        self.assertTrue((self.root/'narration.js').is_file())
        self.assertEqual(subprocess.run(cmd, capture_output=True).returncode, 1)
        builder.validate(json.loads(path.read_text()), self.root, True)
        cmd[-1] = str(self.root.parent/'misplaced')
        self.assertEqual(subprocess.run(cmd, capture_output=True).returncode, 1)
        self.assertFalse((self.root.parent/'misplaced').exists())

if __name__ == '__main__': unittest.main()
