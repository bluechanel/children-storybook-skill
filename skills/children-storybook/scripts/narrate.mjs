#!/usr/bin/env node
// One-shot narration helper: environment check → TTS generation → clip summary → optional install/MP4.
// Wraps prepare_narration.mjs and export_video.mjs; adds nothing to their output contracts.
//
//   node skills/children-storybook/scripts/narrate.mjs --check                  # probe the configured endpoint, no generation
//   node skills/children-storybook/scripts/narrate.mjs --name red-audio-v1      # generate every page
//   node skills/children-storybook/scripts/narrate.mjs --name v2 --voice narrator --speed 0.9
//   node skills/children-storybook/scripts/narrate.mjs --name v2 --install --video
//   node skills/children-storybook/scripts/narrate.mjs --name v3 --refresh-page page-14   # request one page again
//   node skills/children-storybook/scripts/narrate.mjs --name v3 --disclosure "AI narration (ElevenLabs)"
//
// There is one TTS interface — the OpenAI speech API. A local MOSS-TTS server (the separate
// moss-tts project) speaks the same contract; point OPENAI_TTS_BASE_URL at it.
// See references/narration-video.md.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepare, resolveTts } from './prepare_narration.mjs';
import { exportVideo } from './export_video.mjs';
import { resolveProject, loadEnvLocal, isMain } from './project.mjs';

const BOOLEAN_FLAGS=['check','install','video','plan','allow-test-audio','allow-fallback-voice'];
const REPEATABLE_FLAGS=['page-seed','refresh-page'];
export function parseArgs(args){
  const result={};
  for(let i=0;i<args.length;i++){
    if(!args[i].startsWith('--'))throw new Error(`Unexpected argument: ${args[i]}`);
    const key=args[i].slice(2);
    if(BOOLEAN_FLAGS.includes(key))result[key]=true;
    else{
      if(!args[i+1]||args[i+1].startsWith('--'))throw new Error(`Missing value: ${key}`);
      const value=args[++i];
      if(REPEATABLE_FLAGS.includes(key))(result[key]||=[]).push(value);
      else result[key]=value;
    }
  }
  return result;
}

// Probe the endpoint with the standard OpenAI routes only. /v1/voices is a bonus that a
// MOSS-TTS server provides and the official API does not, so its absence is never an error.
// /health is deliberately not used: the official host has no such route and this skill must
// work against any OpenAI-compatible endpoint.
export async function checkTts(options={}){
  const tts=resolveTts();
  const problems=[],warnings=[];
  const status={base:tts.base,source:tts.source,key:Boolean(tts.key),reachable:false,models:null,voices:null,zeroConfig:null,voice:process.env.OPENAI_TTS_VOICE||'marin',fingerprint:null,refAudio:null,refAudioOk:null,ffmpeg:null};
  const headers=tts.key?{Authorization:`Bearer ${tts.key}`}:{};
  try{
    const response=await fetch(tts.models,{headers,signal:AbortSignal.timeout(5000)});
    status.reachable=true;
    if(response.ok){const body=await response.json().catch(()=>null);status.models=(body?.data||[]).map(model=>model?.id).filter(Boolean);}
    else if(response.status===401||response.status===403)problems.push(`The endpoint rejected the credential (HTTP ${response.status}) at ${tts.models}.`);
    else if([404,405,501].includes(response.status))warnings.push(`GET ${tts.models} is unsupported (HTTP ${response.status}); speech capability is unverified until generation.`);
    else problems.push(`GET ${tts.models} returned HTTP ${response.status}.`);
  }catch(error){
    problems.push(`Could not reach ${tts.models}: ${error.message}. Is the endpoint running?`);
  }
  if(status.reachable){
    try{
      const response=await fetch(tts.voices,{headers,signal:AbortSignal.timeout(5000)});
      if(response.ok){
        const body=await response.json().catch(()=>null);
        status.voices=(body?.data||[]).map(voice=>voice?.id).filter(Boolean);
        status.zeroConfig=body?.zero_config??null;
        const preset=(body?.data||[]).find(voice=>voice?.id===status.voice);
        status.fingerprint=preset?.fingerprint||null;
        // A preset that names a reference WAV the server could not open silently falls back
        // to the base voice. That is a capability downgrade, not a detail: report it loudly
        // rather than printing a fingerprint and a check mark.
        status.refAudio=preset?.ref_audio??null;
        status.refAudioOk=preset&&'ref_audio_ok' in preset?Boolean(preset.ref_audio_ok):null;
      }
    }catch{/* optional route; ignore */}
  }
  if(!status.key)problems.push('No credential: set OPENAI_TTS_API_KEY (or OPENAI_API_KEY) in .env.local.');
  // A preset that declares a reference WAV and reports it is not using it will synthesize
  // every clip in the base voice while the run looks successful, so this stops the run unless
  // the user says the fallback is acceptable. A preset with no reference audio at all (a
  // zero-config `default`) reports ref_audio_ok: false too, and is not a downgrade.
  if(status.refAudio&&status.refAudioOk===false&&!options.allowFallbackVoice){
    problems.push(`The endpoint reports ref_audio_ok: false for voice "${status.voice}" (ref_audio: ${status.refAudio}); it fell back to its base voice, so the clips would not be the voice you asked for. Fix the endpoint's voice configuration, or rerun with --allow-fallback-voice to accept the fallback.`);
  }
  const ff=spawnSync(process.env.FFMPEG_PATH||'ffmpeg',['-version'],{encoding:'utf8'});
  status.ffmpeg=ff.status===0?ff.stdout.split('\n')[0]:null;
  if(ff.status!==0)problems.push('ffmpeg not found (needed for MP4 export and for normalizing non-48 kHz TTS responses). Install ffmpeg or set FFMPEG_PATH');
  return {ok:problems.length===0,problems,warnings,status};
}

function printCheck(result){
  const {status,problems,warnings=[]}=result;
  const mark=value=>value?'✔':'✖';
  console.log(`${mark(status.reachable)} endpoint   ${status.base}   (from ${status.source})`);
  console.log(`${mark(status.key)} key        ${status.key?'set':'(not set)'}`);
  console.log(`${mark(status.models?.length)} models     ${status.models?.length?status.models.join(', '):'(none reported)'}`);
  console.log(`${mark(status.voices?.length)} voices     ${status.voices?.length?status.voices.join(', '):'(optional voice metadata unavailable)'}`);
  if(status.voice&&status.fingerprint)console.log(`${mark(true)} fingerprint ${status.voice} → ${status.fingerprint}`);
  if(status.refAudio){
    const fallback=status.refAudioOk===false?'   (ref_audio_ok: false — the server fell back to its base voice)':'';
    console.log(`${mark(status.refAudioOk!==false)} reference  ${status.voice} → ${status.refAudio}${fallback}`);
  }
  console.log(`${mark(status.ffmpeg)} ffmpeg     ${status.ffmpeg||'(not found)'}`);
  for(const problem of problems)console.log(`  ! ${problem}`);
  for(const warning of warnings)console.log(`  ? ${warning}`);
  console.log(result.ok?'Preflight passed; speech output still requires generation and listening.':'Preflight failed.');
}

function slugFromDate(prefix){const d=new Date(),p=n=>String(n).padStart(2,'0');return `${prefix}-${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;}

export async function narrate(options){
  const project=resolveProject(options.project);
  loadEnvLocal(project);
  // CLI overrides flow to prepare_narration.mjs through the same env vars .env.local uses.
  // Standard speech fields are the default; seed is an explicit optional extension.
  if(options.voice)process.env.OPENAI_TTS_VOICE=options.voice;
  if(options.speed!==undefined)process.env.OPENAI_TTS_SPEED=String(options.speed);
  if(options.model)process.env.OPENAI_TTS_MODEL=options.model;
  if(options.disclosure)process.env.OPENAI_TTS_DISCLOSURE=options.disclosure;

  if(options.plan&&(options.check||options.install||options.video))throw new Error('--plan cannot be combined with --check, --install or --video.');
  if(options.plan){await prepare({project,story:options.story,plan:true,seed:options.seed,'page-seed':options['page-seed'],'refresh-page':options['refresh-page'],disclosure:options.disclosure});return {planned:true};}

  const check=await checkTts({allowFallbackVoice:Boolean(options['allow-fallback-voice'])});
  if(options.check){printCheck(check);return {ok:check.ok,check};}
  if(!check.ok){printCheck(check);throw new Error('Fix the items above, then rerun. Nothing was generated.');}

  const name=options.name||slugFromDate('audio');
  const started=Date.now();
  const {destination,timeline}=await prepare({project,story:options.story,generate:true,name,install:Boolean(options.install),seed:options.seed,'page-seed':options['page-seed'],'refresh-page':options['refresh-page'],disclosure:options.disclosure});
  const rel=path.relative(project,destination);
  console.log('\nClips (listen to every one before delivering):');
  for(const segment of timeline.segments.filter(s=>s.kind==='narration')){
    const seconds=(segment.samples/timeline.sampleRate).toFixed(2).padStart(6);
    const gain=timeline.clips?.find(clip=>clip.id===segment.pageId)?.gainDb;
    console.log(`  ${segment.pageId.padEnd(8)} ${seconds}s${gain?`  level ${gain>0?'+':''}${gain} dB`:''}  ${rel}/${segment.file}\n           "${segment.text}"`);
  }
  console.log(`\nTotal ${timeline.duration.toFixed(2)}s including page turns · generated in ${((Date.now()-started)/1000).toFixed(0)}s · endpoint ${timeline.tts?.endpoint||check.status.base}`);
  // Level matching is what stops one page sitting under its neighbours; say so, and say what
  // the exported video will claim about the voice, since that leaves the machine.
  if(timeline.loudness?.enabled)console.log(`Levels matched to ${timeline.loudness.targetRmsDb} dBFS RMS (peak ceiling ${timeline.loudness.peakCeilingDb} dBFS).`);
  console.log(`Disclosure for the exported video: "${timeline.disclosure}"`);
  console.log(options.install?`Installed: stories/<id>/narration.js now points at ${rel}/timeline.json`:`Not installed. To use in the app: rerun with --install, or edit stories/<id>/narration.js`);
  let video=null;
  if(options.video){
    video=await exportVideo({project,story:options.story,timeline:path.join(destination,'timeline.json'),output:options.output,'publish-copy':options['publish-copy']});
    console.log(`Video: ${path.relative(project,video.output)} (${video.videoDuration.toFixed(2)}s, ${video.frames} frames)`);
  }
  return {destination,timeline,video};
}

if(isMain(import.meta.url)){
  narrate(parseArgs(process.argv.slice(2))).then(r=>{if(r&&r.ok===false)process.exitCode=1;}).catch(error=>{console.error(error.message);process.exitCode=1;});
}
