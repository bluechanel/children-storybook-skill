#!/usr/bin/env node
// Compose story artwork and agent-written copy into an offline social publishing kit.
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolveProject, loadEnvLocal, resolveBook, isMain } from './project.mjs';
import { storyPaths, inside } from './story-paths.mjs';
import { contentKey } from './media-core.mjs';
import { openBrowser, pngSize } from './cdp.mjs';

export const COVER_SIZES = {
  portrait: { width: 1080, height: 1920, file: 'cover-portrait-9x16.png' },
  landscape: { width: 1920, height: 1080, file: 'cover-landscape-16x9.png' },
  rednote: { width: 1080, height: 1440, file: 'cover-portrait-3x4.png' },
};
const PLATFORMS = { douyin: '抖音', xiaohongshu: '小红书', bilibili: 'B 站' };
const DEFAULT_COVERS = { douyin: 'portrait', xiaohongshu: 'rednote', bilibili: 'landscape' };
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export async function sha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function text(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || [...value].length > max) {
    throw new Error(`${label} must be nonempty text of at most ${max} characters (editorial budget, not a platform limit).`);
  }
  return value.trim();
}

export function validateCopy(input) {
  if (input?.version !== 1) throw new Error('Publishing copy requires version: 1.');
  const cover = input.cover || {};
  const result = {
    version: 1,
    cover: {
      headline: text(cover.headline, 'cover.headline', 36),
      subtitle: text(cover.subtitle, 'cover.subtitle', 64),
      label: text(cover.label || '英语绘本 · 亲子共读', 'cover.label', 30),
    },
    platforms: {},
  };
  if (cover.art !== undefined) result.cover.art = text(cover.art, 'cover.art', 250);
  result.theme = { background: '#f7f1e5', ink: '#204638', accent: '#a4482d' };
  for (const key of Object.keys(result.theme)) {
    if (input.theme?.[key] !== undefined) {
      if (!/^#[0-9a-f]{6}$/i.test(input.theme[key])) throw new Error(`theme.${key} must be a six-digit hex color.`);
      result.theme[key] = input.theme[key];
    }
  }
  for (const key of Object.keys(PLATFORMS)) {
    const item = input.platforms?.[key];
    if (!item) throw new Error(`Missing platforms.${key}.`);
    const tags = item.tags;
    if (!Array.isArray(tags) || tags.length < 3 || tags.length > 8 ||
        tags.some(tag => typeof tag !== 'string' || !tag.trim() || [...tag].length > 24 || /[\s#]/u.test(tag)) ||
        new Set(tags).size !== tags.length) throw new Error(`${key}.tags needs 3–8 unique tags, without spaces or #.`);
    result.platforms[key] = {
      title: text(item.title, `${key}.title`, key === 'xiaohongshu' ? 20 : 60),
      description: text(item.description, `${key}.description`, 300),
      tags,
      cover: item.cover || DEFAULT_COVERS[key],
    };
    if (!COVER_SIZES[result.platforms[key].cover]) throw new Error(`Unknown cover for ${key}.`);
  }
  return result;
}

export async function readPublishingCopy(story, copyPath) {
  const file = inside(story.root, path.resolve(copyPath));
  const copy = validateCopy(JSON.parse(await fs.readFile(file, 'utf8')));
  const manifest = JSON.parse(await fs.readFile(path.join(story.root, 'manifest.json'), 'utf8'));
  const artName = copy.cover.art || manifest.cover?.art;
  if (!artName || path.isAbsolute(artName)) throw new Error('cover.art must be a story-relative original raster image.');
  const art = inside(story.root, path.resolve(story.root, artName));
  const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }[path.extname(art).toLowerCase()];
  if (!mime) throw new Error('Use original JPG, PNG or WebP artwork, not a typeset page or SVG.');
  await fs.access(art);
  copy.cover.art = path.relative(story.root, art).split(path.sep).join('/');
  return { copy, file, art, mime, title: text(manifest.title, 'manifest.title', 180) };
}

export function coverHtml(copy, title, imageUrl, shape, fits = []) {
  const { width, height } = COVER_SIZES[shape];
  const wide = shape === 'landscape';
  // Fitted sizes are reapplied here instead of round-tripping the whole document out of the page.
  // An embedded data-URI cover art can be several megabytes, and returning that string through
  // Runtime.evaluate with returnByValue is pathologically slow (it can exceed the 60s deadline).
  const fit = index => (Number.isFinite(fits[index]) ? ` style="font-size:${fits[index]}px"` : '');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<style>
*{box-sizing:border-box}html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden}
body{background:${copy.theme.background};color:${copy.theme.ink};font-family:"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif}
main{position:absolute;inset:${wide ? '9% 7%' : '9% 9% 16%'};display:grid;gap:4%;grid-template-${wide ? 'columns:43% 53%' : 'rows:39% 57%'}}
.copy{display:flex;flex-direction:column;justify-content:center;min-height:0;min-width:0}
.label{font-size:${wide ? 33 : 28}px;color:${copy.theme.accent};font-weight:700;letter-spacing:2px;margin:0 0 30px}
h1{font-size:${wide ? 92 : 90}px;line-height:1.14;letter-spacing:-1px;margin:0;white-space:pre-line;overflow-wrap:anywhere;max-height:${wide ? 420 : shape === 'rednote' ? 240 : 340}px}
.subtitle{font-size:${wide ? 34 : 34}px;line-height:1.5;margin:25px 0 0;white-space:pre-line;overflow-wrap:anywhere;max-height:110px}
.rule{width:80px;height:9px;background:${copy.theme.accent};margin-bottom:32px;flex-shrink:0}
.art{min-height:0;min-width:0;display:flex;flex-direction:column;justify-content:center;gap:28px}
img{display:block;width:100%;min-height:0;flex:1;object-fit:contain;border-radius:28px}
.title{font-family:Georgia,serif;font-size:${wide ? 32 : 29}px;line-height:1.25;text-align:center;margin:0;max-height:90px;overflow-wrap:anywhere}
</style><main><section class="copy"><div class="rule"></div><p class="label" data-fit${fit(0)}>${esc(copy.cover.label)}</p><h1 data-fit${fit(1)}>${esc(copy.cover.headline)}</h1><p class="subtitle" data-fit${fit(2)}>${esc(copy.cover.subtitle)}</p></section><section class="art"><img src="${esc(imageUrl)}" alt=""><p class="title" data-fit${fit(3)}>${esc(title)}</p></section></main></html>`;
}

function markdown(bundle) {
  const lines = ['# 发布素材', '', `视频：${bundle.video}`, '', `配音说明：${bundle.disclosure}`, '',
    '封面尺寸是设计建议，上传时可按平台当前裁切预览调整。封面比例不会改变视频比例。', ''];
  for (const [key, name] of Object.entries(PLATFORMS)) {
    const item = bundle.platforms[key];
    lines.push(`## ${name}`, '', `封面：${item.coverFile}`, '', `标题：${item.title}`, '', item.description, '', item.tags.map(tag => `#${tag}`).join(' '), '', `配音说明：${bundle.disclosure}`, '');
  }
  return lines.join('\n');
}

export async function publishBundle(options) {
  const project = resolveProject(options.project);
  loadEnvLocal(project);
  if (!options.video || !options.copy) throw new Error('Supply --video <completed.mp4> and --copy <story-local copy.json>.');
  const book = await resolveBook(project, options.story);
  const story = storyPaths(project, book);
  if (options.story && story.id !== options.story) throw new Error('Selected story does not match --story.');
  const video = inside(story.video, path.resolve(options.video));
  if (path.extname(video).toLowerCase() !== '.mp4') throw new Error('Expected an exported .mp4.');
  const report = JSON.parse(await fs.readFile(inside(story.video, video + '.json'), 'utf8'));
  if (report.mode !== 'ready') throw new Error('Only completed narration exports can have a publishing kit; test tones are not publishable.');
  if (report.contentKey !== contentKey(book)) throw new Error('Export is stale for this story. Re-export the current book first.');
  const disclosure = text(report.disclosure, 'export disclosure', 500);
  const videoHash = await sha256(video);
  if (report.videoSha256 && report.videoSha256 !== videoHash) throw new Error('Video changed after export; re-export before publishing.');
  const probe = spawnSync(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', video], { encoding: 'utf8' });
  if (probe.status !== 0) throw new Error('Cannot inspect completed MP4 with ffprobe.');
  const streams = JSON.parse(probe.stdout).streams;
  const picture = streams.find(s => s.codec_type === 'video'), sound = streams.find(s => s.codec_type === 'audio');
  if (picture?.codec_name !== 'h264' || sound?.codec_name !== 'aac' || picture.width !== report.width || picture.height !== report.height ||
      !Number.isFinite(report.videoDuration) || Math.abs(Number(picture.duration) - report.videoDuration) > 0.1) throw new Error('Video does not match its export report.');
  const source = await readPublishingCopy(story, options.copy);
  const publishing = inside(story.root, path.join(story.root, 'publishing'));
  await fs.mkdir(publishing, { recursive: true });
  const name = options.name || path.basename(video, path.extname(video));
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw new Error('--name must be a simple directory name.');
  const output = inside(publishing, path.join(publishing, name));
  // Reserve this version atomically. Never replace an accepted kit.
  await fs.mkdir(output).catch(error => { if (error.code === 'EEXIST') throw new Error('Publishing kit exists; choose a new --name.'); throw error; });
  let browser;
  try {
    const artData = await fs.readFile(source.art);
    const imageUrl = `data:${source.mime};base64,${artData.toString('base64')}`;
    browser = await openBrowser({ chrome: options.chrome, width: 1080, height: 1920 });
    const { page } = browser;
    const checks = {};
    for (const [shape, size] of Object.entries(COVER_SIZES)) {
      const html = path.join(output, `${shape}.html`);
      await fs.writeFile(html, coverHtml(source.copy, source.title, imageUrl, shape));
      await page.viewport(size.width, size.height);
      await page.goto(pathToFileURL(html).href);
      await page.evaluate('Promise.all([document.fonts.ready, ...Array.from(document.images, i => i.decode())]).then(()=>true)', { awaitPromise: true });
      const measured = await page.evaluate(`(() => {
        const nodes = [...document.querySelectorAll('[data-fit]')];
        // A font's ink can extend past its line box (PingFang SC at a tight line-height does), which
        // inflates scrollHeight without any layout overflow. Allow a fraction of the font size so that
        // quirk is not mistaken for a clipped line, while a real extra line (at least 1em) is still caught.
        const slack = el => Math.max(1, parseFloat(getComputedStyle(el).fontSize) * 0.25);
        for (const el of nodes) {
          let size = parseFloat(getComputedStyle(el).fontSize);
          while ((el.scrollHeight > el.clientHeight + slack(el) || el.scrollWidth > el.clientWidth + 1) && size > 24) el.style.fontSize = (--size) + 'px';
        }
        const clipped = nodes.filter(el => {
          const r = el.getBoundingClientRect(), p = el.parentElement.getBoundingClientRect();
          return el.scrollHeight > el.clientHeight + slack(el) || el.scrollWidth > el.clientWidth + 1 || r.top < p.top - 1 || r.bottom > p.bottom + 1 || r.left < 0 || r.right > innerWidth;
        }).map(el => el.className || el.tagName);
        return { clipped, decoded: [...document.images].every(i => i.naturalWidth > 0), fits: nodes.map(el => parseFloat(getComputedStyle(el).fontSize)) };
      })()`);
      checks[shape] = { clipped: measured.clipped, decoded: measured.decoded };
      if (measured.clipped.length || !measured.decoded || page.errors.length) throw new Error(`Cover layout failed (${shape}): ${JSON.stringify(checks[shape])}. Shorten copy or correct artwork.`);
      // Persist any fitted font sizes so opening the saved layout reproduces the PNG, without
      // pulling the embedded artwork back through Runtime.evaluate.
      await fs.writeFile(html, coverHtml(source.copy, source.title, imageUrl, shape, measured.fits));
      await page.settle();
      const png = await page.screenshot(size.width, size.height);
      if (JSON.stringify(pngSize(png)) !== JSON.stringify({ width: size.width, height: size.height })) throw new Error(`Wrong cover dimensions: ${shape}.`);
      await fs.writeFile(path.join(output, size.file), png);
    }
    // One small combined preview; full artwork never needs to enter the agent context.
    const thumbs = await Promise.all(Object.values(COVER_SIZES).map(async size => `<img src="data:image/png;base64,${(await fs.readFile(path.join(output, size.file))).toString('base64')}">`));
    const previewHtml = path.join(output, '.preview.html');
    await fs.writeFile(previewHtml, `<html><style>body{margin:0;background:#e7e5df;display:flex;align-items:center;justify-content:center;gap:16px;width:960px;height:600px}img{object-fit:contain;max-width:440px;max-height:560px;min-width:0}</style>${thumbs.join('')}</html>`);
    await page.viewport(960, 600);
    await page.goto(pathToFileURL(previewHtml).href);
    await page.evaluate('Promise.all([...document.images].map(i=>i.decode())).then(()=>true)', { awaitPromise: true });
    await page.settle();
    const { data } = await page.client.send('Page.captureScreenshot', { format: 'jpeg', quality: 72, clip: { x: 0, y: 0, width: 960, height: 600, scale: 1 }, captureBeyondViewport: false });
    const preview = Buffer.from(data, 'base64');
    if (preview.length > 250000) throw new Error('Publishing preview exceeds 250 KB.');
    await fs.writeFile(path.join(output, 'preview.jpg'), preview);
    await fs.rm(previewHtml);
    const relative = file => path.relative(story.root, file).split(path.sep).join('/');
    const bundle = {
      version: 1, storyId: story.id, status: 'generated', video: relative(video), videoSha256: videoHash,
      videoWidth: picture.width, videoHeight: picture.height, duration: Number(picture.duration),
      disclosure, contentKey: report.contentKey, copySha256: await sha256(source.file),
      art: relative(source.art), artSha256: await sha256(source.art),
      covers: COVER_SIZES,
      platforms: Object.fromEntries(Object.entries(source.copy.platforms).map(([key, value]) => [key, { ...value, coverFile: COVER_SIZES[value.cover].file }])),
      qa: { automated: checks, visualReview: 'pending: inspect preview.jpg', preview: 'preview.jpg' },
    };
    await fs.writeFile(path.join(output, 'copy.json'), JSON.stringify(source.copy, null, 2) + '\n');
    await fs.writeFile(path.join(output, 'publish.json'), JSON.stringify(bundle, null, 2) + '\n');
    await fs.writeFile(path.join(output, 'publish.md'), markdown(bundle));
    const result = { output, manifest: path.join(output, 'publish.json'), preview: path.join(output, 'preview.jpg') };
    // A separate successful retry must clear a previous exporter's failed-kit status.
    await fs.writeFile(video + '.json', JSON.stringify({ ...report, publishing: { status: 'generated', ...result } }, null, 2));
    console.log(`Publishing kit: ${output}\nPreview: ${path.join(output, 'preview.jpg')}\nReview the preview before delivery; no upload was performed.`);
    return result;
  } catch (error) {
    await fs.rm(output, { recursive: true, force: true });
    throw error;
  } finally {
    await browser?.close();
  }
}

if (isMain(import.meta.url)) {
  const options = {};
  try {
    for (let i = 2; i < process.argv.length; i++) {
      const key = process.argv[i];
      if (!['--project', '--story', '--video', '--copy', '--name', '--chrome', '--check-copy'].includes(key) || !process.argv[i + 1] || process.argv[i + 1].startsWith('--')) throw new Error(`Unknown option or missing value: ${key}`);
      options[key.slice(2)] = process.argv[++i];
    }
    if (options['check-copy']) {
      const copy = validateCopy(JSON.parse(await fs.readFile(path.resolve(options['check-copy']), 'utf8')));
      console.log(JSON.stringify({ valid: true, platforms: Object.keys(copy.platforms), note: 'Copy schema only; story, artwork, video and rendered layout are not verified.' }, null, 2));
    } else await publishBundle(options);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
