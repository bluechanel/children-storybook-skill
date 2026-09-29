import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { bookContent } from '../src/content.js';
import { makeTimeline, pageSequence } from '../skills/children-storybook/scripts/media-core.mjs';
import { wav } from '../skills/children-storybook/scripts/prepare_narration.mjs';

function testAudio() {
  const clips=pageSequence(bookContent).map(page=>({id:page.id,file:page.id+'.wav',samples:48000/2}));
  const timeline=makeTimeline(bookContent,clips);
  const bytes=wav(timeline.totalSamples); // Explicit silent browser fixture, no TTS claims.
  return {bytes,timeline:{...timeline,mode:'ready',audioUrl:'/narration/test/master.wav',audioSha256:crypto.createHash('sha256').update(bytes).digest('hex'),disclosure:'Test fixture'}};
}
async function routedAudio(page,modify=()=>{}) {
  const audio=testAudio();modify(audio.timeline);
  await page.route('**/src/narration.js',route=>route.fulfill({contentType:'text/javascript',body:'export const narrationConfig = {url:"/narration/test/timeline.json"};'}));
  await page.route('**/narration/test/timeline.json',route=>route.fulfill({json:audio.timeline}));
  await page.route('**/narration/test/master.wav',route=>route.fulfill({contentType:'audio/wav',body:audio.bytes}));
  return audio;
}

test('audio clock pauses/resumes mid-turn and manual navigation cancels it',async({page})=>{
  await routedAudio(page);
  await page.goto('http://127.0.0.1:5173');
  await expect.poll(()=>page.evaluate(()=>window.bookDemo?.narration.status)).toBe('ready');
  await expect(page.locator('#ai-disclosure')).toBeVisible();
  await page.locator('#play').click();
  await expect.poll(()=>page.evaluate(()=>window.bookDemo.narration.status)).toBe('playing');
  await expect.poll(()=>page.evaluate(()=>window.bookDemo.state.current!==window.bookDemo.state.target)).toBe(true);
  await page.locator('#play').click();
  await expect.poll(()=>page.evaluate(()=>window.bookDemo.narration.status)).toBe('paused');
  const before=await page.evaluate(()=>window.bookDemo.narration.time);
  await page.waitForTimeout(200);
  expect(await page.evaluate(()=>window.bookDemo.narration.time)).toBe(before);
  await page.locator('#play').click();
  await expect.poll(()=>page.evaluate(()=>window.bookDemo.narration.status)).toBe('playing');
  await expect.poll(()=>page.evaluate(()=>window.bookDemo.narration.time)).toBeGreaterThan(before);
  await page.locator('#reset').click();
  await expect.poll(()=>page.evaluate(()=>window.bookDemo.narration.status)).toBe('ready');
  expect(await page.evaluate(()=>window.bookDemo.narration.managed)).toBe(false);
  await page.waitForTimeout(200);
  expect(await page.evaluate(()=>window.bookDemo.narration.time)).toBe(0);
});

test('starting on a selected spread uses its audio offset and stops at ending',async({page})=>{
  const {timeline}=await routedAudio(page);
  await page.goto('http://127.0.0.1:5173');
  await expect.poll(()=>page.evaluate(()=>window.bookDemo?.narration.status)).toBe('ready');
  const state=bookContent.sheets.length-1;
  await page.evaluate(state=>window.bookDemo.goTo(state),state);
  // Jumping ten sheets runs ten page turns, so it needs longer than the 5 s default poll.
  await expect.poll(()=>page.evaluate(()=>window.bookDemo.state.current),{timeout:20000}).toBe(state);
  await page.locator('#play').click();
  await expect.poll(()=>page.evaluate(()=>window.bookDemo.narration.status)).toBe('playing');
  const time=await page.evaluate(()=>window.bookDemo.narration.time);
  expect(time).toBeGreaterThanOrEqual(timeline.stateStarts[state]);
  expect(time).toBeLessThan(timeline.stateStarts[state]+1);
  await expect.poll(()=>page.evaluate(()=>window.bookDemo.narration.status),{timeout:12000}).toBe('ended');
  expect(await page.evaluate(()=>window.bookDemo.narration.time)).toBe(timeline.duration);
  await expect(page.locator('#play')).toHaveAttribute('aria-label','重播故事');
});

test('stale narration is rejected rather than playing incorrect words',async({page})=>{
  await routedAudio(page,timeline=>{timeline.contentKey+='stale';});
  await page.goto('http://127.0.0.1:5173');
  await expect.poll(()=>page.evaluate(()=>window.bookDemo?.narration.status)).toBe('error');
  await page.locator('#play').click();
  await expect(page.locator('#media-status')).toContainText('配音暂不可用');
  expect(await page.evaluate(()=>window.bookDemo.state.autoplay)).toBe(false);
});

test('offline render is identical after nonsequential seeks and hides UI',async({page})=>{
  const {timeline}=testAudio();
  await page.goto('http://127.0.0.1:5173/?export=1');
  await page.evaluate(async()=>{await window.bookDemo.ready;await document.fonts.ready;});
  await page.evaluate(timeline=>window.bookDemo.setExportTimeline(timeline),timeline);
  const midpoint=timeline.segments.find(s=>s.kind==='turn');
  const time=(midpoint.start+midpoint.end)/2;
  await page.evaluate(time=>window.bookDemo.renderAt(time),time);
  const first=await page.screenshot();
  await page.evaluate(duration=>window.bookDemo.renderAt(duration),timeline.duration);
  await page.evaluate(time=>window.bookDemo.renderAt(time),time);
  const second=await page.screenshot();
  expect(first.equals(second)).toBe(true);
  await expect(page.locator('footer')).toBeHidden();
  await expect(page.locator('#export-disclosure')).toHaveText('Test fixture');
});
