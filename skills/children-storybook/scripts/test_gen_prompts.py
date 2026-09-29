"""Offline tests for gen_prompts.py.

The shipped example doubles as the golden file: regenerating its prompts must reproduce
the committed ones exactly. That is the regression guard proving the prompt-engineering
format did not drift.
"""
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SKILL = HERE.parent
EXAMPLE = SKILL / 'examples' / 'goldilocks'

spec = importlib.util.spec_from_file_location('gen_prompts', HERE / 'gen_prompts.py')
gen_prompts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gen_prompts)


class ParserTests(unittest.TestCase):
    def write(self, name, text):
        path = Path(self.tmp.name) / name
        path.write_text(text, encoding='utf-8')
        return path

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def test_continuations_join_with_one_space(self):
        book, _ = gen_prompts.parse(self.write('characters.md', 'style: one\n  two\n  three\n'))
        self.assertEqual(book['style'], 'one two three')

    def test_prose_with_colons_stays_in_the_value(self):
        # A key line must look like lowercase_key: — capitalised prose continues the value.
        _, sections = gen_prompts.parse(self.write(
            'characters.md', '## ref-a\nbible: A fox.\nNote: he is kind.\nAnd: so is she.\n'))
        self.assertEqual(sections['ref-a']['bible'], 'A fox. Note: he is kind. And: so is she.')

    def test_full_width_colon_is_not_a_key(self):
        path = self.write('characters.md', '## ref-a\nbible: 一只狐狸：很善良。\n')
        _, sections = gen_prompts.parse(path)
        self.assertEqual(sections['ref-a']['bible'], '一只狐狸：很善良。')

    def test_duplicate_keys_and_sections_are_rejected(self):
        with self.assertRaises(ValueError):
            gen_prompts.parse(self.write('characters.md', 'style: a\nstyle: b\n'))
        with self.assertRaises(ValueError):
            gen_prompts.parse(self.write('characters.md', '## ref-a\nbible: x\n## ref-a\nbible: y\n'))


class ExampleTests(unittest.TestCase):
    def test_regenerating_the_example_is_byte_identical(self):
        settings, prompts, provenance, ref_map = gen_prompts.collect(EXAMPLE)
        self.assertEqual(len(prompts), 26)
        self.assertEqual(len(ref_map), 2)
        for name, text in prompts:
            committed = (EXAMPLE / 'prompts' / f'{name}.txt').read_text(encoding='utf-8')
            self.assertEqual(text, committed, f'{name}.txt drifted from characters.md/scenes.md')

    def test_check_reports_no_drift(self):
        result = subprocess.run([sys.executable, str(HERE / 'gen_prompts.py'),
                                 '--story', str(EXAMPLE), '--check'],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report['changed'], [])
        self.assertEqual(report['missing_from_scenes'], [])
        self.assertFalse(report['written'])

    def test_every_reference_line_resolves_and_stays_inside_the_story(self):
        # gen_art.py maps these lines back to files; an unresolvable one is a hard error there.
        # The example ships page art but not the reference sheets — those were generation
        # inputs, never embedded in a page — so resolution is what is asserted here, not
        # existence. gen_art reports a missing reference at run time.
        import importlib.util as util
        spec = util.spec_from_file_location('gen_art', HERE / 'gen_art.py')
        gen_art = util.module_from_spec(spec)
        sys.modules['gen_art'] = gen_art
        spec.loader.exec_module(gen_art)
        ref_map = json.loads((EXAMPLE / 'ref-map.json').read_text())
        for prompt in sorted((EXAMPLE / 'prompts').glob('*.txt')):
            references, unresolved = gen_art.resolve_references(
                prompt.read_text(encoding='utf-8'), EXAMPLE, ref_map)
            self.assertEqual(unresolved, [], f'{prompt.name} has an unresolvable reference')
            for reference in references:
                self.assertTrue(reference.is_relative_to(EXAMPLE), f'{prompt.name} escapes the story')

    def test_page_art_named_by_the_manifest_all_exists(self):
        manifest = json.loads((EXAMPLE / 'manifest.json').read_text())
        pages = [manifest['cover'], manifest['back_cover']]
        for spread in manifest['spreads']:
            pages += [spread['left'], spread['right']]
        for page in pages:
            self.assertTrue((EXAMPLE / page['art']).is_file(), f'missing {page["art"]}')

    def test_reference_count_matches_the_declared_order(self):
        # page-09 cites both sheets; the order must follow scenes.md.
        text = (EXAMPLE / 'prompts' / 'page-09.txt').read_text(encoding='utf-8')
        first = text.index('Reference image 1:')
        second = text.index('Reference image 2:')
        self.assertLess(first, second)
        self.assertIn('Goldilocks', text[first:second])
        self.assertIn('Papa Bear', text[second:])


if __name__ == '__main__':
    unittest.main()
