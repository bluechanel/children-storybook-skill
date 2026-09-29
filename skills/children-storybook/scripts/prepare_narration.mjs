#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { storyPaths, inside, storyUrl } from './story-paths.mjs';
import { pageSequence, makeTimeline, validateTimeline, DEFAULT_DISCLOSURE } from './media-core.mjs';
// Self-load .env.local so a directly invoked script works from any directory, not only
// through the npm scripts that pass --env-file-if-exists.
import { resolveProject, loadEnvLocal, resolveBook, isMain } from './project.mjs';

// The disclosure burned into the exported video, the MP4 metadata and the export report.
// It must say what the audio *is* — the reader's in-app badge says 配音, and a file that
// leaves the machine has to carry the same fact, not a brand name. Override with
// --disclosure or OPENAI_TTS_DISCLOSURE when a publisher requires specific wording.
// The default lives in media-core.mjs because the reader's export footer falls back to it too.
export { DEFAULT_DISCLOSURE };
// Fixture audio is test tones, so its label is not configurable: it exists to stop tones
// being passed off as a narrated story.
export const FIXTURE_DISCLOSURE = 'Timing test · tones, not narration';
// Loudness matching. Every clip is generated independently, so nothing makes them arrive at
// the same level: a page 6 dB under its neighbours is a property of this pipeline, not bad
// luck. Clips are measured and scaled toward one speech level before assembly.
export const LOUDNESS = Object.freeze({ targetRms: 0.1, peakCeiling: 0.891, gate: 0.00316, minGainDb: -12, maxGainDb: 12 });
const REPEATABLE = new Set(['page-seed']);

export function parseArgs(args) {
  const result={};
  for(let i=0;i<args.length;i++){
    if(!args[i].startsWith('--'))throw new Error(`Unexpected argument: ${args[i]}`);
    const key=args[i].slice(2);
    if(['plan','generate','fixture','install','no-normalize'].includes(key))result[key]=true;
    else {
      if(!args[i+1]||args[i+1].startsWith('--'))throw new Error(`Missing value: ${key}`);
      const value=args[++i];
      if(REPEATABLE.has(key))(result[key]||=[]).push(value);
      else result[key]=value;
    }
  }
  return result;
}
export function wav(samples, tone=false, frequency=440) {
  const data=Buffer.alloc(44+samples*2);
  data.write('RIFF',0);data.writeUInt32LE(36+samples*2,4);data.write('WAVEfmt ',8);data.writeUInt32LE(16,16);data.writeUInt16LE(1,20);data.writeUInt16LE(1,22);data.writeUInt32LE(48000,24);data.writeUInt32LE(96000,28);data.writeUInt16LE(2,32);data.writeUInt16LE(16,34);data.write('data',36);data.writeUInt32LE(samples*2,40);
  if(tone) for(let i=0;i<samples;i++)data.writeInt16LE(Math.round(3500*Math.sin(2*Math.PI*frequency*i/48000)*Math.min(1,i/240,(samples-i)/240)),44+i*2);
  return data;
}
function run(command,args){const r=spawnSync(command,args,{encoding:'utf8',maxBuffer:2e6});if(r.error)throw new Error(`${command} unavailable: ${r.error.message}`);if(r.status)throw new Error(`${command} failed: ${r.stderr.slice(-1600)}`);return r.stdout;}
export function pcmData(bytes){
  if(bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE')throw new Error('Invalid WAV');
  let format=false;
  for(let i=12;i+8<=bytes.length;){
    const type=bytes.toString('ascii',i,i+4), size=bytes.readUInt32LE(i+4), start=i+8;
    if(start+size>bytes.length)throw new Error('Truncated WAV');
    if(type==='fmt ')format=bytes.readUInt16LE(start)===1&&bytes.readUInt16LE(start+2)===1&&bytes.readUInt32LE(start+4)===48000&&bytes.readUInt16LE(start+14)===16;
    if(type==='data'){if(!format||size%2||!size)throw new Error('Expected 48kHz mono PCM16');return bytes.subarray(start,start+size);}
    i=start+size+(size%2);
  }
  throw new Error('WAV has no data');
}
// Speech level over the samples that actually carry speech: measuring a clip that is half
// silence over all of it would boost the silence rather than the words.
export function measureLevel(pcm){
  let peak=0,sum=0,count=0;
  for(let i=0;i+1<pcm.length;i+=2){
    const value=pcm.readInt16LE(i)/32768, magnitude=Math.abs(value);
    if(magnitude>peak)peak=magnitude;
    if(magnitude>=LOUDNESS.gate){sum+=value*value;count++;}
  }
  const rms=count?Math.sqrt(sum/count):0;
  return {peak,rms,rmsDb:rms?20*Math.log10(rms):-Infinity,peakDb:peak?20*Math.log10(peak):-Infinity};
}
// One gain per clip: toward the target level, never so far that the peak clips, and never
// past ±12 dB — a clip that far out is a broken generation, not a level to correct.
export function levelGain(level){
  if(!(level.rms>0))return 1;
  let gain=LOUDNESS.targetRms/level.rms;
  if(level.peak>0)gain=Math.min(gain,LOUDNESS.peakCeiling/level.peak);
  return Math.min(Math.max(gain,10**(LOUDNESS.minGainDb/20)),10**(LOUDNESS.maxGainDb/20));
}
export function applyGain(bytes,gain){
  const output=Buffer.from(bytes);
  const pcm=pcmData(output);
  for(let i=0;i+1<pcm.length;i+=2){
    const scaled=Math.round(pcm.readInt16LE(i)*gain);
    pcm.writeInt16LE(scaled>32767?32767:scaled<-32768?-32768:scaled,i);
  }
  return output;
}
// Trim and flatten a disclosure: it is burned into one video footer line and into the MP4
// comment, so a newline or a runaway paste would corrupt the export.
export function resolveDisclosure(value){
  const text=String(value??'').replace(/\s+/g,' ').trim();
  if(!text)throw new Error('The disclosure must not be empty.');
  if(text.length>120)throw new Error(`The disclosure must be 120 characters or fewer (got ${text.length}).`);
  return text;
}
// Narration talks to exactly one interface: the OpenAI speech API. A local MOSS-TTS server
// (the separate moss-tts project) speaks that same contract, so it is reached by pointing
// OPENAI_TTS_BASE_URL at it — this skill knows nothing about MLX, model paths or voice presets.
// OPENAI_BASE_URL is only a fallback: gen_art.py uses it for the Images API, so repointing it
// would silently redirect image generation too.
const DEFAULT_TTS_BASE='https://api.openai.com/v1';
export function resolveTts(){
  const explicit=process.env.OPENAI_TTS_BASE_URL, inherited=process.env.OPENAI_BASE_URL;
  const raw=String(explicit||inherited||DEFAULT_TTS_BASE).trim();
  let url;try{url=new URL(raw);}catch{throw new Error(`TTS base URL is not a valid URL: ${raw}`);}
  if(url.protocol!=='http:'&&url.protocol!=='https:')throw new Error(`TTS base URL must be http(s): ${raw}`);
  let base=raw.replace(/\/+$/,'');
  if(url.pathname===''||url.pathname==='/')base=`${base}/v1`;
  return {
    base,endpoint:`${base}/audio/speech`,models:`${base}/models`,voices:`${base}/voices`,
    key:process.env.OPENAI_TTS_API_KEY||process.env.OPENAI_API_KEY||'',
    source:explicit?'OPENAI_TTS_BASE_URL':inherited?'OPENAI_BASE_URL':'default',
  };
}
// Best-effort: the official API has no /v1/voices route, so any failure simply means "no
// fingerprint" and the cache falls back to the request hash alone.
export async function voiceFingerprint(tts,voice){
  if(!voice)return null;
  try{
    const response=await fetch(tts.voices,{headers:tts.key?{Authorization:`Bearer ${tts.key}`}:{},signal:AbortSignal.timeout(3000)});
    if(!response.ok)return null;
    const body=await response.json();
    const match=(body?.data||[]).find(entry=>entry?.id===voice);
    return typeof match?.fingerprint==='string'&&match.fingerprint?match.fingerprint:null;
  }catch{return null;}
}
// A request-level seed is the supported way to re-record one page. The server's preset seed
// cannot do it: it is part of the preset fingerprint, so changing it invalidates all of the
// clips at once, and deleting a cache file re-runs a deterministic server into the same bytes.
export function pageSeeds(options,pages){
  const ids=new Set(pages.map(page=>page.id));
  const perPage=new Map();
  const fallback=options.seed===undefined||options.seed===''?null:parseSeed(options.seed,'--seed');
  for(const entry of [].concat(options['page-seed']||[])){
    const match=/^([^=]+)=(.+)$/.exec(String(entry).trim());
    if(!match)throw new Error(`--page-seed must look like <page-id>=<seed>, got "${entry}".`);
    const id=match[1].trim();
    if(!ids.has(id))throw new Error(`--page-seed names no page in this book: "${id}". Pages are: ${[...ids].join(', ')}.`);
    perPage.set(id,parseSeed(match[2].trim(),`--page-seed ${id}`));
  }
  return {fallback,perPage};
}
function parseSeed(value,label){
  const seed=Number(value);
  if(!Number.isInteger(seed)||seed<0||seed>2147483647)throw new Error(`${label} must be a whole number between 0 and 2147483647.`);
  return seed;
}
export async function prepare(options) {
  const project=resolveProject(options.project);
  loadEnvLocal(project);
  const mode=options.fixture?'fixture':options.generate?'tts':'plan';
  if([options.plan,options.fixture,options.generate].filter(Boolean).length>1)throw new Error('Choose exactly one mode: plan, generate or fixture.');
  if(options.fixture&&options.install)throw new Error('Fixture audio cannot be installed as narration.');
  if(mode==='plan'&&options.install)throw new Error('Generate real audio before installing.');
  const book=await resolveBook(project,options.story);
  const story=storyPaths(project,book);
  const pages=pageSequence(book);
  const tts=resolveTts();
  const config={model:process.env.OPENAI_TTS_MODEL||'gpt-4o-mini-tts',voice:process.env.OPENAI_TTS_VOICE||'marin',speed:Number(process.env.OPENAI_TTS_SPEED||'0.9'),instructions:process.env.OPENAI_TTS_INSTRUCTIONS||'Read the exact English text warmly and clearly for children aged four to seven. Use a gentle storytelling voice with natural short pauses. Do not add or omit words.'};
  if(!Number.isFinite(config.speed)||config.speed<0.25||config.speed>4)throw new Error('OPENAI_TTS_SPEED must be 0.25–4.');
  const normalize=!options['no-normalize']&&process.env.OPENAI_TTS_NORMALIZE!=='0';
  const disclosure=resolveDisclosure(options.disclosure??process.env.OPENAI_TTS_DISCLOSURE??DEFAULT_DISCLOSURE);
  const seeds=pageSeeds(options,pages);
  // The body stays exactly the OpenAI schema. A local MOSS-TTS server accepts extra tuning
  // fields, but this pipeline deliberately sends none unless asked: it must work against any
  // OpenAI-compatible endpoint, and the voice preset carries the tuning instead. An explicit
  // seed is the one exception — it is how a single page is re-recorded, because the body is
  // what the cache hashes, so seeding one page invalidates that page and nothing else.
  const requests=pages.map(page=>{
    if(page.text.length>4096)throw new Error(`${page.id} exceeds TTS input limit.`);
    const body={model:config.model,voice:config.voice,input:page.text,response_format:'wav',speed:config.speed};
    if(!['tts-1','tts-1-hd'].includes(config.model))body.instructions=config.instructions;
    const seed=seeds.perPage.has(page.id)?seeds.perPage.get(page.id):seeds.fallback;
    if(seed!==null)body.seed=seed;
    return {id:page.id,body,hash:crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex')};
  });
  const seedRecord={fallback:seeds.fallback,perPage:Object.fromEntries(seeds.perPage)};
  await fs.mkdir(story.audio,{recursive:true});
  const output=inside(story.audio,path.resolve(options.output||story.audio));
  if(output!==story.audio)throw new Error('Audio output must use the active story audio/ directory.');
  // A --plan run never inspects credentials or makes network requests.
  if(mode==='plan'){
    await fs.mkdir(output,{recursive:true});
    await fs.writeFile(path.join(output,'requests.json'),JSON.stringify({status:'planned',provider:'openai-compatible',endpoint:tts.base,...config,presetFingerprint:null,seeds:seedRecord,disclosure,requests},null,2));
    console.log(`Planned ${requests.length} clips for ${tts.endpoint}. No API calls. Configure .env.local, then run narration:generate.`);
    return {status:'planned'};
  }
  if(mode==='tts'&&!tts.key)throw new Error('OPENAI_TTS_API_KEY (or OPENAI_API_KEY) is not configured. Set it in .env.local (never VITE_*). No API requests made.');
  const stamp=options.name||`narration-${Date.now()}`;
  if(!/^[a-z0-9-]+$/.test(stamp))throw new Error('--name must be a lowercase slug.');
  const destination=path.join(output,stamp);
  try{await fs.access(destination);throw new Error(`Output exists: ${destination}. Choose a new --name — the clips are content-addressed, so a new name reuses every clip that has not changed and costs nothing for those.`);}catch(e){if(e.code!=='ENOENT')throw e;}
  await fs.mkdir(output,{recursive:true});
  const staging=await fs.mkdtemp(path.join(output,'.audio-'));
  const cache=path.join(output,'.cache');await fs.mkdir(cache,{recursive:true});
  // The request body carries only the voice *name*, so a preset edited in place would
  // otherwise reuse stale clips. Folding the server's preset fingerprint into the cache
  // FILENAME (never the body) makes any change to what actually drives synthesis — including
  // swapping the reference WAV — produce a cache miss.
  const presetFingerprint=mode==='tts'?await voiceFingerprint(tts,config.voice):null;
  const cachePath=request=>path.join(cache,`${request.hash}${presetFingerprint?`.${presetFingerprint}`:''}.wav`);
  try{
    const clips=[],levels=[];
    for(let i=0;i<requests.length;i++){
      const request=requests[i], file=`${request.id}.wav`, dest=path.join(staging,file);
      let gainDb=0;
      if(mode==='fixture')await fs.writeFile(dest,wav(Math.round(48000*(0.35+i*0.04)),true,330+i*110));
      else {
        const cached=cachePath(request);
        let bytes;
        try{bytes=await fs.readFile(cached);pcmData(bytes);}catch{
          console.log(`Generating ${request.id}…`);
          // No key in the URL, browser code, logs or saved metadata.
          let response;
          try{response=await fetch(tts.endpoint,{method:'POST',headers:{Authorization:`Bearer ${tts.key}`,'Content-Type':'application/json'},body:JSON.stringify(request.body),signal:AbortSignal.timeout(120000)});}
          catch(error){throw new Error(`Could not reach ${tts.endpoint}: ${error.message}. Run --check to diagnose.`);}
          if(!response.ok)throw new Error(`TTS request failed (${response.status}) for ${request.id}. Rerun explicitly; completed clips remain cached.`);
          const returned=Buffer.from(await response.arrayBuffer());
          // A local OpenAI-compatible server already returns 48 kHz mono PCM16, so skip the
          // ffmpeg pass when the response is usable as-is. The official API returns 24 kHz and
          // is normalized here instead.
          try{pcmData(returned);await fs.writeFile(dest,returned);}
          catch{
            const original=path.join(staging,'response.wav');await fs.writeFile(original,returned);
            run(process.env.FFMPEG_PATH||'ffmpeg',['-v','error','-y','-i',original,'-ar','48000','-ac','1','-c:a','pcm_s16le',dest]);
            await fs.unlink(original);
          }
          bytes=await fs.readFile(dest);pcmData(bytes);
          // The cache keeps the endpoint's own bytes, before the level pass below, so
          // retargeting the loudness never invalidates a cached clip.
          await fs.writeFile(cached,bytes);
        }
        const level=measureLevel(pcmData(bytes));
        const gain=normalize?levelGain(level):1;
        const matched=gain===1?bytes:applyGain(bytes,gain);
        await fs.writeFile(dest,matched);
        gainDb=Number((20*Math.log10(gain)).toFixed(2));
        levels.push({id:request.id,gainDb,rmsDb:Number(level.rmsDb.toFixed(2)),peakDb:Number(level.peakDb.toFixed(2))});
      }
      const pcm=pcmData(await fs.readFile(dest));clips.push({id:request.id,file,samples:pcm.length/2,sha256:crypto.createHash('sha256').update(await fs.readFile(dest)).digest('hex'),requestHash:request.hash,gainDb});
    }
    const timeline=makeTimeline(book,clips);
    const real=mode!=='fixture';
    const targetRmsDb=Number((20*Math.log10(LOUDNESS.targetRms)).toFixed(2)), peakCeilingDb=Number((20*Math.log10(LOUDNESS.peakCeiling)).toFixed(2));
    Object.assign(timeline,{mode:real?'ready':'fixture',audioFile:'master.wav',audioUrl:storyUrl(story,path.join(destination,'master.wav')),disclosure:real?disclosure:FIXTURE_DISCLOSURE,loudness:{enabled:real&&normalize,targetRmsDb,peakCeilingDb,clips:levels},tts:real?{provider:'openai-compatible',endpoint:tts.base,...config,presetFingerprint,seeds:seedRecord}:null,clips});
    validateTimeline(timeline,book);
    const master=wav(timeline.totalSamples);let offset=44;
    for(const segment of timeline.segments){if(segment.kind==='narration')pcmData(await fs.readFile(path.join(staging,segment.file))).copy(master,offset);offset+=segment.samples*2;}
    timeline.audioSha256=crypto.createHash('sha256').update(master).digest('hex');
    await fs.writeFile(path.join(staging,'master.wav'),master);
    await fs.writeFile(path.join(staging,'timeline.json'),JSON.stringify(timeline,null,2));
    await fs.writeFile(path.join(staging,'requests.json'),JSON.stringify({provider:'openai-compatible',endpoint:tts.base,...config,presetFingerprint,seeds:seedRecord,disclosure,loudness:timeline.loudness,requests},null,2));
    await fs.rename(staging,destination);
    if(options.install){
      const configFile=path.join(story.root,'narration.js');
      await fs.mkdir(story.backups,{recursive:true});
      try{await fs.copyFile(configFile,path.join(story.backups,`narration-before-${stamp}.js`),1);}catch(e){if(e.code!=='ENOENT')throw e;}
      const tmp=configFile+'.tmp';await fs.writeFile(tmp,`export const narrationConfig = ${JSON.stringify({url:storyUrl(story,path.join(destination,'timeline.json'))})};\n`);await fs.rename(tmp,configFile);
    }
    console.log(`${mode==='fixture'?'TEST TONES ONLY':`Narration ready (${tts.endpoint})`}: ${destination} (${timeline.duration.toFixed(2)}s)`);
    return {destination,timeline};
  }finally{await fs.rm(staging,{recursive:true,force:true});}
}
if(isMain(import.meta.url)){prepare(parseArgs(process.argv.slice(2))).catch(error=>{console.error(error.message);process.exitCode=1;});}
