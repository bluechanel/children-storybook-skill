// Serve the prebuilt renderer plus one story's browser assets, with nothing but node:http.
//
// Run it directly for a one-command preview of the flipbook:
//
//   node static-server.mjs --project <dir> [--story <id>] [--port 5173] [--title "…"]
//
// and it prints a URL to open and stays up until interrupted. It is also the module the
// exporter and qa_browser.mjs start for their own runs.
//
// This replaces the Vite dev server for the export, preview and browser-QA paths, so a
// user needs no npm install. It serves four kinds of thing:
//   /            a synthesized page (the repo's index.html references /src/main.js, which
//                only exists under Vite, so the export page is built here instead)
//   /app.js      the driver: mounts the prebuilt renderer with the story
//   /story.js    the selected story's bookContent + narrationConfig, re-exported
//   /book.js     the prebuilt renderer, /book.css its stylesheet
//   /stories/*   the story's page documents, ready audio and timeline (allowlisted)
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { skillDir, resolveProject, resolveBook, isMain } from './project.mjs';
import { STORY_ASSET, resolveStoryAsset, storyAssetKind } from './story-assets.mjs';

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

const RENDERER = path.join(skillDir(import.meta.url), 'renderer');

function page(title = '小小故事书') {
  // lang matters: it participates in font fallback for the cover text.
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="theme-color" content="#f5f1e8" />
    <title>${title}</title>
    <link rel="stylesheet" href="/book.css" />
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/app.js"></script>
  </body>
</html>
`;
}

function driver() {
  return `import { mount } from '/book.js';
import { bookContent, narrationConfig } from '/story.js';
// Assigning window.bookDemo happens inside mount() so a driver that only reads globals works.
await mount({ bookContent, narrationConfig });
`;
}

function storyModule(story) {
  // Both bindings: without narrationConfig the served page loses its narration entirely.
  return `export { bookContent } from '/stories/${story}/content.js';
export { narrationConfig } from '/stories/${story}/narration.js';
`;
}

function send(res, status, type, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  // Never cache: the QA loop is "rebuild the pages, look again", and a stale page document
  // would silently produce the wrong video.
  res.setHeader('Cache-Control', 'no-cache');
  res.end(body);
}

async function sendFile(res, file, type) {
  let stat;
  try { stat = await fsp.stat(file); } catch { return send(res, 404, 'text/plain; charset=utf-8', 'Not found'); }
  if (!stat.isFile()) return send(res, 404, 'text/plain; charset=utf-8', 'Not found');
  res.statusCode = 200;
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Cache-Control', 'no-cache');
  await new Promise(resolve => {
    const stream = fs.createReadStream(file);
    stream.on('error', () => { res.destroy(); resolve(); });
    stream.on('end', resolve);
    stream.pipe(res);
  });
}

// Start the server on a loopback port. Returns { url, port, close }.
export async function serveStory({ project, story, port = 0, title } = {}) {
  const stories = path.join(project, process.env.STORYBOOK_STORIES_DIR || 'stories');
  const server = http.createServer(async (request, response) => {
    let route;
    try { route = decodeURIComponent((request.url || '/').split('?')[0]); } catch { route = '/'; }
    try {
      if (route === '/' || route === '/index.html') {
        return send(response, 200, MIME['.html'], page(title));
      }
      if (route === '/app.js') return send(response, 200, MIME['.js'], driver());
      if (route === '/story.js') return send(response, 200, MIME['.js'], storyModule(story));
      if (route === '/book.js' || route === '/book.css') {
        return sendFile(response, path.join(RENDERER, route.slice(1)), MIME[path.extname(route)]);
      }
      if (route.startsWith('/stories/')) {
        const relative = route.slice('/stories/'.length);
        // content.js / narration.js are plain modules; Vite used to transform them, we do not.
        if (/^[a-z0-9-]+\/(content|narration)\.js$/.test(relative)) {
          const file = path.join(stories, relative);
          if (!path.resolve(file).startsWith(path.resolve(stories) + path.sep)) {
            return send(response, 404, 'text/plain; charset=utf-8', 'Not found');
          }
          return sendFile(response, file, MIME['.js']);
        }
        if (!STORY_ASSET.test(relative)) {
          return send(response, 404, 'text/plain; charset=utf-8', 'Not found');
        }
        const file = await resolveStoryAsset(stories, relative);
        if (!file) return send(response, 404, 'text/plain; charset=utf-8', 'Not found');
        return sendFile(response, file, storyAssetKind(relative));
      }
      return send(response, 404, 'text/plain; charset=utf-8', 'Not found');
    } catch (error) {
      if (!response.headersSent) send(response, 500, 'text/plain; charset=utf-8', String(error.message));
      else response.destroy();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const actual = server.address().port;
  return {
    url: `http://127.0.0.1:${actual}/`,
    port: actual,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

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

// The preview itself: resolve the story, serve it, print the URL, and stay up. Without this
// the module could only be imported, so a project with no app scaffold had no single command
// that showed the finished flipbook.
export async function preview(options = {}) {
  if (options.help) {
    console.log('Usage: node static-server.mjs [--project <dir>] [--story <id>] [--port <n>] [--title <text>]');
    console.log('Serves the prebuilt reader and the selected story, prints a URL, and stays up until interrupted.');
    return null;
  }
  const project = resolveProject(options.project);
  const book = await resolveBook(project, options.story);
  const port = options.port === undefined ? 0 : Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be an integer between 0 and 65535.');
  const server = await serveStory({ project, story: book.storyId, port, title: options.title });
  console.log(`Serving "${book.title || book.storyId}" from ${project}`);
  console.log(`Open ${server.url} — Ctrl-C to stop.`);
  const stop = () => { server.close().then(() => process.exit(0)); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return server;
}

if (isMain(import.meta.url)) {
  preview(parseArgs(process.argv.slice(2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
