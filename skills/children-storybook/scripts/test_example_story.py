"""Prove the shipped example builds offline: no API key, no network, no host scaffold.

The build runs from a clean temporary project and from a working directory outside it, so
this also exercises build_book.py's project resolution rather than any local convenience.
"""
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

HERE = Path(__file__).resolve().parent
EXAMPLE = HERE.parent / 'examples' / 'goldilocks'
STORY_ID = 'goldilocks-and-the-three-bears-v1'


def build_book(*args, cwd=None):
    return subprocess.run([sys.executable, str(HERE / 'build_book.py'), *args],
                          capture_output=True, text=True, cwd=cwd)


class ExampleStoryTests(unittest.TestCase):
    def test_check_reports_ready_to_build(self):
        result = build_book(str(EXAMPLE / 'manifest.json'), '--check')
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertTrue(report['valid_plan'])
        self.assertTrue(report['ready_to_build'], 'the example must ship usable artwork')
        self.assertEqual(report['missing_art'], [])
        self.assertEqual(report['interior_pages'], 22)

    def test_two_pages_per_spread_and_matching_cover_art(self):
        manifest = json.loads((EXAMPLE / 'manifest.json').read_text())
        self.assertEqual(len(manifest['spreads']), 11)
        for spread in manifest['spreads']:
            for side in ('left', 'right'):
                self.assertTrue(spread[side]['text'].strip())
                self.assertTrue((EXAMPLE / spread[side]['art']).is_file())

    def test_builds_in_a_clean_project_from_an_unrelated_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / 'project'
            story = project / 'stories' / STORY_ID
            story.parent.mkdir(parents=True)
            shutil.copytree(EXAMPLE, story)
            manifest = json.loads((story / 'manifest.json').read_text())

            # cwd is / so the build cannot rely on being run from inside the project.
            result = build_book(str(story / 'manifest.json'), '--build', 'v1',
                                '--project', str(project), cwd='/')
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(result.stdout)
            self.assertEqual(report['pages'], 24)
            self.assertEqual(report['sheets'], 12)

            pages = sorted(path.name for path in (story / 'pages' / 'v1').glob('*.svg'))
            self.assertEqual(len(pages), 24)
            self.assertEqual(pages[0], 'back.svg')
            self.assertIn('cover.svg', pages)
            self.assertIn('page-22.svg', pages)
            self.assertTrue((story / 'content.js').is_file())
            self.assertTrue((story / 'narration.js').is_file())
            self.assertIn('url:null', (story / 'narration.js').read_text())

            # The exact manuscript text must survive into the composed page document.
            first = manifest['spreads'][0]['left']['text']
            drawn = ' '.join(ET.fromstring((story / 'pages/v1/page-01.svg').read_text()).itertext())
            self.assertIn(' '.join(first.split()), ' '.join(drawn.split()))

            content = (story / 'content.js').read_text()
            self.assertIn(f'/stories/{STORY_ID}/pages/v1/cover.svg', content)

    def test_nothing_is_written_outside_the_story(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / 'project'
            story = project / 'stories' / STORY_ID
            story.parent.mkdir(parents=True)
            shutil.copytree(EXAMPLE, story)
            before = {path for path in project.rglob('*')}
            result = build_book(str(story / 'manifest.json'), '--build', 'v1', cwd=str(project))
            self.assertEqual(result.returncode, 0, result.stderr)
            added = {path for path in project.rglob('*')} - before
            escaped = [path for path in added if not path.is_relative_to(story)]
            self.assertEqual(escaped, [], f'build wrote outside the story: {escaped}')


if __name__ == '__main__':
    unittest.main()
