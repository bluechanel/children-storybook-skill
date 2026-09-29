import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pageSequence,makeTimeline,validateTimeline,poseAt } from '../skills/children-storybook/scripts/media-core.mjs';
import { prepare,wav,pcmData } from '../skills/children-storybook/scripts/prepare_narration.mjs';
import { exportVideo } from '../skills/children-storybook/scripts/export_video.mjs';
import { bookContent } from '../src/content.js';
const pages=pageSequence(bookContent);
const clips=pages.map((p,i)=>({id:p.id,file:p.id+'.wav',samples:48000+i*137}));

test('sample-accurate timeline keeps left/right narration still and turns silent',()=>{
 const timeline=makeTimeline(bookContent,clips);validateTimeline(timeline,bookContent);
 assert.deepEqual(timeline.segments.filter(s=>s.kind==='narration').map(s=>s.pageId),pages.map(p=>p.id));
 for(const segment of timeline.segments){
  const pose=poseAt(timeline,(segment.start+segment.end)/2);
  if(segment.kind==='narration'){assert.equal(pose.state,segment.state);assert.ok(pose.progress.every(p=>p===0||p===1));assert.equal(segment.samples,clips.find(c=>c.id===segment.pageId).samples);}
  if(segment.kind==='turn'){assert.ok(pose.progress[segment.from]>0&&pose.progress[segment.from]<1);assert.equal(pose.segment.file,undefined);}
 }
 assert.equal(timeline.duration,timeline.totalSamples/48000);
 assert.deepEqual(poseAt(timeline,timeline.duration).progress,bookContent.sheets.map(()=>1));
});
test('absolute-time poses are independent of seek history',()=>{
 const timeline=makeTimeline(bookContent,clips);const turning=timeline.segments.find(s=>s.kind==='turn');
 const t=(turning.start+turning.end)/2, before=poseAt(timeline,t);
 poseAt(timeline,timeline.duration);poseAt(timeline,0);assert.deepEqual(poseAt(timeline,t),before);
});
test('changed story, damaged timing and missing clips are rejected',()=>{
 const timeline=makeTimeline(bookContent,clips), book=structuredClone(bookContent);book.sheets[0].back.text+=' changed';
 assert.throws(()=>validateTimeline(timeline,book),/stale/);
 const damaged=structuredClone(timeline);damaged.segments[1].startSample++;assert.throws(()=>validateTimeline(damaged,bookContent),/boundaries/);
 const wrongStart=structuredClone(timeline);wrongStart.stateStarts[1]=0;assert.throws(()=>validateTimeline(wrongStart,bookContent),/offsets/);
 const wrongTurn=structuredClone(timeline);wrongTurn.segments.find(s=>s.kind==='turn').kind='gap';assert.throws(()=>validateTimeline(wrongTurn,bookContent),/continuity/);
 assert.throws(()=>makeTimeline(bookContent,clips.slice(1)),/Missing/);
 assert.throws(()=>makeTimeline(bookContent,clips,{turn:0}),/Invalid/);
});
test('WAV sample counting and truncated files',()=>{
 const data=wav(4800,true);assert.equal(pcmData(data).length,9600);assert.throws(()=>pcmData(data.subarray(0,100)),/Truncated/);
});
async function isolatedProject(temp) {
 const project=path.join(temp,'project'),story=path.join(project,'stories',bookContent.storyId);
 await fs.mkdir(path.join(project,'src'),{recursive:true});await fs.mkdir(story,{recursive:true});
 await fs.writeFile(path.join(project,'package.json'),JSON.stringify({type:'module'}));
 await fs.writeFile(path.join(project,'src/content.js'),'export const bookContent = '+JSON.stringify(bookContent)+';');
 await fs.writeFile(path.join(story,'manifest.json'),JSON.stringify({id:bookContent.storyId}));
 await fs.writeFile(path.join(story,'narration.js'),'export const narrationConfig = {url:null};');
 return {project,story};
}
test('plan mode performs no fetch, missing configuration fails without cost',async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'book-plan-'));const previousFetch=globalThis.fetch;const saved={};
 // A developer's exported OPENAI_BASE_URL must not leak into the no-network assertion.
 for(const name of ['OPENAI_API_KEY','OPENAI_TTS_API_KEY','OPENAI_BASE_URL','OPENAI_TTS_BASE_URL']){saved[name]=process.env[name];delete process.env[name];}
 globalThis.fetch=()=>{throw new Error('Unexpected network request');};
 try{
  const {project,story}=await isolatedProject(temp);
  await prepare({project,plan:true});
  const plan=JSON.parse(await fs.readFile(path.join(story,'audio/requests.json')));assert.equal(plan.requests.length,pages.length);assert.equal(plan.status,'planned');assert.equal(plan.provider,'openai-compatible');
  await assert.rejects(prepare({project,generate:true}),/not configured/);
  await assert.rejects(prepare({project,fixture:true,install:true}),/cannot be installed/);
  await assert.rejects(prepare({project,output:temp,plan:true}),/inside/);
 }finally{globalThis.fetch=previousFetch;for(const [name,value] of Object.entries(saved)){if(value===undefined)delete process.env[name];else process.env[name]=value;}await fs.rm(temp,{recursive:true,force:true});}
});
test('mocked TTS cache and installation stay inside one story; export rejects outside paths',async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'book-tts-'));const originalFetch=globalThis.fetch,saved={};let requests=0;
 const testBase='http://127.0.0.1:9999/v1';
 for(const name of ['OPENAI_API_KEY','OPENAI_TTS_API_KEY','OPENAI_BASE_URL','OPENAI_TTS_BASE_URL']){saved[name]=process.env[name];delete process.env[name];}
 process.env.OPENAI_TTS_BASE_URL=testBase;
 process.env.OPENAI_API_KEY='unit-test-key-not-a-real-secret';
 globalThis.fetch=async(url,opts)=>{
  // /v1/voices is optional (the official API has none); 404 means "no preset fingerprint",
  // so the cache falls back to the request hash alone. It must not count as a speech call.
  if(String(url).endsWith('/voices'))return new Response('nope',{status:404});
  requests++;assert.equal(url,`${testBase}/audio/speech`);assert.equal(opts.headers.Authorization,`Bearer ${process.env.OPENAI_API_KEY}`);const body=JSON.parse(opts.body);assert.equal(body.response_format,'wav');assert.ok(body.input);assert.ok(body.model);return new Response(wav(4800,true),{status:200,headers:{'Content-Type':'audio/wav'}});};
 try{
  const {project,story}=await isolatedProject(temp);
  const first=await prepare({project,generate:true,name:'first'});
  assert.equal(requests,pages.length);assert.ok(first.timeline.clips.every(c=>c.samples===4800));
  assert.equal(first.destination,path.join(story,'audio/first'));
  assert.equal(first.timeline.tts.provider,'openai-compatible');
  assert.equal(first.timeline.tts.endpoint,testBase);
  await prepare({project,generate:true,name:'cached'});assert.equal(requests,pages.length);
  const output=await fs.readFile(path.join(first.destination,'timeline.json'),'utf8');assert.ok(!output.includes(process.env.OPENAI_API_KEY));
  const planned=await fs.readFile(path.join(first.destination,'requests.json'),'utf8');assert.ok(!planned.includes(process.env.OPENAI_API_KEY));assert.ok(planned.includes(testBase));
  const installed=await prepare({project,generate:true,name:'installed',install:true});
  assert.equal(requests,pages.length);
  const narration=await fs.readFile(path.join(story,'narration.js'),'utf8');
  assert.ok(narration.includes(`/stories/${bookContent.storyId}/audio/installed/timeline.json`));assert.ok(!narration.includes(process.env.OPENAI_API_KEY));
  assert.ok((await fs.readFile(path.join(story,'backups/narration-before-installed.js'),'utf8')).includes('url:null'));
  assert.equal(JSON.parse(await fs.readFile(path.join(installed.destination,'timeline.json'))).mode,'ready');
  await assert.rejects(fs.access(path.join(project,'public/narration')));
  await assert.rejects(prepare({project,generate:true,name:'installed',install:true}),/Output exists/);
  await assert.rejects(exportVideo({project,timeline:path.join(first.destination,'timeline.json'),output:path.join(temp,'outside.mp4')}),/inside/);
  const fixture=await prepare({project,fixture:true,name:'fixture'});
  await assert.rejects(exportVideo({project,timeline:path.join(fixture.destination,'timeline.json')}),/Test tones/);
 }finally{globalThis.fetch=originalFetch;for(const [name,value] of Object.entries(saved)){if(value===undefined)delete process.env[name];else process.env[name]=value;}await fs.rm(temp,{recursive:true,force:true});}
});
test('speech speed outside 0.25–4 is rejected before any request',async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'book-speed-'));const originalFetch=globalThis.fetch,saved={};
 for(const name of ['OPENAI_API_KEY','OPENAI_TTS_API_KEY','OPENAI_BASE_URL','OPENAI_TTS_BASE_URL','OPENAI_TTS_SPEED']){saved[name]=process.env[name];delete process.env[name];}
 process.env.OPENAI_API_KEY='unit-test-key-not-a-real-secret';process.env.OPENAI_TTS_SPEED='5';
 globalThis.fetch=()=>{throw new Error('Unexpected network request');};
 try{
  const {project}=await isolatedProject(temp);
  await assert.rejects(prepare({project,generate:true}),/0\.25–4/);
 }finally{globalThis.fetch=originalFetch;for(const [name,value] of Object.entries(saved)){if(value===undefined)delete process.env[name];else process.env[name]=value;}await fs.rm(temp,{recursive:true,force:true});}
});
