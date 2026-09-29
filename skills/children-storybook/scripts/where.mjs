#!/usr/bin/env node
// Report where everything is, so a host agent does not have to know this skill's
// conventions before it can run anything.
//
//   node <skill>/scripts/where.mjs            human-readable
//   node <skill>/scripts/where.mjs --json     machine-readable
//
// Nothing here depends on a specific agent host: the skill directory is derived from this
// file's own location, and the project falls back to the working directory.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { skillDir, resolveProject, storiesDir, activeStoryId, loadEnvLocal } from './project.mjs';
import { findBrowser } from './cdp.mjs';
import { resolveTts } from './prepare_narration.mjs';

// The skill's own version, from the VERSION file beside SKILL.md. This is the only thing that
// surfaces it: Claude Code has no version field for skills and never reads one, so a copy that
// cannot say which version it is can only be identified by diffing it against the source.
// A missing or unreadable file is reported as unknown, never as an error — this is a
// diagnostic script and must not fail on a partial install.
function skillVersion(skill) {
  try {
    const text = fs.readFileSync(path.join(skill, 'VERSION'), 'utf8').trim();
    return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(text) ? text : null;
  } catch {
    return null;
  }
}

async function report(explicitProject) {
  const skill = skillDir(import.meta.url);
  const project = resolveProject(explicitProject);
  // Read .env.local before reporting so the TTS endpoint shown is the one a narration run
  // would use. An already-set variable still wins, and nothing here makes a network request.
  loadEnvLocal(project);
  const sources = [
    ['--project', explicitProject || null],
    ['$CHILDREN_STORYBOOK_PROJECT', process.env.CHILDREN_STORYBOOK_PROJECT],
    ['$CLAUDE_PROJECT_DIR', process.env.CLAUDE_PROJECT_DIR],
    ['cwd', process.cwd()],
  ];
  const projectFrom = (sources.find(([, value]) => value) || ['cwd'])[0];
  const stories = storiesDir(project);

  let story = null;
  try { story = await activeStoryId(project); } catch { /* no app pointer; fall back to discovery */ }
  let storyFrom = story ? 'src/active-story.js' : null;
  // "This project has no app scaffold" and "this project has no story" are different
  // problems, and only one of them is the reader's fault. Say which one it is.
  const hasPointer = fs.existsSync(path.join(project, 'src', 'active-story.js'));
  let storyNote = null;
  if (!story) {
    const entries = fs.existsSync(stories)
      ? fs.readdirSync(stories, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.'))
      : [];
    const withContent = entries.filter(e => fs.existsSync(path.join(stories, e.name, 'content.js')));
    if (withContent.length === 1) { story = withContent[0].name; storyFrom = 'the only story present'; }
    else if (withContent.length > 1) storyFrom = `${withContent.length} stories present; pass --story`;
    else if (!fs.existsSync(stories)) storyNote = `no ${path.basename(stories)}/ folder yet — nothing has been built here`;
    else if (!withContent.length) storyNote = hasPointer
      ? 'src/active-story.js points at no story that exists here'
      : 'no src/active-story.js in this project and no story folder yet (normal before the first build; pass --story <id> once one exists)';
  }

  let browser = null;
  try { browser = findBrowser(); } catch { /* reported as missing */ }
  const ffmpeg = (process.env.FFMPEG_PATH || 'ffmpeg');
  const hasFfmpeg = spawnSync(ffmpeg, ['-version'], { encoding: 'utf8' }).status === 0;
  // Resolved, not probed: this script stays offline. `narrate.mjs --check` does the live check.
  let tts = null;
  try { const resolved = resolveTts(); tts = { base: resolved.base, source: resolved.source, key: Boolean(resolved.key) }; } catch { /* reported as unresolved */ }

  return {
    skill,
    skillVersion: skillVersion(skill),
    project,
    projectFrom,
    stories,
    storiesExists: fs.existsSync(stories),
    story,
    storyFrom,
    storyNote,
    envFile: fs.existsSync(path.join(project, '.env.local')),
    node: process.version,
    ffmpeg: hasFfmpeg ? ffmpeg : null,
    browser,
    tts,
  };
}

function storyLine(info) {
  if (info.story) return `${info.story}${info.storyFrom ? `   (from ${info.storyFrom})` : ''}`;
  if (info.storyFrom) return `${info.storyFrom}`;
  return `(none — ${info.storyNote})`;
}

function print(info) {
  const mark = value => (value ? '✔' : '✖');
  console.log(`skill      ${info.skill}   ${info.skillVersion ? `v${info.skillVersion}` : '(version unknown — no VERSION file)'}`);
  console.log(`project    ${info.project}   (from ${info.projectFrom})`);
  console.log(`${mark(info.storiesExists)} stories   ${info.stories}`);
  console.log(`${mark(info.story)} story      ${storyLine(info)}`);
  console.log(`${mark(info.envFile)} .env.local ${info.envFile ? path.join(info.project, '.env.local') : '(absent — no OPENAI_TTS_API_KEY will be found)'}`);
  console.log(`${mark(info.tts)} tts        ${info.tts ? `${info.tts.base}   (from ${info.tts.source}${info.tts.key ? '' : '; no key set'})` : '(base URL is not a valid URL)'}`);
  console.log(`${mark(true)} node       ${info.node}`);
  console.log(`${mark(info.ffmpeg)} ffmpeg     ${info.ffmpeg || '(not found — needed for MP4 export)'}`);
  console.log(`${mark(info.browser)} browser    ${info.browser || '(not found — needed for rendering)'}`);
  console.log('');
  console.log('Run scripts by absolute path; the skill locates itself, so no variable is required.');
  if (info.projectFrom === 'cwd') {
    console.log('Pass --project <dir> or set CHILDREN_STORYBOOK_PROJECT when running from elsewhere.');
  }
}

// --project is honoured here too: the hint this script prints tells the reader to pass it,
// and a flag that is silently ignored is worse than no flag.
const argv = process.argv.slice(2);
const flagIndex = argv.indexOf('--project');
const explicitProject = flagIndex === -1 ? null : argv[flagIndex + 1];
const asJson = argv.includes('--json');
if (flagIndex !== -1 && (!explicitProject || explicitProject.startsWith('--'))) {
  console.error('--project needs a directory.');
  process.exitCode = 2;
} else {
  report(explicitProject)
    .then(info => { asJson ? console.log(JSON.stringify(info, null, 2)) : print(info); })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
