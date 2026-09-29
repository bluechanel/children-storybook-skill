#!/usr/bin/env node
// Prebuild the reader into renderer/book.js + renderer/book.css.
//
// This is a DEVELOPMENT-time step and needs the repo's vite and three, which is fine —
// the point is that a *user* of the skill never runs it. They get the committed artifacts
// and need only node, python3, ffmpeg and a browser.
//
//   node renderer/build.mjs            rebuild
//   node renderer/build.mjs --check    fail if the committed artifacts are stale (no vite)
//
// The bundle is deliberately story-free: it takes the story as an argument, so one artifact
// serves every story and never needs rebuilding when the content changes.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RENDERER = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.dirname(RENDERER);
const INFO = path.join(RENDERER, 'build-info.json');

// Everything that changes the artifact, including the shared timing module it bundles.
const SOURCES = [
  'src/book.js',
  'src/shell.js',
  'src/narration-player.js',
  'src/style.css',
  '../scripts/media-core.mjs',
];

async function fingerprint() {
  const hashes = {};
  for (const relative of SOURCES) {
    const file = path.join(RENDERER, relative);
    const bytes = await fs.readFile(file).catch(() => null);
    hashes[relative] = bytes ? createHash('sha256').update(bytes).digest('hex') : null;
  }
  return hashes;
}

async function packageVersions() {
  const versions = {};
  for (const name of ['vite', 'three']) {
    try {
      const file = path.join(RENDERER, '..', '..', '..', 'node_modules', name, 'package.json');
      versions[name] = JSON.parse(await fs.readFile(file, 'utf8')).version;
    } catch { versions[name] = null; }
  }
  return versions;
}

async function loadVite() {
  try {
    return await import('vite');
  } catch {
    throw new Error('vite is not installed. Building the renderer is a development step:\n' +
      '  npm install   (in the repository that contains this skill)\n' +
      'Users of the skill do not need this — renderer/book.js ships prebuilt.');
  }
}

async function build() {
  const { build: viteBuild } = await loadVite();
  // Build into a staging directory and copy the two files out. Pointing Vite's outDir at
  // the source tree makes it warn about overwriting sources, and rightly so.
  const staging = await fs.mkdtemp(path.join(RENDERER, '.build-'));
  try {
    await viteBuild({
      root: RENDERER,
      configFile: false,
      logLevel: 'warn',
      build: {
        outDir: staging,
        emptyOutDir: true,
        minify: true,
        target: 'es2022',
        cssCodeSplit: false,
        lib: { entry: path.join(RENDERER, 'src/book.js'), formats: ['es'], fileName: 'book' },
        rollupOptions: {
          output: { codeSplitting: false, entryFileNames: 'book.js', assetFileNames: 'book.[ext]' },
        },
      },
    });
    for (const name of ['book.js', 'book.css']) {
      await fs.copyFile(path.join(staging, name), path.join(RENDERER, name));
    }
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
  const info = {
    builtAt: new Date().toISOString(),
    entry: 'src/book.js',
    outputs: ['book.js', 'book.css'],
    sources: await fingerprint(),
    packages: await packageVersions(),
  };
  await fs.writeFile(INFO, JSON.stringify(info, null, 2) + '\n');
  const stat = await fs.stat(path.join(RENDERER, 'book.js'));
  console.log(`Built renderer/book.js (${(stat.size / 1024).toFixed(0)} KB) and renderer/book.css`);
  console.log('Three.js is bundled under the MIT licence; see renderer/NOTICE.');
}

async function check() {
  let recorded;
  try {
    recorded = JSON.parse(await fs.readFile(INFO, 'utf8'));
  } catch {
    throw new Error('renderer/build-info.json is missing. Run: node renderer/build.mjs');
  }
  const current = await fingerprint();
  const stale = Object.keys(current).filter(name => current[name] !== recorded.sources?.[name]);
  const packages = await packageVersions();
  const bumped = Object.keys(packages).filter(name => packages[name] && packages[name] !== recorded.packages?.[name]);
  for (const name of stale) console.error(`  stale: ${name}`);
  for (const name of bumped) console.error(`  ${name} changed since the build: ${recorded.packages[name]} -> ${packages[name]}`);
  if (stale.length || bumped.length) {
    throw new Error('renderer/book.js is out of date. Run: node renderer/build.mjs');
  }
  console.log(`renderer/book.js is up to date (built ${recorded.builtAt}).`);
}

const mode = process.argv.includes('--check') ? check : build;
mode().catch(error => { console.error(error.message); process.exitCode = 1; });
