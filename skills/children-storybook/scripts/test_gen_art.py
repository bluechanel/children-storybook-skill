"""Offline tests for gen_art.py. No network, no credentials.

The single HTTP seam (_http) is replaced, so these tests check the request that would be
sent — above all that the reference images are encoded in the order the prompt describes.
"""
import base64
import contextlib
import importlib.util
import io
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('gen_art', Path(__file__).with_name('gen_art.py'))
gen_art = importlib.util.module_from_spec(spec)
sys.modules['gen_art'] = gen_art
spec.loader.exec_module(gen_art)

PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=')

PROMPT = ("Use case: illustration-story\n"
          "Asset type: children's picture-book page illustration, landscape frame\n"
          "Reference image 1: Alpha, a round friendly fox.\n"
          "Reference image 2: Bravo, a tall grey heron.\n"
          "Scene: A sunny clearing.\n")


def live(entry):
    """A page prompt that cites the two reference sheets in a known order."""
    return PROMPT


def image_order(body):
    return re.findall(rb'name="image\[\]"; filename="([^"]+)"', body)


def b64_response():
    return json.dumps({'data': [{'b64_json': base64.b64encode(PNG).decode('ascii')}]}).encode()


class GenArtTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.story = Path(self.tmp.name) / 'stories' / 'demo-v1'
        (self.story / 'prompts').mkdir(parents=True)
        (self.story / 'art').mkdir()
        for name in ('ref-a', 'ref-b'):
            (self.story / 'art' / f'{name}.png').write_bytes(PNG)
        (self.story / 'prompts' / 'page-01.txt').write_text(PROMPT, encoding='utf-8')
        (self.story / 'ref-map.json').write_text(json.dumps({'alpha': 'ref-a.png', 'bravo': 'ref-b.png'}))
        self.project = Path(self.tmp.name)
        self.calls = []
        # A stand-in key so the tests never depend on, or reach for, the real one.
        import os
        self.saved_key = os.environ.get('OPENAI_API_KEY')
        os.environ['OPENAI_API_KEY'] = 'sk-test-not-a-real-key'

    def tearDown(self):
        import os
        if self.saved_key is None:
            os.environ.pop('OPENAI_API_KEY', None)
        else:
            os.environ['OPENAI_API_KEY'] = self.saved_key
        self.tmp.cleanup()

    def run_cli(self, argv, handler):
        """Invoke main() with a stubbed network seam; return (exit code, stdout).

        --project points at the temp directory so the run never picks up the real
        .env.local from whatever directory the tests happen to be launched in.
        """
        def http(url, body, content_type, api_key, timeout):
            self.calls.append({'url': url, 'body': body, 'content_type': content_type, 'key': api_key})
            return handler(len(self.calls), url, body)
        return self.run_cli_with(argv, http)

    def run_cli_with(self, argv, http):
        """Same, but with a http(url, body, content_type, api_key, timeout) seam of your own."""
        original_http, original_argv = gen_art._http, sys.argv
        gen_art._http = http
        buffer = io.StringIO()
        code = 0
        try:
            sys.argv = ['gen_art.py', '--project', str(self.project)] + argv
            # stderr joins stdout: argparse reports usage and configuration errors there, and
            # those messages are exactly what these tests are about.
            with contextlib.redirect_stdout(buffer), contextlib.redirect_stderr(buffer):
                gen_art.main()
        except SystemExit as exit_request:
            code = exit_request.code
            # SystemExit with a message string means "failed", i.e. exit code 1.
            code = 0 if code is None else code if isinstance(code, int) else 1
        finally:
            gen_art._http, sys.argv = original_http, original_argv
        return code, buffer.getvalue()

    def test_reference_images_keep_prompt_order(self):
        code, _ = self.run_cli(['--story', str(self.story), 'page-01',
                                '--model', 'm', '--retry-delay', '0'],
                               lambda n, url, body: (200, b64_response()))
        self.assertEqual(code, 0)
        self.assertEqual(image_order(self.calls[0]['body']), [b'ref-a.png', b'ref-b.png'])
        self.assertTrue((self.story / 'art' / 'page-01.png').read_bytes().startswith(b'\x89PNG'))

    def test_no_reference_lines_uses_text_to_image(self):
        (self.story / 'prompts' / 'ref-a.txt').write_text('Scene: A character sheet.\n', encoding='utf-8')
        # --force: art/ref-a.png already exists as a reference for the page prompt.
        code, _ = self.run_cli(['--story', str(self.story), 'ref-a', '--force', '--retry-delay', '0'],
                               lambda n, url, body: (200, b64_response()))
        self.assertEqual(code, 0)
        self.assertTrue(self.calls[0]['url'].endswith('/images/generations'))
        self.assertEqual(image_order(self.calls[0]['body']), [])

    def test_json_requests_type_n_as_a_number(self):
        """A strict gateway rejects "n": "1"; JSON is typed, so n must go out as a number."""
        (self.story / 'prompts' / 'ref-a.txt').write_text('Scene: A character sheet.\n', encoding='utf-8')
        code, _ = self.run_cli(['--story', str(self.story), 'ref-a', '--force', '--retry-delay', '0'],
                               lambda n, url, body: (200, b64_response()))
        self.assertEqual(code, 0)
        self.assertEqual(self.calls[0]['content_type'], 'application/json')
        body = json.loads(self.calls[0]['body'])
        self.assertIsInstance(body['n'], int)
        self.assertEqual(body['n'], 1)

    def test_multipart_requests_still_carry_n(self):
        """The reference-image path is a form, where n stays the string every server coerces."""
        code, _ = self.run_cli(['--story', str(self.story), 'page-01', '--retry-delay', '0'],
                               lambda n, url, body: (200, b64_response()))
        self.assertEqual(code, 0)
        self.assertIn(b'name="n"\r\n\r\n1\r\n', self.calls[0]['body'])

    def test_json_typing_leaves_text_fields_alone(self):
        """Only known numeric names are coerced; a prompt of "1" is still the string "1"."""
        body = json.loads(gen_art.json_body([('prompt', '1'), ('size', '1024x1024'),
                                             ('quality', 'high'), ('seed', 'auto')]))
        self.assertEqual(body['prompt'], '1')
        self.assertEqual(body['size'], '1024x1024')
        self.assertEqual(body['quality'], 'high')
        self.assertEqual(body['seed'], 'auto', 'an unparseable value is passed through as written')

    def test_numeric_extras_are_typed(self):
        """--extra is the escape hatch for parameters the API grows, numbers included."""
        (self.story / 'prompts' / 'ref-a.txt').write_text('Scene: A character sheet.\n', encoding='utf-8')
        code, _ = self.run_cli(['--story', str(self.story), 'ref-a', '--force', '--retry-delay', '0',
                                '--extra', 'seed=42', '--extra', 'style=vivid'],
                               lambda n, url, body: (200, b64_response()))
        self.assertEqual(code, 0)
        body = json.loads(self.calls[0]['body'])
        self.assertEqual(body['seed'], 42)
        self.assertEqual(body['style'], 'vivid')

    def test_url_response_is_downloaded(self):
        def handler(n, url, body):
            return 200, b'{"data":[{"url":"https://cdn.example.test/a.png"}]}'
        original = gen_art.urllib.request.urlopen

        class FakeResponse:
            status = 200

            def read(self):
                return PNG

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        def fake_urlopen(request, timeout=None):
            if isinstance(request, str):
                return FakeResponse()
            return original(request, timeout=timeout)

        gen_art.urllib.request.urlopen = fake_urlopen
        try:
            code, _ = self.run_cli(['--story', str(self.story), 'page-01', '--retry-delay', '0'], handler)
        finally:
            gen_art.urllib.request.urlopen = original
        self.assertEqual(code, 0)
        self.assertTrue((self.story / 'art' / 'page-01.png').is_file())

    def test_skip_existing_and_force(self):
        destination = self.story / 'art' / 'page-01.png'
        destination.write_bytes(PNG)
        code, output = self.run_cli(['--story', str(self.story), 'page-01'],
                                    lambda n, url, body: (200, b64_response()))
        self.assertEqual(code, 0)
        self.assertEqual(self.calls, [])
        self.assertIn('[skip]', output)

        code, _ = self.run_cli(['--story', str(self.story), 'page-01', '--force', '--retry-delay', '0'],
                               lambda n, url, body: (200, b64_response()))
        self.assertEqual(code, 0)
        self.assertEqual(len(self.calls), 1)

    def test_retries_rate_limit_but_not_bad_request(self):
        def flaky(n, url, body):
            return (429, b'{"error":{"message":"slow down"}}') if n == 1 else (200, b64_response())
        code, _ = self.run_cli(['--story', str(self.story), 'page-01', '--attempts', '3', '--retry-delay', '0'], flaky)
        self.assertEqual(code, 0)
        self.assertEqual(len(self.calls), 2)

        self.calls.clear()
        (self.story / 'art' / 'page-01.png').unlink()
        code, _ = self.run_cli(['--story', str(self.story), 'page-01', '--attempts', '3', '--retry-delay', '0'],
                               lambda n, url, body: (400, b'{"error":{"message":"moderation refused"}}'))
        self.assertEqual(code, 1)
        self.assertEqual(len(self.calls), 1, 'a 400 must fail fast, never be retried blindly')

    def test_auth_failure_exits_three(self):
        code, _ = self.run_cli(['--story', str(self.story), 'page-01', '--retry-delay', '0'],
                               lambda n, url, body: (401, b'{"error":{"message":"bad key"}}'))
        self.assertEqual(code, 3)

    def test_non_image_response_is_rejected(self):
        code, _ = self.run_cli(['--story', str(self.story), 'page-01', '--retry-delay', '0'],
                               lambda n, url, body: (200, json.dumps(
                                   {'data': [{'b64_json': base64.b64encode(b'<html>nope</html>').decode()}]}).encode()))
        self.assertEqual(code, 1)
        self.assertFalse((self.story / 'art' / 'page-01.png').exists())

    def test_missing_key_makes_no_request(self):
        import os
        saved = os.environ.pop('OPENAI_API_KEY', None)
        try:
            code, output = self.run_cli(['--story', str(self.story), 'page-01'],
                                        lambda n, url, body: self.fail('must not call the API'))
        finally:
            if saved is not None:
                os.environ['OPENAI_API_KEY'] = saved
        self.assertEqual(code, 2)
        self.assertEqual(self.calls, [])

    def test_dry_run_makes_no_request(self):
        code, output = self.run_cli(['--story', str(self.story), '--dry-run'],
                                    lambda n, url, body: self.fail('must not call the API'))
        self.assertEqual(code, 0)
        self.assertIn('No requests were made', output)
        self.assertIn('ref-a.png', output)

    def test_unresolved_reference_is_reported(self):
        (self.story / 'prompts' / 'page-02.txt').write_text(
            'Reference image 1: Charlie, a badger nobody declared.\nScene: x.\n', encoding='utf-8')
        code, _ = self.run_cli(['--story', str(self.story), 'page-02'], lambda n, url, body: (200, b64_response()))
        self.assertEqual(code, 2)

    def test_the_key_never_reaches_a_log(self):
        (self.story / 'qa').mkdir(exist_ok=True)
        self.run_cli(['--story', str(self.story), 'page-01', '--attempts', '1', '--retry-delay', '0'],
                     lambda n, url, body: (500, b'{"error":{"message":"boom"}}'))
        for log in (self.story / 'qa' / 'art-logs').glob('*'):
            self.assertNotIn('sk-secret', log.read_text(encoding='utf-8'))

    def test_a_truncated_response_is_retried_not_fatal(self):
        """http.client.IncompleteRead is an HTTPException, not an OSError.

        A proxy that cuts a response body short used to send the exception straight through
        the retry loop and take the whole batch down. It is a connection error, so the real
        seam (_http) classifies it as one and run_target retries it.
        """
        import http.client
        attempts = []
        original = gen_art.urllib.request.urlopen

        class FakeResponse:
            status = 200

            def read(self):
                return b64_response()

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        def fake_urlopen(request, timeout=None):
            attempts.append(request.full_url)
            if len(attempts) == 1:
                raise http.client.IncompleteRead(b'partial', 400)
            return FakeResponse()

        gen_art.urllib.request.urlopen = fake_urlopen
        try:
            # The real seam, so IncompleteRead travels the path production uses.
            code, output = self.run_cli_with(['--story', str(self.story), 'page-01',
                                              '--attempts', '3', '--retry-delay', '0'], gen_art._http)
        finally:
            gen_art.urllib.request.urlopen = original
        self.assertEqual(code, 0, output)
        self.assertEqual(len(attempts), 2, 'a truncated body must be retried, not fatal')
        self.assertTrue((self.story / 'art' / 'page-01.png').is_file())

    def test_one_broken_asset_does_not_end_the_batch(self):
        """A failure that is not an ApiError still has to leave the other assets running."""
        (self.story / 'prompts' / 'ref-a.txt').write_text('Scene: A character sheet.\n', encoding='utf-8')

        def handler(n, url, body):
            if url.endswith('/images/edits'):  # the page, not the reference sheet
                raise RuntimeError('something nobody anticipated')
            return 200, b64_response()

        code, output = self.run_cli(['--story', str(self.story), 'ref-a', 'page-01', '--retry-delay', '0'], handler)
        self.assertEqual(code, 1, 'the run reports the failure')
        self.assertIn('RuntimeError', output)
        self.assertNotIn('Traceback', output)
        self.assertTrue((self.story / 'art' / 'ref-a.png').is_file(), 'the other asset was still written')

    def test_a_missing_art_directory_is_created_rather_than_losing_the_image(self):
        """The image is already paid for when it arrives; a missing folder must not discard it."""
        import shutil
        (self.story / 'prompts' / 'ref-a.txt').write_text('Scene: A character sheet.\n', encoding='utf-8')
        shutil.rmtree(self.story / 'art')
        code, output = self.run_cli(['--story', str(self.story), 'ref-a', '--retry-delay', '0'],
                                    lambda n, url, body: (200, b64_response()))
        self.assertEqual(code, 0, output)
        self.assertTrue((self.story / 'art' / 'ref-a.png').is_file())

    def test_verify_refuses_when_its_references_do_not_exist_yet(self):
        """It would otherwise test text-to-image and call that a verified edits path."""
        (self.story / 'art' / 'ref-a.png').unlink()
        code, output = self.run_cli(['--story', str(self.story), 'page-01', '--verify'],
                                    lambda n, url, body: self.fail('must not call the API'))
        self.assertEqual(code, 2)
        self.assertIn('ref-a.png', output)
        self.assertIn('edits', output)
        self.assertEqual(self.calls, [])

    def test_probe_gets_models_without_generating(self):
        """The free availability check: one GET, no POST, no cost."""
        import json as jsonlib
        import urllib.request
        seen = []
        original = gen_art.urllib.request.urlopen

        class FakeResponse:
            status = 200

            def read(self):
                return jsonlib.dumps({'data': [{'id': 'gpt-image-2'}]}).encode()

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        def fake_urlopen(request, timeout=None):
            seen.append(request.full_url if hasattr(request, 'full_url') else str(request))
            return FakeResponse()

        gen_art.urllib.request.urlopen = fake_urlopen
        try:
            code, output = self.run_cli(['--story', str(self.story), '--probe'],
                                        lambda n, url, body: self.fail('the probe must not POST'))
        finally:
            gen_art.urllib.request.urlopen = original
        self.assertEqual(code, 0, output)
        self.assertEqual(self.calls, [], 'no generation request')
        self.assertEqual(seen, ['https://api.openai.com/v1/models'])
        self.assertIn('listed by the endpoint', output)
        self.assertIn('availability only', output)

    def test_no_traceback_when_the_output_cannot_be_written(self):
        """A filesystem problem is a message, not a Python stack trace."""
        (self.story / 'art' / 'page-01.png').mkdir()  # a directory where the image belongs
        code, output = self.run_cli(['--story', str(self.story), 'page-01', '--retry-delay', '0'],
                                    lambda n, url, body: (200, b64_response()))
        self.assertEqual(code, 1)
        self.assertIn('could not write', output)
        self.assertNotIn('Traceback', output)


if __name__ == '__main__':
    unittest.main()
