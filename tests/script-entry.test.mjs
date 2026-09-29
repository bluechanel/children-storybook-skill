// How the skill's CLIs decide they are the entry point.
//
// They used to compare import.meta.url with path.resolve(process.argv[1]), which does not
// resolve symlinks — while references/project-setup.md recommends installing the skill as a
// symlink. A symlinked CLI therefore exited 0 having printed nothing and done nothing, which
// is the worst kind of failure: it looks like success.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMain } from '../skills/children-storybook/scripts/project.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPTS = path.join(ROOT, 'skills', 'children-storybook', 'scripts');

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'skill-entry-'));
}

test('isMain recognises the entry point through a symlink', async () => {
  const dir = await tempDir();
  const real = path.join(dir, 'real.mjs');
  const link = path.join(dir, 'link.mjs');
  const chain = path.join(dir, 'chain.mjs');
  await fs.writeFile(real, 'export const x = 1;\n');
  await fs.symlink(real, link);
  await fs.symlink(link, chain);
  const meta = pathToFileURL(real).href;

  assert.equal(isMain(meta, real), true, 'a direct invocation is the entry point');
  assert.equal(isMain(meta, link), true, 'and so is one through a symlink');
  assert.equal(isMain(meta, chain), true, 'and through a chain of them');
  assert.equal(isMain(meta, path.join(dir, 'other.mjs')), false, 'a different file is not');
  assert.equal(isMain(meta, undefined), false, 'no argv[1] means it was imported');
});

test('the version is reported, and the changelog agrees with it', async () => {
  const version = (await fs.readFile(path.join(SCRIPTS, '..', 'VERSION'), 'utf8')).trim();
  assert.match(version, /^\d+\.\d+\.\d+$/, 'VERSION is a semver string');

  // A standalone skill has no version field in SKILL.md, and Claude Code silently ignores an
  // unknown one — so a `version:` there would look like it worked and then fail the strict
  // packagers. The number lives in VERSION, and this asserts nobody added the trap back.
  const skill = await fs.readFile(path.join(SCRIPTS, '..', 'SKILL.md'), 'utf8');
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(skill)?.[1] ?? '';
  assert.ok(!/^version:/m.test(frontmatter), 'SKILL.md must not carry a version field');

  // The newest changelog heading is the release this VERSION claims to be. Bumping one and
  // not the other is the failure this catches.
  const changelog = await fs.readFile(path.join(SCRIPTS, '..', 'CHANGELOG.md'), 'utf8');
  const newest = /^##\s*\[([^\]]+)\]/m.exec(changelog);
  assert.ok(newest, 'CHANGELOG.md has a newest release heading');
  assert.equal(newest[1], version, 'VERSION and the newest CHANGELOG heading must agree');

  const run = spawnSync(process.execPath, [path.join(SCRIPTS, 'where.mjs'), '--json'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(JSON.parse(run.stdout).skillVersion, version, 'where.mjs reports it');
});

test('every CLI in the skill uses the shared check', async () => {
  const files = (await fs.readdir(SCRIPTS)).filter(name => name.endsWith('.mjs'));
  assert.ok(files.length > 5);
  const offenders = [];
  for (const name of files) {
    const source = await fs.readFile(path.join(SCRIPTS, name), 'utf8');
    if (/import\.meta\.url\s*===\s*pathToFileURL/.test(source)) offenders.push(name);
  }
  assert.deepEqual(offenders, [], 'these compare raw paths and silently no-op through a symlink');
});

test('a symlinked CLI does its job instead of exiting 0 in silence', async () => {
  const dir = await tempDir();
  const project = path.join(dir, 'project');
  const story = path.join(project, 'stories', 'demo-v1');
  await fs.mkdir(story, { recursive: true });
  await fs.writeFile(path.join(story, 'content.js'), 'export const bookContent = ' + JSON.stringify({
    storyId: 'demo-v1',
    title: 'Demo',
    sheets: [{ front: { text: 'One.', image: 'a.png' }, back: { text: 'Two.', image: 'b.png' } }],
  }) + ';\n');
  await fs.writeFile(path.join(story, 'manifest.json'), JSON.stringify({ id: 'demo-v1' }));
  // A guarded CLI, run through a symlink exactly as project-setup.md installs the skill.
  const link = path.join(dir, 'prepare_narration.mjs');
  await fs.symlink(path.join(SCRIPTS, 'prepare_narration.mjs'), link);

  const run = spawnSync(process.execPath, [link, '--project', project, '--story', 'demo-v1', '--plan'],
    { cwd: dir, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Planned 2 clips/, `a symlinked run must actually run:\n${run.stdout}${run.stderr}`);
  const plan = JSON.parse(await fs.readFile(path.join(story, 'audio', 'requests.json'), 'utf8'));
  assert.equal(plan.status, 'planned');
  assert.equal(plan.requests.length, 2);
});

test('a symlinked where.mjs reports the project it was run against', async () => {
  const dir = await tempDir();
  const project = path.join(dir, 'project');
  await fs.mkdir(project);
  const link = path.join(dir, 'where.mjs');
  await fs.symlink(path.join(SCRIPTS, 'where.mjs'), link);

  const run = spawnSync(process.execPath, [link, '--json'], { cwd: project, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.notEqual(run.stdout.trim(), '', 'a symlinked run must not produce nothing');
  const info = JSON.parse(run.stdout);
  // realpath on both sides: macOS resolves /var to /private/var in the child's cwd.
  assert.equal(await fs.realpath(info.project), await fs.realpath(project));
  assert.equal(info.projectFrom, 'cwd');
  assert.ok(info.skill.endsWith(path.join('skills', 'children-storybook')), `unexpected skill root: ${info.skill}`);
});

test('--project is honoured rather than ignored', async () => {
  const dir = await tempDir();
  const elsewhere = path.join(dir, 'elsewhere');
  await fs.mkdir(elsewhere);
  const run = spawnSync(process.execPath, [path.join(SCRIPTS, 'where.mjs'), '--project', elsewhere, '--json'],
    { cwd: ROOT, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const info = JSON.parse(run.stdout);
  assert.equal(await fs.realpath(info.project), await fs.realpath(elsewhere));
  assert.equal(info.projectFrom, '--project');

  const missing = spawnSync(process.execPath, [path.join(SCRIPTS, 'where.mjs'), '--project'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(missing.status, 2, 'a flag with no value is a usage error');
});

test('a project with no app scaffold is not reported as having no story', async () => {
  const dir = await tempDir();
  const where = path.join(SCRIPTS, 'where.mjs');
  const report = project => JSON.parse(spawnSync(process.execPath, [where, '--project', project, '--json'], { cwd: ROOT, encoding: 'utf8' }).stdout);

  // Nothing built at all: say that, rather than "no story".
  const bare = path.join(dir, 'bare');
  await fs.mkdir(bare);
  const empty = report(bare);
  assert.equal(empty.story, null);
  assert.match(empty.storyNote, /no stories\/ folder yet/, 'it says which thing is missing');

  // stories/ exists but no pointer and no story inside: name the pointer that is absent.
  const scaffoldless = path.join(dir, 'scaffoldless');
  await fs.mkdir(path.join(scaffoldless, 'stories'), { recursive: true });
  const noPointer = report(scaffoldless);
  assert.equal(noPointer.story, null);
  assert.match(noPointer.storyNote, /no src\/active-story\.js/, 'it does not blame the story');
  assert.match(noPointer.storyNote, /pass --story <id>/, 'and it says what to do instead');
});
