import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateCopy, readPublishingCopy, publishBundle, coverHtml, sha256, COVER_SIZES } from '../skills/children-storybook/scripts/publish_bundle.mjs';
import { storyPaths } from '../skills/children-storybook/scripts/story-paths.mjs';
import { exportVideo } from '../skills/children-storybook/scripts/export_video.mjs';
import { pageSequence, makeTimeline } from '../skills/children-storybook/scripts/media-core.mjs';
import { wav } from '../skills/children-storybook/scripts/prepare_narration.mjs';
import { pngSize } from '../skills/children-storybook/scripts/cdp.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SKILL = path.join(ROOT, 'skills/children-storybook');
const sampleCopy = () => ({ version: 1,
  cover: { headline: '闯进小熊家\n之后呢？', subtitle: '一场森林里的奇遇', art: 'art/cover.jpg' },
  theme: { background: '#F6F5F0', ink: '#002FA7', accent: '#A65E46' },
  platforms: Object.fromEntries(['douyin', 'xiaohongshu', 'bilibili'].map(key => [key, {
    title: '金发姑娘和三只熊｜英语绘本', description: '金发姑娘走进森林里的小屋。这是用于检验封面排版与导出流程的测试素材。',
    tags: ['英语绘本', '金发姑娘', '亲子共读'],
  }])),
});

async function fixture(t, retain = false) {
  const base = retain && process.env.PUBLISH_QA_DIR ? path.resolve(process.env.PUBLISH_QA_DIR) : await fs.mkdtemp(path.join(os.tmpdir(), 'publishing-test-'));
  if (!(retain && process.env.PUBLISH_QA_DIR)) t.after(() => fs.rm(base, { recursive: true, force: true }));
  const project = path.join(base, 'project');
  const root = path.join(project, 'stories', 'publishing-test');
  await fs.mkdir(path.join(root, 'video'), { recursive: true });
  await fs.mkdir(path.join(root, 'art'), { recursive: true });
  await fs.mkdir(path.join(root, 'publishing'), { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(SKILL, 'examples/goldilocks/manifest.json'), 'utf8'));
  manifest.id = 'publishing-test';
  manifest.spreads = manifest.spreads.slice(0, 1);
  const names = ['cover.jpg', 'back.jpg', 'page-01.jpg', 'page-02.jpg'];
  for (const name of names) await fs.copyFile(path.join(SKILL, 'examples/goldilocks/art', name), path.join(root, 'art', name));
  await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  const build = spawnSync('python3', [path.join(SKILL, 'scripts/build_book.py'), path.join(root, 'manifest.json'), '--build', 'v1', '--project', project], { encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  const { bookContent: book } = await import(pathToFileURL(path.join(root, 'content.js')));
  const story = storyPaths(project, book);
  const copy = path.join(root, 'publishing/copy-v1.json');
  await fs.writeFile(copy, JSON.stringify(sampleCopy()));
  return { base, project, root, book, story, copy };
}

test('publishing copy preserves exact Unicode and rejects missing platforms and unusable tags', () => {
  const input = sampleCopy();
  assert.equal(validateCopy(input).cover.headline, input.cover.headline);
  input.platforms.xiaohongshu.title = '长'.repeat(21);
  assert.throws(() => validateCopy(input), /20 characters/);
  input.platforms.xiaohongshu.title = '短标题';
  input.platforms.douyin.tags = ['#英语', '英语', '英语'];
  assert.throws(() => validateCopy(input), /unique tags/);
  delete input.platforms.bilibili;
  input.platforms.douyin.tags = ['英语', '绘本', '故事'];
  assert.throws(() => validateCopy(input), /Missing platforms.bilibili/);
});

test('coverHtml reapplies fitted font sizes without a document round-trip', () => {
  const art = 'data:image/png;base64,AAAA';
  const fitted = coverHtml(sampleCopy(), 'The Tortoise and the Hare', art, 'portrait', [28, 70, 34, 29]);
  assert.match(fitted, /class="label" data-fit style="font-size:28px"/);
  assert.match(fitted, /<h1 data-fit style="font-size:70px"/);
  assert.match(fitted, /class="subtitle" data-fit style="font-size:34px"/);
  assert.match(fitted, /class="title" data-fit style="font-size:29px"/);
  const unfitted = coverHtml(sampleCopy(), 'The Tortoise and the Hare', art, 'portrait');
  assert.doesNotMatch(unfitted, /data-fit style=/);
  assert.match(unfitted, /data-fit>/);
});

test('publishing sources reject traversal and symlinks outside the story', async t => {
  const f = await fixture(t);
  const outside = path.join(f.base, 'outside.json');
  await fs.writeFile(outside, JSON.stringify(sampleCopy()));
  await assert.rejects(readPublishingCopy(f.story, outside), /inside/);
  const symlink = path.join(f.root, 'publishing/link.json');
  await fs.symlink(outside, symlink);
  await assert.rejects(readPublishingCopy(f.story, symlink), /inside/);
  const copy = sampleCopy(); copy.cover.art = '../../outside.jpg';
  await fs.writeFile(f.copy, JSON.stringify(copy));
  await assert.rejects(readPublishingCopy(f.story, f.copy), /inside/);
  assert.equal(await fs.readFile(outside, 'utf8'), JSON.stringify(sampleCopy()));
});

test('copy can be checked offline through a symlinked CLI without a story or browser', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'publishing-copy-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const copy = path.join(dir, 'copy.json'), cli = path.join(dir, 'publish.mjs');
  await fs.writeFile(copy, JSON.stringify(sampleCopy()));
  await fs.symlink(path.join(SKILL, 'scripts/publish_bundle.mjs'), cli);
  const run = spawnSync(process.execPath, [cli, '--check-copy', copy], { cwd: dir, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).valid, true);
  await fs.writeFile(copy, '{}');
  assert.equal(spawnSync(process.execPath, [cli, '--check-copy', copy], { encoding: 'utf8' }).status, 1);
  const incomplete = spawnSync(process.execPath, [path.join(SKILL, 'scripts/export_video.mjs'), '--publish-copy'], { encoding: 'utf8' });
  assert.equal(incomplete.status, 1);
  assert.match(incomplete.stderr, /Missing value: --publish-copy/);
});

test('fixture and stale exports are rejected before browser launch', async t => {
  const f = await fixture(t);
  const video = path.join(f.story.video, 'book.mp4');
  const opts = { project: f.project, video, copy: f.copy };
  await fs.writeFile(video + '.json', JSON.stringify({ mode: 'fixture' }));
  await assert.rejects(publishBundle(opts), /test tones/);
  await fs.writeFile(video + '.json', JSON.stringify({ mode: 'ready', contentKey: 'old' }));
  await assert.rejects(publishBundle(opts), /stale/);
});

test('MP4 export composes three covers and copy; retries preserve video and accepted kits', { skip: !process.env.PUBLISH_BROWSER_TEST }, async t => {
  const f = await fixture(t, true);
  const audio = path.join(f.root, 'audio/test');
  await fs.mkdir(audio, { recursive: true });
  const clips = pageSequence(f.book).map(page => ({ id: page.id, file: page.id + '.wav', samples: 4800 }));
  const timeline = makeTimeline(f.book, clips, { lead: 0.1, pageGap: 0.1, spreadPause: 0.1, turn: 0.1, settle: 0.1, tail: 0.1 });
  // Mocked ready audio exercises the production branch; it is explicitly labeled a test.
  const master = path.join(audio, 'master.wav');
  await fs.writeFile(master, wav(timeline.totalSamples, true));
  Object.assign(timeline, { mode: 'ready', audioFile: 'master.wav', audioSha256: await sha256(master), disclosure: 'OFFLINE PIPELINE TEST — tones, not narration' });
  const timelinePath = path.join(audio, 'timeline.json');
  await fs.writeFile(timelinePath, JSON.stringify(timeline));
  const video = path.join(f.story.video, 'book.mp4');
  const report = await exportVideo({ project: f.project, timeline: timelinePath, output: video, width: 640, height: 360, fps: 5, 'publish-copy': f.copy });
  assert.equal(report.publishing.status, 'generated');
  const bundle = JSON.parse(await fs.readFile(report.publishing.manifest, 'utf8'));
  assert.equal(bundle.videoSha256, await sha256(video));
  for (const size of Object.values(COVER_SIZES)) assert.deepEqual(pngSize(await fs.readFile(path.join(report.publishing.output, size.file))), { width: size.width, height: size.height });
  assert.ok((await fs.stat(report.publishing.preview)).size <= 250000);
  assert.match(await fs.readFile(path.join(report.publishing.output, 'publish.md'), 'utf8'), /#英语绘本/);
  const opts = { project: f.project, video, copy: f.copy };
  await assert.rejects(publishBundle(opts), /kit exists/);
  const failedVideo = path.join(f.story.video, 'failed-cover.mp4');
  const brokenCopy = sampleCopy(); brokenCopy.cover.art = 'art/broken.png';
  await fs.writeFile(path.join(f.root, 'art/broken.png'), 'not an image');
  const brokenFile = path.join(f.root, 'publishing/broken.json');
  await fs.writeFile(brokenFile, JSON.stringify(brokenCopy));
  await assert.rejects(exportVideo({ project: f.project, timeline: timelinePath, output: failedVideo, width: 640, height: 360, fps: 5, 'publish-copy': brokenFile }), /MP4 export succeeded/);
  const failure = JSON.parse(await fs.readFile(failedVideo + '.json', 'utf8'));
  assert.equal(failure.publishing.status, 'failed');
  assert.equal(await sha256(failedVideo), failure.videoSha256);
  await assert.rejects(fs.access(path.join(f.root, 'publishing/failed-cover')));
  const retried = await publishBundle({ ...opts, video: failedVideo });
  assert.ok(await fs.stat(retried.manifest));
  assert.equal(JSON.parse(await fs.readFile(failedVideo + '.json', 'utf8')).publishing.status, 'generated');
  await fs.appendFile(video, 'changed bytes');
  await assert.rejects(publishBundle({ ...opts, name: 'changed' }), /Video changed/);
  console.log(`Publishing smoke artifacts: ${f.root}`);
});
