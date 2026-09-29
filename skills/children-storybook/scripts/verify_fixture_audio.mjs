#!/usr/bin/env node
// Checks only deliberate tone fixtures; not a speech recognition or quality evaluator.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { storyPaths, inside } from './story-paths.mjs';
import { resolveProject, loadEnvLocal, resolveBook } from './project.mjs';
import { spawnSync } from 'node:child_process';
const args=process.argv.slice(2), options={};
for(let i=0;i<args.length;i+=2)options[args[i].replace(/^--/,'')]=args[i+1];
try {
  if(!options.video||!options.timeline)throw new Error('Supply --video and --timeline.');
  const project=resolveProject(options.project);
  loadEnvLocal(project);
  const story=storyPaths(project,await resolveBook(project,options.story));
  inside(story.audio,path.resolve(options.timeline));
  inside(story.video,path.resolve(options.video));
  const qa=inside(story.root,path.join(story.root,'qa'));await fs.mkdir(qa,{recursive:true});
  options.report=inside(qa,path.resolve(options.report||path.join(qa,path.basename(options.video)+'-audio-check.json')));
  const timeline=JSON.parse(await fs.readFile(options.timeline,'utf8'));
  if(timeline.mode!=='fixture')throw new Error('This checker is only for test tones, not real narration.');
  const result=spawnSync(process.env.FFMPEG_PATH||'ffmpeg',['-v','error','-i',options.video,'-vn','-ac','1','-ar','48000','-f','s16le','pipe:1'],{maxBuffer:Math.ceil(timeline.duration+5)*96000});
  if(result.error||result.status!==0)throw new Error('Unable to decode video audio.');
  const pcm=result.stdout;
  if(pcm.length<timeline.totalSamples*2)throw new Error('Video audio is shorter than the timeline.');
  const checks=timeline.segments.map(segment=>{
    const trim=Math.min(1200,Math.floor(segment.samples/4));let power=0,count=0;
    for(let i=segment.startSample+trim;i<segment.startSample+segment.samples-trim;i++){power+=pcm.readInt16LE(i*2)**2;count++;}
    const rms=Math.sqrt(power/count);
    return {kind:segment.kind,pageId:segment.pageId,start:segment.start,end:segment.end,rms,passed:segment.kind==='narration'?rms>500:rms<50};
  });
  const report={scope:'Encoded test tones align with narration slots; gaps and turns are silent. Not a spoken-English test.',passed:checks.every(c=>c.passed),checks};
  if(options.report)await fs.writeFile(options.report,JSON.stringify(report,null,2));
  if(!report.passed)throw new Error('One or more tone/silence intervals are out of sync.');
  console.log(`${checks.length} encoded audio intervals verified.`);
}catch(error){console.error(error.message);process.exitCode=1;}
