#!/usr/bin/env node
// Render composed page SVG documents to PNG with a real browser, for visual QA.
// Pages are discovered on disk, so any spread count works.
//
//   node shot_pages.mjs --story goldilocks-and-the-three-bears-v1
//   node shot_pages.mjs --project ~/code/mybook --pages-version v2 --width 1024 --height 1400
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveProject, storiesDir, activeStoryId, isMain } from './project.mjs';
import { openBrowser, pngSize } from './cdp.mjs';

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

export async function shotPages(options = {}) {
  const project = resolveProject(options.project);
  const stories = storiesDir(project);
  const story = options.story || await activeStoryId(project).catch(() => null);
  if (!story) throw new Error('No story selected. Pass --story <id>.');
  const version = options.version || 'v1';
  const root = path.join(stories, story, 'pages', version);
  const names = options.names
    ? options.names.split(',').map(n => n.trim()).filter(Boolean)
    : (await fs.readdir(root)).filter(f => f.endsWith('.svg')).map(f => f.slice(0, -4))
        .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  if (!names.length) throw new Error(`No page SVG documents in ${root}. Build the pages first.`);
  const outDir = path.resolve(options.out || path.join(stories, story, 'qa', 'pages'));
  const width = Number(options.width || 1024), height = Number(options.height || 1400);
  await fs.mkdir(outDir, { recursive: true });

  const browser = await openBrowser({ chrome: options.chrome, width, height });
  try {
    for (const name of names) {
      const file = path.join(root, `${name}.svg`);
      await fs.access(file).catch(() => { throw new Error(`Missing page document: ${file}`); });
      await browser.page.goto(pathToFileURL(file).href);
      await browser.page.evaluate('document.fonts.ready.then(()=>true)', { awaitPromise: true });
      const png = await browser.page.screenshot(width, height);
      const size = pngSize(png);
      if (!size || size.width !== width || size.height !== height) {
        throw new Error(`${name}: rendered ${size ? `${size.width}×${size.height}` : 'nothing'}, expected ${width}×${height}.`);
      }
      await fs.writeFile(path.join(outDir, `${name}.png`), png);
    }
  } finally { await browser.close(); }
  console.log(`Rendered ${names.length} page(s) to ${outDir}`);
  return { story, version, outDir, names };
}

if (isMain(import.meta.url)) {
  shotPages(parseArgs(process.argv.slice(2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
