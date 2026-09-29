#!/usr/bin/env node
// Render the narrated book to MP4.
//
// Needs node, ffmpeg/ffprobe and a Chromium-based browser — no npm install. The reader is
// a prebuilt bundle served by a plain node:http server, and frames are captured over the
// DevTools Protocol by cdp.mjs, which mirrors Playwright's flags and screenshot call so the
// output matches what Playwright produced before.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { storyPaths, inside } from './story-paths.mjs';
import { resolveProject, loadEnvLocal, resolveBook, isMain } from './project.mjs';
import { serveStory } from './static-server.mjs';
import { openBrowser, pngSize } from './cdp.mjs';
import { validateTimeline } from './media-core.mjs';
import { pcmData } from './prepare_narration.mjs';

async function waitFor(page, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const errors = page.errors;
  throw new Error(`Timed out waiting for ${label}.${errors.length ? `\nPage reported:\n  ${errors.join('\n  ')}` : ''}`);
}

export async function exportVideo(options) {
  const project=resolveProject(options.project);
  loadEnvLocal(project);
  if(!options.timeline)throw new Error('Supply --timeline /path/to/timeline.json. Generate narration first.');
  const timelinePath=path.resolve(options.timeline), timeline=JSON.parse(await fs.readFile(timelinePath,'utf8'));
  const bookContent=await resolveBook(project,options.story);
  const story=storyPaths(project,bookContent);
  inside(story.audio,timelinePath);
  validateTimeline(timeline,bookContent);
  if(!['ready','fixture'].includes(timeline.mode))throw new Error('Timeline is not ready.');
  if(timeline.mode==='fixture'&&!options['allow-test-audio'])throw new Error('Test tones are not narration. Use --allow-test-audio only for pipeline verification.');
  if(timeline.audioFile!=='master.wav')throw new Error('Expected the local master.wav next to the timeline.');
  const audioPath=path.join(path.dirname(timelinePath),'master.wav'), audio=await fs.readFile(audioPath);
  if(pcmData(audio).length/2!==timeline.totalSamples || crypto.createHash('sha256').update(audio).digest('hex')!==timeline.audioSha256)throw new Error('Master audio is changed/truncated; rebuild narration.');
  const width=Number(options.width||1920), height=Number(options.height||1080), fps=Number(options.fps||30);
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<320||height<180||width%2||height%2||width>3840||height>2160||!Number.isInteger(fps)||fps<1||fps>60)throw new Error('Use even dimensions up to 3840×2160, and an integer fps of 1–60.');
  await fs.mkdir(story.video,{recursive:true});
  const output=inside(story.video,path.resolve(options.output||path.join(story.video,path.basename(path.dirname(timelinePath))+'.mp4')));
  try{await fs.access(output);throw new Error('Video exists; choose a new output filename.');}catch(e){if(e.code!=='ENOENT')throw e;}
  const ffmpeg=process.env.FFMPEG_PATH||'ffmpeg', ffprobe=process.env.FFPROBE_PATH||'ffprobe';
  for(const binary of [ffmpeg,ffprobe]){const check=spawnSync(binary,['-version'],{encoding:'utf8'});if(check.status!==0)throw new Error(`${binary} is unavailable.`);}
  await fs.mkdir(path.dirname(output),{recursive:true});
  const staging=await fs.mkdtemp(path.join(path.dirname(output),'.render-')), temporary=path.join(staging,'video.mp4');

  let server,browser,encoder,rendering=false;
  const cleanup=async()=>{
    try{encoder?.stdin?.destroy();}catch{/* the pipe may already be gone */}
    if(encoder&&encoder.exitCode===null)encoder.kill('SIGTERM');
    await browser?.close();
    await server?.close();
    await fs.rm(staging,{recursive:true,force:true}).catch(()=>{});
  };
  // Node's default SIGINT handler skips finally blocks, which would leak the staging
  // directory and the browser's profile.
  const onSignal=signal=>{ if(rendering) return; cleanup().finally(()=>process.exit(signal==='SIGINT'?130:143)); };
  process.once('SIGINT',()=>onSignal('SIGINT'));
  process.once('SIGTERM',()=>onSignal('SIGTERM'));

  try {
    server=await serveStory({project,story:story.id});
    browser=await openBrowser({chrome:options.chrome,width,height});
    const page=browser.page;
    // ?export=1 is what puts the reader into deterministic, chrome-free render mode.
    await page.goto(`${server.url}?export=1`);
    await waitFor(page,'Boolean(window.bookDemo)',30000,'the reader to start');
    await page.evaluate('window.bookDemo.ready',{awaitPromise:true}).catch(error=>{throw new Error(error.message);});
    await page.evaluate('document.fonts.ready.then(()=>true)',{awaitPromise:true});
    await page.evaluate(`window.bookDemo.setExportTimeline(${JSON.stringify(timeline)})`);
    // The page documents name this face; without it the typeset text falls back and can
    // clip. Recorded rather than enforced — a machine may legitimately lack it.
    const fontAvailable=await page.evaluate(`document.fonts.check('600 64px "Arial Rounded MT Bold"')`);

    const frames=Math.ceil(timeline.duration*fps), duration=frames/fps;
    encoder=spawn(ffmpeg,['-v','error','-y','-f','image2pipe','-vcodec','png','-framerate',String(fps),'-i','pipe:0','-i',audioPath,'-map','0:v:0','-map','1:a:0','-c:v','libx264','-preset','fast','-crf','20','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-ar','48000','-af','apad','-t',String(duration),'-movflags','+faststart','-metadata','comment='+timeline.disclosure,temporary],{stdio:['pipe','ignore','pipe']});
    let encodingError='', pipeError=null;
    encoder.stderr.on('data',data=>{encodingError=(encodingError+data.toString()).slice(-4000);});
    encoder.stdin.on('error',error=>{pipeError=error;});
    const completion=new Promise((resolve,reject)=>{encoder.once('error',reject);encoder.once('close',code=>code===0?resolve():reject(new Error('FFmpeg failed: '+encodingError)));});
    completion.catch(()=>{});

    const digest=crypto.createHash('sha256');
    rendering=true;
    for(let frame=0;frame<frames;frame++){
      await page.evaluate(`window.bookDemo.renderAt(${frame/fps})`);
      // Let the compositor present this pose; without it the capture can be one frame stale.
      await page.settle();
      const png=await page.screenshot(width,height);
      const size=pngSize(png);
      if(!size||size.width!==width||size.height!==height)throw new Error(`Frame ${frame} came back ${size?`${size.width}×${size.height}`:'malformed'}, expected ${width}×${height}.`);
      digest.update(png);
      const errors=page.errors;
      if(errors.length)throw new Error(errors.join('\n'));
      if(page.crashed)throw new Error(`The page crashed at frame ${frame}.`);
      if(pipeError)throw pipeError;
      if(!encoder.stdin.write(png))await Promise.race([once(encoder.stdin,'drain'),completion.then(()=>{throw new Error('Encoder exited before all frames.');})]);
      if(frame%Math.max(1,fps*2)===0)console.log(`Rendered ${frame+1}/${frames} frames (${Math.round(100*(frame+1)/frames)}%)`);
    }
    encoder.stdin.end();await completion;
    rendering=false;
    const probe=spawnSync(ffprobe,['-v','error','-show_streams','-show_format','-of','json',temporary],{encoding:'utf8'});
    if(probe.status!==0)throw new Error('Unable to inspect encoded MP4.');
    const info=JSON.parse(probe.stdout), video=info.streams.find(s=>s.codec_type==='video'), sound=info.streams.find(s=>s.codec_type==='audio');
    if(video?.codec_name!=='h264'||sound?.codec_name!=='aac'||video.width!==width||video.height!==height||Number(video.nb_frames)!==frames||Math.abs(Number(video.duration)-Number(sound.duration))>1/fps+0.025)throw new Error('Encoded video failed duration/codec/frame-count checks.');
    await fs.rename(temporary,output);
    const report={output,mode:timeline.mode,disclosure:timeline.disclosure,width,height,fps,frames,timelineDuration:timeline.duration,videoDuration:Number(video.duration),audioDuration:Number(sound.duration),audioSha256:timeline.audioSha256,contentKey:timeline.contentKey,method:'Absolute timeline samples; offline PNG frames over CDP; FFmpeg H.264/AAC; no real-time screen recording.',
      // Provenance: "did this refactor change the book" should be answerable from the artifact.
      browser:{product:browser.product,protocolVersion:browser.protocolVersion,executable:browser.executable,software:browser.software,webgl:browser.webgl},
      fonts:{arialRoundedMTBold:fontAvailable},
      // Same input twice must give the same bytes; compare this across runs.
      frameDigestSha256:digest.digest('hex')};
    await fs.writeFile(output+'.json',JSON.stringify(report,null,2));
    if(!fontAvailable)console.warn('Warning: "Arial Rounded MT Bold" is not installed; the page text used a fallback face and may differ from other machines.');
    console.log(`Exported ${output}`);return report;
  }finally{
    rendering=false;
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
    await cleanup();
  }
}
if(isMain(import.meta.url)){
 const options={};
 for(let i=2;i<process.argv.length;i++){const key=process.argv[i].replace(/^--/,'');if(key==='allow-test-audio')options[key]=true;else options[key]=process.argv[++i];}
 exportVideo(options).catch(error=>{console.error(error.message);process.exitCode=1;});
}
