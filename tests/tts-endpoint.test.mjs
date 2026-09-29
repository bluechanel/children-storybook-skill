// Endpoint resolution, the pure-OpenAI request body, and the preset-fingerprint cache salt.
//
// This file deliberately does NOT import ../src/content.js, so it runs even when stories/ is
// empty (media.test.mjs cannot: it links against a story folder at import time). It builds its
// own isolated project instead, exactly like media.test.mjs's isolatedProject().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveTts, voiceFingerprint, prepare, wav, pcmData, measureLevel, levelGain, DEFAULT_DISCLOSURE, FIXTURE_DISCLOSURE } from '../skills/children-storybook/scripts/prepare_narration.mjs';
import { checkTts } from '../skills/children-storybook/scripts/narrate.mjs';

const book = {
  storyId: 'endpoint-fixture-v1',
  title: 'Endpoint Fixture',
  sheets: [
    { front: { text: 'A short first line.', image: 'a.png' }, back: { text: 'A short second line.', image: 'b.png' } },
    { front: { text: 'A short third line.', image: 'c.png' }, back: { text: 'The end.', image: 'd.png' } },
  ],
};

const TTS_VARS = ['OPENAI_TTS_BASE_URL', 'OPENAI_BASE_URL', 'OPENAI_TTS_API_KEY', 'OPENAI_API_KEY', 'OPENAI_TTS_VOICE', 'OPENAI_TTS_MODEL', 'OPENAI_TTS_SPEED', 'OPENAI_TTS_DISCLOSURE', 'OPENAI_TTS_NORMALIZE'];

function withEnv(values, body) {
  const saved = Object.fromEntries(TTS_VARS.map(name => [name, process.env[name]]));
  for (const name of TTS_VARS) delete process.env[name];
  Object.assign(process.env, values);
  const restore = () => {
    for (const name of TTS_VARS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  };
  return Promise.resolve()
    .then(body)
    .finally(restore);
}

async function isolatedProject(temp) {
  const project = path.join(temp, 'project'), story = path.join(project, 'stories', book.storyId);
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.mkdir(story, { recursive: true });
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ type: 'module' }));
  await fs.writeFile(path.join(project, 'src/content.js'), 'export const bookContent = ' + JSON.stringify(book) + ';');
  await fs.writeFile(path.join(story, 'manifest.json'), JSON.stringify({ id: book.storyId }));
  await fs.writeFile(path.join(story, 'narration.js'), 'export const narrationConfig = {url:null};');
  return { project, story };
}

async function withTempProject(body) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'tts-endpoint-'));
  try {
    return await body(await isolatedProject(temp), temp);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

// A stand-in OpenAI-compatible server. Records every request; serves /v1/voices only when a
// fingerprint is configured, so the "official API has no /v1/voices" path is covered too.
// `state` is read live on every call, so a test can change the fingerprint mid-run.
function mockFetch(record, state = {}) {
  return async (url, options = {}) => {
    const target = String(url);
    record.push({ url: target, options });
    if (target.endsWith('/voices')) {
      if (state.voicesStatus && state.voicesStatus !== 200) return new Response('nope', { status: state.voicesStatus });
      const data = state.fingerprint ? [{ id: 'marin', object: 'voice', fingerprint: state.fingerprint }] : [];
      return new Response(JSON.stringify({ object: 'list', data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(wav(4800, true), { status: 200, headers: { 'Content-Type': 'audio/wav' } });
  };
}

const speechRequests = record => record.filter(entry => entry.url.endsWith('/audio/speech'));

test('resolveTts defaults to the official host and reads no key from an empty variable', async () => {
  await withEnv({ OPENAI_API_KEY: '' }, () => {
    const tts = resolveTts();
    assert.equal(tts.base, 'https://api.openai.com/v1');
    assert.equal(tts.endpoint, 'https://api.openai.com/v1/audio/speech');
    assert.equal(tts.key, '', 'an empty OPENAI_API_KEY= must not count as a credential');
    assert.equal(tts.source, 'default');
  });
});

test('OPENAI_TTS_BASE_URL wins over OPENAI_BASE_URL so images stay on their own endpoint', async () => {
  await withEnv({ OPENAI_BASE_URL: 'https://images.example.com/v1', OPENAI_TTS_BASE_URL: 'http://127.0.0.1:8123/v1' }, () => {
    const tts = resolveTts();
    assert.equal(tts.base, 'http://127.0.0.1:8123/v1');
    assert.equal(tts.source, 'OPENAI_TTS_BASE_URL');
  });
});

test('a bare host gains the /v1 suffix and trailing slashes are stripped', async () => {
  await withEnv({ OPENAI_TTS_BASE_URL: 'http://127.0.0.1:8123' }, () => {
    assert.equal(resolveTts().base, 'http://127.0.0.1:8123/v1');
  });
  await withEnv({ OPENAI_TTS_BASE_URL: 'http://127.0.0.1:8123/v1//' }, () => {
    assert.equal(resolveTts().base, 'http://127.0.0.1:8123/v1');
  });
});

test('a malformed or non-http base URL is rejected', async () => {
  await withEnv({ OPENAI_TTS_BASE_URL: 'not a url' }, () => assert.throws(() => resolveTts(), /not a valid URL/));
  await withEnv({ OPENAI_TTS_BASE_URL: 'ftp://example.com/v1' }, () => assert.throws(() => resolveTts(), /must be http/));
});

test('the credential falls back to OPENAI_API_KEY and never appears in the endpoint', async () => {
  await withEnv({ OPENAI_TTS_API_KEY: 'tts-token' }, () => {
    assert.equal(resolveTts().key, 'tts-token');
  });
  await withEnv({ OPENAI_API_KEY: 'shared-token' }, () => {
    const tts = resolveTts();
    assert.equal(tts.key, 'shared-token');
    assert.ok(!tts.endpoint.includes('shared-token'));
    assert.ok(!tts.base.includes('shared-token'));
  });
});

test('plan mode resolves the endpoint without any network call', async () => {
  await withEnv({ OPENAI_TTS_BASE_URL: 'http://127.0.0.1:9999/v1' }, () => withTempProject(async ({ project, story }) => {
    const original = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('Unexpected network request'); };
    try {
      const result = await prepare({ project, plan: true });
      assert.equal(result.status, 'planned');
      const plan = JSON.parse(await fs.readFile(path.join(story, 'audio/requests.json'), 'utf8'));
      assert.equal(plan.status, 'planned');
      assert.equal(plan.provider, 'openai-compatible');
      assert.equal(plan.endpoint, 'http://127.0.0.1:9999/v1');
      assert.equal(plan.presetFingerprint, null, 'plan mode cannot know the fingerprint without a request');
      assert.equal(plan.requests.length, 4);
    } finally { globalThis.fetch = original; }
  }));
});

test('generation posts the pure OpenAI body to the configured endpoint', async () => {
  await withEnv({ OPENAI_TTS_BASE_URL: 'http://127.0.0.1:9999/v1', OPENAI_TTS_API_KEY: 'unit-token', OPENAI_TTS_VOICE: 'marin' },
    () => withTempProject(async ({ project, story }) => {
      const record = [];
      const original = globalThis.fetch;
      globalThis.fetch = mockFetch(record, { voicesStatus: 404 }); // no /v1/voices: still works
      try {
        const { timeline } = await prepare({ project, generate: true, name: 'first' });
        assert.equal(speechRequests(record).length, 4);
        for (const entry of speechRequests(record)) {
          assert.equal(entry.url, 'http://127.0.0.1:9999/v1/audio/speech');
          assert.equal(entry.options.headers.Authorization, 'Bearer unit-token');
          const body = JSON.parse(entry.options.body);
          assert.equal(body.response_format, 'wav');
          assert.equal(body.model, 'gpt-4o-mini-tts');
          assert.ok(body.input && body.voice && body.speed);
          // The skill must stay usable against any OpenAI-compatible endpoint.
          for (const extension of ['seed', 'language', 'ref_audio', 'temperature', 'top_p', 'top_k', 'repetition_penalty', 'max_tokens']) {
            assert.ok(!(extension in body), `the request body must not carry the MOSS extension ${extension}`);
          }
        }
        assert.equal(timeline.tts.provider, 'openai-compatible');
        assert.equal(timeline.tts.endpoint, 'http://127.0.0.1:9999/v1');
        assert.equal(timeline.tts.presetFingerprint, null);
        const saved = JSON.stringify(timeline) + await fs.readFile(path.join(story, 'audio/first/requests.json'), 'utf8');
        assert.ok(!saved.includes('unit-token'), 'the credential must never reach saved metadata');
      } finally { globalThis.fetch = original; }
    }));
});

test('cached clips are reused, and the credential stays out of every saved file', async () => {
  await withEnv({ OPENAI_TTS_BASE_URL: 'http://127.0.0.1:9999/v1', OPENAI_TTS_API_KEY: 'unit-token' },
    () => withTempProject(async ({ project, story }) => {
      const record = [];
      const original = globalThis.fetch;
      globalThis.fetch = mockFetch(record, { voicesStatus: 404 });
      try {
        await prepare({ project, generate: true, name: 'first' });
        assert.equal(speechRequests(record).length, 4);
        await prepare({ project, generate: true, name: 'cached' });
        assert.equal(speechRequests(record).length, 4, 'a second run must come entirely from the cache');

        await prepare({ project, generate: true, name: 'installed', install: true });
        const narration = await fs.readFile(path.join(story, 'narration.js'), 'utf8');
        assert.ok(narration.includes('/audio/installed/timeline.json'));
        assert.ok(!narration.includes('unit-token'));
        const requests = await fs.readFile(path.join(story, 'audio/installed/requests.json'), 'utf8');
        assert.ok(!requests.includes('unit-token'));
        assert.ok(requests.includes('http://127.0.0.1:9999/v1'));
      } finally { globalThis.fetch = original; }
    }));
});

test('a changed preset fingerprint forces regeneration even though the body is identical', async () => {
  await withEnv({ OPENAI_TTS_BASE_URL: 'http://127.0.0.1:9999/v1', OPENAI_TTS_API_KEY: 'unit-token' },
    () => withTempProject(async ({ project, story }) => {
      const record = [];
      const original = globalThis.fetch;
      const state = { fingerprint: 'aaaaaaaaaaaaaaaa' };
      globalThis.fetch = mockFetch(record, state);
      try {
        const first = await prepare({ project, generate: true, name: 'fp-a' });
        assert.equal(speechRequests(record).length, 4);
        assert.equal(first.timeline.tts.presetFingerprint, 'aaaaaaaaaaaaaaaa');

        // Same text, same voice name — only the server-side preset changed.
        state.fingerprint = 'bbbbbbbbbbbbbbbb';
        const second = await prepare({ project, generate: true, name: 'fp-b' });
        assert.equal(speechRequests(record).length, 8, 'a new fingerprint must invalidate the cache');
        assert.equal(second.timeline.tts.presetFingerprint, 'bbbbbbbbbbbbbbbb');

        // And an unchanged fingerprint still hits the cache.
        await prepare({ project, generate: true, name: 'fp-c' });
        assert.equal(speechRequests(record).length, 8);
      } finally { globalThis.fetch = original; }
    }));
});

test('voiceFingerprint is best-effort and never throws', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new Error('offline'); };
    assert.equal(await voiceFingerprint(resolveTts(), 'marin'), null);
    globalThis.fetch = async () => new Response('{}', { status: 404 });
    assert.equal(await voiceFingerprint(resolveTts(), 'marin'), null);
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: 'marin' }] }), { status: 200 });
    assert.equal(await voiceFingerprint(resolveTts(), 'marin'), null, 'a preset without a fingerprint yields null');
    assert.equal(await voiceFingerprint(resolveTts(), null), null, 'no voice means nothing to look up');
  } finally { globalThis.fetch = original; }
});

test('generation fails before any request when no credential is configured', async () => {
  await withEnv({ OPENAI_TTS_BASE_URL: 'http://127.0.0.1:9999/v1' }, () => withTempProject(async ({ project }) => {
    const original = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('Unexpected network request'); };
    try {
      await assert.rejects(prepare({ project, generate: true }), /OPENAI_TTS_API_KEY \(or OPENAI_API_KEY\) is not configured/);
    } finally { globalThis.fetch = original; }
  }));
});

test('a speed outside 0.25–4 is rejected before any request', async () => {
  await withEnv({ OPENAI_TTS_BASE_URL: 'http://127.0.0.1:9999/v1', OPENAI_TTS_API_KEY: 'unit-token', OPENAI_TTS_SPEED: '5' },
    () => withTempProject(async ({ project }) => {
      const original = globalThis.fetch;
      globalThis.fetch = () => { throw new Error('Unexpected network request'); };
      try {
        await assert.rejects(prepare({ project, generate: true }), /0\.25–4/);
      } finally { globalThis.fetch = original; }
    }));
});

test('a 48 kHz mono PCM16 response is used as-is; anything else is normalized through ffmpeg', async () => {
  await withEnv({ OPENAI_TTS_BASE_URL: 'http://127.0.0.1:9999/v1', OPENAI_TTS_API_KEY: 'unit-token' },
    () => withTempProject(async ({ project, story }) => {
      const record = [];
      const original = globalThis.fetch;
      // 24 kHz stereo, like the official API: must be resampled to 48 kHz mono.
      const stereo = (() => {
        const data = Buffer.alloc(44 + 2400 * 4);
        data.write('RIFF', 0); data.writeUInt32LE(36 + 2400 * 4, 4); data.write('WAVEfmt ', 8);
        data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(2, 22);
        data.writeUInt32LE(24000, 24); data.writeUInt32LE(96000, 28); data.writeUInt16LE(4, 32);
        data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(2400 * 4, 40);
        return data;
      })();
      globalThis.fetch = async (url, options) => {
        record.push({ url: String(url), options });
        if (String(url).endsWith('/voices')) return new Response('nope', { status: 404 });
        return new Response(stereo, { status: 200, headers: { 'Content-Type': 'audio/wav' } });
      };
      try {
        const { timeline } = await prepare({ project, generate: true, name: 'resampled' });
        for (const clip of timeline.clips) {
          const bytes = await fs.readFile(path.join(story, 'audio/resampled', clip.file));
          assert.ok(pcmData(bytes).length > 0, `${clip.file} must be 48 kHz mono PCM16 after normalization`);
        }
      } finally { globalThis.fetch = original; }
    }));
});

// A tone at a chosen fraction of full scale, standing in for a clip the endpoint returned
// either loud or quiet.
function tone(amplitude, samples = 4800) {
  const data = wav(samples, true);
  const pcm = pcmData(data);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(Math.round(pcm.readInt16LE(i) * amplitude), i);
  return data;
}

test('the disclosure says what the audio is, and is configurable', async () => {
  await withEnv({ OPENAI_TTS_BASE_URL: 'http://127.0.0.1:9999/v1', OPENAI_TTS_API_KEY: 'unit-token' },
    () => withTempProject(async ({ project }) => {
      const original = globalThis.fetch;
      globalThis.fetch = mockFetch([], { voicesStatus: 404 });
      try {
        const { timeline } = await prepare({ project, generate: true, name: 'disc-default' });
        assert.equal(timeline.disclosure, DEFAULT_DISCLOSURE);
        assert.match(timeline.disclosure, /AI-generated/i, 'the default has to be an actual disclosure');

        const { timeline: chosen } = await prepare({ project, generate: true, name: 'disc-chosen', disclosure: 'Synthetic narration (ElevenLabs)' });
        assert.equal(chosen.disclosure, 'Synthetic narration (ElevenLabs)');

        const requests = JSON.parse(await fs.readFile(path.join(project, 'stories/endpoint-fixture-v1/audio/disc-chosen/requests.json'), 'utf8'));
        assert.equal(requests.disclosure, 'Synthetic narration (ElevenLabs)', 'the run record keeps the wording it used');

        await assert.rejects(prepare({ project, generate: true, name: 'disc-blank', disclosure: '   ' }), /must not be empty/);
        await assert.rejects(prepare({ project, generate: true, name: 'disc-long', disclosure: 'x'.repeat(200) }), /120 characters/);
      } finally { globalThis.fetch = original; }
    }));
});

test('an environment disclosure is honoured, and fixture tones keep their own label', async () => {
  await withEnv({ OPENAI_TTS_BASE_URL: 'http://127.0.0.1:9999/v1', OPENAI_TTS_API_KEY: 'unit-token', OPENAI_TTS_DISCLOSURE: 'AI narration via the local MOSS-TTS server' },
    () => withTempProject(async ({ project, story }) => {
      const original = globalThis.fetch;
      globalThis.fetch = mockFetch([], { voicesStatus: 404 });
      try {
        const { timeline } = await prepare({ project, generate: true, name: 'disc-env' });
        assert.equal(timeline.disclosure, 'AI narration via the local MOSS-TTS server');
      } finally { globalThis.fetch = original; }
      // Test tones must never be able to claim they are narration, whatever was configured.
      const { timeline } = await prepare({ project, fixture: true, name: 'fx' });
      assert.equal(timeline.disclosure, FIXTURE_DISCLOSURE);
      assert.ok((await fs.readFile(path.join(story, 'audio/fx/timeline.json'), 'utf8')).includes('tones, not narration'));
    }));
});

test('a page seed re-records exactly one page', async () => {
  await withEnv({ OPENAI_TTS_BASE_URL: 'http://127.0.0.1:9999/v1', OPENAI_TTS_API_KEY: 'unit-token' },
    () => withTempProject(async ({ project }) => {
      const record = [];
      const original = globalThis.fetch;
      globalThis.fetch = mockFetch(record, { voicesStatus: 404 });
      try {
        await prepare({ project, generate: true, name: 'seed-a', 'page-seed': ['page-02=7'] });
        const first = speechRequests(record);
        assert.equal(first.length, 4);
        const seeded = first.filter(entry => JSON.parse(entry.options.body).seed === 7);
        assert.equal(seeded.length, 1, 'the seed reaches the named page and no other');
        assert.match(JSON.parse(seeded[0].options.body).input, /third/, 'and the named page is the one seeded');

        // Same seeding again: the whole run comes from the cache.
        await prepare({ project, generate: true, name: 'seed-b', 'page-seed': ['page-02=7'] });
        assert.equal(speechRequests(record).length, 4);

        // A different seed for that one page costs exactly one generation, which is the
        // single-page re-record the docs promise and the preset seed cannot deliver.
        await prepare({ project, generate: true, name: 'seed-c', 'page-seed': ['page-02=8'] });
        assert.equal(speechRequests(record).length, 5, 'one page re-recorded, the rest reused');

        await assert.rejects(prepare({ project, generate: true, name: 'seed-d', 'page-seed': ['page-99=1'] }), /names no page/);
        await assert.rejects(prepare({ project, generate: true, name: 'seed-e', 'page-seed': ['page-02=x'] }), /whole number/);
        await assert.rejects(prepare({ project, generate: true, name: 'seed-f', seed: '-2' }), /whole number/);
      } finally { globalThis.fetch = original; }
    }));
});

test('clips generated at different levels are matched before assembly', async () => {
  await withEnv({ OPENAI_TTS_BASE_URL: 'http://127.0.0.1:9999/v1', OPENAI_TTS_API_KEY: 'unit-token' },
    () => withTempProject(async ({ project, story }) => {
      const original = globalThis.fetch;
      // page-02 comes back about 6 dB under its neighbours, the case this pipeline actually
      // produces: nothing makes eighteen independent generations agree on a level.
      globalThis.fetch = async (url, options = {}) => {
        if (String(url).endsWith('/voices')) return new Response('nope', { status: 404 });
        const body = JSON.parse(options.body);
        return new Response(tone(body.input.includes('third') ? 0.5 : 1), { status: 200, headers: { 'Content-Type': 'audio/wav' } });
      };
      try {
        const { timeline } = await prepare({ project, generate: true, name: 'levels' });
        assert.equal(timeline.loudness.enabled, true);
        const levels = [];
        for (const clip of timeline.clips) {
          const bytes = await fs.readFile(path.join(story, 'audio/levels', clip.file));
          levels.push(measureLevel(pcmData(bytes)).rmsDb);
          assert.equal(typeof clip.gainDb, 'number', `${clip.id} records the gain it was given`);
        }
        const spread = Math.max(...levels) - Math.min(...levels);
        assert.ok(spread < 0.5, `clips must arrive at one level; spread was ${spread.toFixed(2)} dB`);
        const quiet = timeline.clips.find(clip => clip.id === 'page-02');
        assert.ok(quiet.gainDb > 3, `the quiet page is the one raised, got ${quiet.gainDb} dB`);

        // The master must carry the matched audio, not the raw response.
        const master = pcmData(await fs.readFile(path.join(story, 'audio/levels/master.wav')));
        assert.ok(measureLevel(master).peakDb < 0, 'the master never clips');
      } finally { globalThis.fetch = original; }
    }));
});

test('level matching never clips and never moves a clip past ±12 dB', () => {
  const loud = measureLevel(pcmData(tone(1)));
  const gain = levelGain(loud);
  assert.ok(loud.peak * gain <= 0.891 + 1e-6, 'the peak ceiling must hold');
  assert.equal(levelGain({ peak: 0, rms: 0 }), 1, 'a silent clip is left alone');
  assert.ok(levelGain({ peak: 0.5, rms: 1e-5 }) <= 10 ** (12 / 20) + 1e-9, 'a broken clip is not boosted without limit');
  assert.ok(levelGain({ peak: 1, rms: 0.9 }) >= 10 ** (-12 / 20) - 1e-9, 'and not attenuated without limit');
});

test('renaming an output says which one exists and that the rename is free', async () => {
  await withEnv({ OPENAI_TTS_BASE_URL: 'http://127.0.0.1:9999/v1', OPENAI_TTS_API_KEY: 'unit-token' },
    () => withTempProject(async ({ project }) => {
      const original = globalThis.fetch;
      globalThis.fetch = mockFetch([], { voicesStatus: 404 });
      try {
        await prepare({ project, generate: true, name: 'taken' });
        await assert.rejects(prepare({ project, generate: true, name: 'taken' }),
          /Output exists: .*audio\/taken.*new --name.*costs nothing/s);
      } finally { globalThis.fetch = original; }
    }));
});

// A /v1/voices response shaped like the local MOSS-TTS server's, which is where the silent
// capability downgrade showed up: the preset names a reference WAV the server could not open.
function voiceList(voice) {
  return async url => {
    const target = String(url);
    if (target.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'moss-tts-local' }] }), { status: 200 });
    if (target.endsWith('/voices')) return new Response(JSON.stringify({ object: 'list', data: [voice] }), { status: 200 });
    throw new Error(`unexpected request: ${target}`);
  };
}

test('--check reports a voice preset whose reference audio the server is not using', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = voiceList({ id: 'narrator', fingerprint: 'fp', ref_audio: 'voices/narrator.wav', ref_audio_ok: false });
    await withEnv({ OPENAI_TTS_BASE_URL: 'http://127.0.0.1:8123/v1', OPENAI_TTS_API_KEY: 'local', OPENAI_TTS_VOICE: 'narrator' }, async () => {
      const downgraded = await checkTts({});
      assert.equal(downgraded.status.refAudio, 'voices/narrator.wav');
      assert.equal(downgraded.status.refAudioOk, false, 'the flag is reported, not swallowed');
      assert.ok(downgraded.problems.some(problem => /ref_audio_ok: false/.test(problem)),
        'a fallback voice is a problem, not a check mark');
      assert.equal(downgraded.ok, false);

      const accepted = await checkTts({ allowFallbackVoice: true });
      assert.ok(!accepted.problems.some(problem => /ref_audio_ok/.test(problem)), '--allow-fallback-voice is the escape hatch');
    });

    // A preset with no reference audio at all reports the same flag, and is not a downgrade.
    globalThis.fetch = voiceList({ id: 'default', fingerprint: 'fp', ref_audio: null, ref_audio_ok: false });
    await withEnv({ OPENAI_TTS_BASE_URL: 'http://127.0.0.1:8123/v1', OPENAI_TTS_API_KEY: 'local', OPENAI_TTS_VOICE: 'default' }, async () => {
      const zeroConfig = await checkTts({});
      assert.equal(zeroConfig.status.refAudio, null);
      assert.ok(!zeroConfig.problems.some(problem => /ref_audio_ok/.test(problem)), 'nothing was declared, so nothing was lost');
    });

    // And a reference the server did load is silent, as it should be.
    globalThis.fetch = voiceList({ id: 'narrator', fingerprint: 'fp', ref_audio: 'voices/narrator.wav', ref_audio_ok: true });
    await withEnv({ OPENAI_TTS_BASE_URL: 'http://127.0.0.1:8123/v1', OPENAI_TTS_API_KEY: 'local', OPENAI_TTS_VOICE: 'narrator' }, async () => {
      const healthy = await checkTts({});
      assert.equal(healthy.status.refAudioOk, true);
      assert.ok(!healthy.problems.some(problem => /ref_audio_ok/.test(problem)));
    });
  } finally { globalThis.fetch = original; }
});
