// Where the skill lives, and where the project it is working on lives.
//
// Nothing here depends on a particular agent host. The skill root is derived from this
// file's own location, so no environment variable is needed to find it — which matters
// because Claude Code substitutes ${CLAUDE_SKILL_DIR} only into SKILL.md *text* and never
// exports it, and other agents do not know that name at all.
//
// The project root comes from --project, then a neutral environment variable, then the
// host-specific one, then the working directory. The neutral name comes first so any agent
// can set it; CLAUDE_PROJECT_DIR is kept working because Claude Code sets it for the Bash
// tool. Running from the project root needs neither.
//
// There is deliberately no host-dependency loading here either: the export path used to pull
// vite and Playwright out of the project, and now uses a plain HTTP server and CDP instead,
// so nothing in this skill imports a package the user would have to install.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The directory holding this skill, derived from this file. Always correct, never
// read from the environment.
export function skillDir(importMetaUrl) {
  return path.dirname(path.dirname(fileURLToPath(importMetaUrl)));
}

// Is this module the program's entry point, or was it imported by another script?
//
// process.argv[1] is the path the user typed, which project-setup.md recommends making a
// symlink; import.meta.url is the path Node resolved. Comparing them without realpath()
// makes every symlinked CLI exit 0 having done nothing at all — no output, no error — so
// both sides are resolved through the filesystem first.
export function isMain(importMetaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return fs.realpathSync(fileURLToPath(importMetaUrl)) === fs.realpathSync(path.resolve(argv1));
  } catch {
    return false;
  }
}

// Environment variables consulted for the project root, in order. The first is this skill's
// own neutral name, settable by any agent or by a person; the second is what Claude Code
// exports for its Bash tool.
export const PROJECT_ENV = ['CHILDREN_STORYBOOK_PROJECT', 'CLAUDE_PROJECT_DIR'];

export function projectEnvSource() {
  for (const name of PROJECT_ENV) {
    if (process.env[name]) return `$${name}`;
  }
  return 'the working directory';
}

// The host project that owns stories/ and src/.
// Explicit --project wins; then the variables above; the working directory is the last resort.
export function resolveProject(explicit) {
  const fromEnv = PROJECT_ENV.map(name => process.env[name]).find(Boolean);
  const chosen = explicit || fromEnv || process.cwd();
  if (typeof chosen !== 'string' || !chosen.trim()) throw new Error('Project path must be a directory.');
  const project = path.resolve(chosen);
  let stat;
  try { stat = fs.statSync(project); } catch { throw new Error(`Project directory does not exist: ${project}`); }
  if (!stat.isDirectory()) throw new Error(`Project path is not a directory: ${project}`);
  return project;
}

// Story folders are `stories/` by default. Only the filesystem location is
// configurable; the /stories/<id>/ URL prefix is a fixed contract shared with
// story-assets.mjs and src/active-story.js.
export function storiesDir(project) {
  const name = process.env.STORYBOOK_STORIES_DIR || 'stories';
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error('STORYBOOK_STORIES_DIR must be a simple folder name.');
  return path.join(project, name);
}

// Read KEY=VALUE pairs from the project's .env.local into process.env.
// An already-set variable always wins, so an explicit environment or a npm
// --env-file flag is never overridden. Values are never logged.
export function loadEnvLocal(project) {
  const file = path.join(project, '.env.local');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const loaded = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    let value = rawValue.trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) { process.env[key] = value; loaded.push(key); }
  }
  return loaded;
}

// The book the host app currently selects, from its own src/ pointer. Used only to learn
// which story is active, and as a fallback for isolated test layouts.
export async function activeBook(project) {
  const entry = path.join(project, 'src/content.js');
  const { bookContent } = await import(pathToFileURL(entry).href);
  if (!bookContent?.storyId) throw new Error(`${entry} exports no bookContent.storyId.`);
  return bookContent;
}

export async function activeStoryId(project) {
  return (await activeBook(project)).storyId;
}

// Which story are we working on, and what is its book data?
//
// The story folder is the source of truth, so its own content.js is preferred; the app's
// src/ pointer is only consulted to learn *which* story, and as a fallback for the isolated
// layouts the unit tests build. This is what lets exporting run in a project that has no
// src/ directory at all.
export async function resolveBook(project, explicit) {
  const stories = storiesDir(project);
  let id = explicit || await activeStoryId(project).catch(() => null);
  if (!id) {
    const entries = await fsp.readdir(stories, { withFileTypes: true }).catch(() => []);
    const found = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const inside = path.join(stories, entry.name);
      const has = name => fs.existsSync(path.join(inside, name));
      if (has('content.js') || has('manifest.json')) found.push(entry.name);
    }
    if (found.length > 1) throw new Error(`Several stories are present (${found.join(', ')}); pass --story <id>.`);
    id = found[0];
  }
  if (id) {
    const file = path.join(stories, id, 'content.js');
    try {
      const { bookContent } = await import(pathToFileURL(file).href);
      if (bookContent?.sheets?.length) return bookContent;
    } catch { /* fall through to the app's pointer */ }
  }
  const fallback = await activeBook(project).catch(() => null);
  if (fallback?.sheets?.length) return fallback;
  throw new Error(id
    ? `${path.join(stories, id, 'content.js')} exports no bookContent. Compose the pages first: build_book.py <manifest> --build <version>`
    : `No story found under ${stories}. Pass --story <id>, or build one first.`);
}
