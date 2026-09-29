#!/usr/bin/env node
// Reader QA: load the book in a real browser at landscape sizes, confirm every page image
// actually decoded, and capture one screenshot per sheet into the story's qa folder.
//
// By default it serves the prebuilt reader itself, so it needs no dev server and no npm
// install. Point --url at a running dev server to check that instead.
//
//   node qa_browser.mjs --story goldilocks-and-the-three-bears-v1
//   node qa_browser.mjs --url http://127.0.0.1:5173/ --viewports 1366x768,844x390
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveProject, storiesDir, activeStoryId, resolveBook, isMain } from './project.mjs';
import { openBrowser } from './cdp.mjs';
import { serveStory } from './static-server.mjs';

const BOOLEAN = new Set(['help']);
function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error(`Unexpected argument: ${argv[i]}`);
    const key = argv[i].slice(2);
    if (BOOLEAN.has(key)) result[key] = true;
    else { if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing value: ${key}`); result[key] = argv[++i]; }
  }
  return result;
}

const DEFAULT_VIEWPORTS = '1366x768,844x390';

function parseViewports(spec) {
  return spec.split(',').map(entry => {
    const [width, height] = entry.trim().split('x').map(Number);
    if (!Number.isInteger(width) || !Number.isInteger(height)) throw new Error(`Bad viewport: ${entry}`);
    return { name: `${width}x${height}`, width, height };
  });
}

export async function qaBrowser(options = {}) {
  const project = resolveProject(options.project);
  const stories = storiesDir(project);
  const book = await resolveBook(project, options.story);
  const story = book.storyId;
  const viewports = parseViewports(options.viewports || DEFAULT_VIEWPORTS);
  const outDir = path.resolve(options.out || path.join(stories, story, 'qa', 'screenshots'));
  const wait = Number(options.wait || 2200);
  await fs.mkdir(outDir, { recursive: true });

  let server = null;
  const url = options.url || (server = await serveStory({ project, story })).url;
  const browser = await openBrowser({ chrome: options.chrome });
  const report = [];
  try {
    for (const viewport of viewports) {
      await browser.page.client.send('Network.enable').catch(() => {});
      const failures = [];
      const requested = new Map();
      // A missing favicon is browser noise, not a problem with the book.
      const noise = url => /\/favicon\.ico$/.test(url || '');
      browser.page.client.on('Network.requestWillBeSent', params => requested.set(params.requestId, params.request.url));
      browser.page.client.on('Network.loadingFailed', params => {
        const target = requested.get(params.requestId);
        if (!noise(target)) failures.push(`${params.errorText} ${target || params.requestId}`);
      });
      browser.page.client.on('Network.responseReceived', params => {
        if (params.response.status >= 400 && !noise(params.response.url)) {
          failures.push(`${params.response.status} ${params.response.url}`);
        }
      });
      try {
        await browser.page.viewport(viewport.width, viewport.height);
        await browser.page.goto(url);
        const present = await browser.page.evaluate('Boolean(window.bookDemo)');
        if (!present) {
          // A host scaffold without the reader cannot be checked this way.
          throw new Error(`${url} exposes no window.bookDemo; this front end is not a checkable storybook.` +
            (browser.page.errors.length ? `\nPage reported: ${browser.page.errors.join('; ')}` : ''));
        }
        await browser.page.evaluate('window.bookDemo.ready.then(()=>true)', { awaitPromise: true });
        await new Promise(resolve => setTimeout(resolve, 1500));

        // The reader paints page art onto canvas textures, so there are no <img> elements
        // to count — ask it what it loaded instead.
        const media = await browser.page.evaluate('window.bookDemo.media');
        const sheets = Number(options.states || book.sheets?.length || 0) || 5;

        for (let i = 1; i <= sheets; i++) {
          const png = await browser.page.screenshot(viewport.width, viewport.height);
          await fs.writeFile(path.join(outDir, `${viewport.name}-spread${i}.png`), png);
          if (i < sheets) {
            await browser.page.press('ArrowRight');
            await new Promise(resolve => setTimeout(resolve, wait));
          }
        }
        if (media?.failed?.length) failures.push(`page images failed to load: ${media.failed.join(', ')}`);
        report.push({ viewport: viewport.name, sheets, imagesLoaded: media?.requested ?? 0, failures });
      } catch (error) {
        report.push({ viewport: viewport.name, error: error.message, failures });
      }
    }
  } finally {
    await browser.close();
    await server?.close();
  }

  const target = path.join(path.dirname(outDir), 'browser-check.json');
  await fs.writeFile(target, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  const errored = report.filter(entry => entry.error || entry.failures?.length);
  if (errored.length) throw new Error(`${errored.length} viewport(s) reported problems; see ${target}.`);
  console.log(`Checked ${report.length} viewport(s); screenshots in ${outDir}`);
  return report;
}

if (isMain(import.meta.url)) {
  qaBrowser(parseArgs(process.argv.slice(2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
