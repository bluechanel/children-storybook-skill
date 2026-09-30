"""Offline checks for bounded previews; ffmpeg is an existing skill prerequisite."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest

from preview_art import MAX_BYTES, preview, sample


class PreviewTests(unittest.TestCase):
    def test_sample_never_expands_to_exhaustive_review(self):
        self.assertEqual(sample(list(range(24))), [0, 8, 15, 23])
        self.assertEqual(sample([1]), [1])

    def test_source_cannot_escape_story(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaisesRegex(ValueError, 'inside the story'):
                preview(Path(root), '../')

    @unittest.skipUnless(shutil.which(os.environ.get('FFMPEG_PATH', 'ffmpeg')), 'ffmpeg unavailable')
    def test_real_preview_is_bounded_and_keeps_originals(self):
        art = Path(__file__).resolve().parents[1] / 'examples/goldilocks/art'
        with tempfile.TemporaryDirectory() as root:
            story = Path(root)
            shutil.copytree(art, story / 'art')
            before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (story / 'art').iterdir()}
            result = preview(story)
            output = Path(result['preview'])
            self.assertEqual(result['sampled'], 4)
            self.assertGreater(result['available'], 4)
            self.assertLessEqual(result['bytes'], MAX_BYTES)
            self.assertEqual(result['bytes'], output.stat().st_size)
            self.assertLessEqual(result['width'], 960)
            self.assertLessEqual(result['height'], 640)
            self.assertTrue(output.read_bytes().startswith(b'\xff\xd8'))
            self.assertEqual(json.loads(output.with_suffix('.json').read_text()), result)
            self.assertEqual(before, {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (story / 'art').iterdir()})
            targeted = preview(story, names=['cover.jpg'])
            self.assertEqual(targeted['slots'], ['art/cover.jpg'])
            self.assertEqual(targeted['sampled'], 1)
            with self.assertRaisesRegex(ValueError, 'at most four'):
                preview(story, names=['cover.jpg'] * 5)


if __name__ == '__main__':
    unittest.main()
