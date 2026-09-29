// Shared by the browser, narration builder and offline renderer. No Node-only APIs.
// The one disclosure default, so the reader's export footer and the burned-in video caption
// cannot disagree about what the audio is. The builder can override it per run; a brand name
// is never a disclosure.
export const DEFAULT_DISCLOSURE = 'AI-generated narration (synthetic voice)';
export function pageSequence(book) {
  if (!book?.sheets?.length) throw new Error('Book has no sheets.');
  return book.sheets.flatMap((sheet, i) => [
    { id: i === 0 ? 'cover' : `page-${String(2*i).padStart(2,'0')}`, state: i, side: i === 0 ? 'cover' : 'right', ...sheet.front },
    { id: i === book.sheets.length-1 ? 'back' : `page-${String(2*i+1).padStart(2,'0')}`, state: i+1, side: i === book.sheets.length-1 ? 'cover' : 'left', ...sheet.back },
  ]).map(page => {
    if (!page.text?.trim()) throw new Error(`Missing narration text: ${page.id}`);
    return page;
  });
}
export function contentKey(book) {
  return JSON.stringify(pageSequence(book).map(({id,text,image}) => ({id,text,image})));
}
export const defaults = Object.freeze({ sampleRate: 48000, lead: 0.6, pageGap: 0.4, spreadPause: 0.65, turn: 1.35, settle: 0.55, tail: 0.8 });
export function makeTimeline(book, clips, options = {}) {
  const config = {...defaults, ...options};
  for (const key of Object.keys(defaults)) {
    if (!Number.isFinite(config[key]) || config[key] < 0 || (key === 'sampleRate' && config[key] !== 48000) || (key === 'turn' && config[key] <= 0)) throw new Error(`Invalid timing: ${key}`);
  }
  const segments = [], stateStarts = {}, rate = config.sampleRate;
  let cursor = 0;
  const append = (samples, item) => {
    if (samples <= 0) return;
    const segment = {...item, startSample:cursor, samples, start:cursor/rate, end:(cursor+samples)/rate};
    segments.push(segment); cursor += samples;
  };
  const gap = (seconds, state) => append(Math.round(seconds*rate), {kind:'gap',state});
  const sequence = pageSequence(book);
  for (let state = 0; state <= book.sheets.length; state++) {
    stateStarts[state] = cursor/rate;
    gap(state === 0 ? config.lead : config.settle, state);
    const pages = sequence.filter(page => page.state === state);
    pages.forEach((page,index) => {
      const clip = clips.find(clip => clip.id === page.id);
      if (!clip || !Number.isSafeInteger(clip.samples) || clip.samples <= 0) throw new Error(`Missing/invalid measured audio: ${page.id}`);
      if (index) gap(config.pageGap,state);
      append(clip.samples,{kind:'narration',state,pageId:page.id,side:page.side,text:page.text,file:clip.file});
    });
    if (state < book.sheets.length) {
      gap(config.spreadPause,state);
      append(Math.round(config.turn*rate), {kind:'turn',from:state,to:state+1,state});
    } else gap(config.tail,state);
  }
  return {version:1,contentKey:contentKey(book),sampleRate:rate,totalSamples:cursor,duration:cursor/rate,sheetCount:book.sheets.length,stateStarts,segments};
}
export function validateTimeline(timeline, book) {
  if (timeline?.version !== 1 || timeline.contentKey !== contentKey(book) || timeline.sheetCount !== book.sheets.length) throw new Error('Narration is stale; rebuild it for the current book.');
  let cursor=0, state=0;
  const expected=pageSequence(book), spoken=[], starts={}, counts={};
  if (!Array.isArray(timeline.segments) || !timeline.segments.length) throw new Error('Empty audio timeline.');
  for (const segment of timeline.segments) {
    if (!Number.isSafeInteger(segment.samples) || segment.samples<=0 || segment.startSample!==cursor || segment.start!==cursor/48000 || segment.end!==(cursor+segment.samples)/48000) throw new Error('Invalid audio timeline boundaries.');
    if (!['gap','turn','narration'].includes(segment.kind) || segment.state!==state || state>book.sheets.length) throw new Error('Invalid timeline state continuity.');
    if (!(state in starts)) starts[state]=segment.start;
    if (segment.kind === 'narration') { spoken.push(segment); counts[state]=(counts[state]??0)+1; }
    if (segment.kind === 'turn') {
      if (segment.from!==state || segment.to!==state+1 || state>=book.sheets.length || counts[state]!==expected.filter(p=>p.state===state).length) throw new Error('Invalid page turn.');
      state++;
    }
    cursor+=segment.samples;
  }
  if (state!==book.sheets.length || cursor!==timeline.totalSamples || timeline.sampleRate!==48000 || timeline.duration!==cursor/48000 || spoken.length!==expected.length) throw new Error('Incomplete audio timeline.');
  expected.forEach((page,i)=>{if(spoken[i].pageId!==page.id||spoken[i].text!==page.text||spoken[i].state!==page.state)throw new Error('Narration/page order mismatch.');});
  if (!timeline.stateStarts || Object.keys(timeline.stateStarts).length!==book.sheets.length+1) throw new Error('Invalid state start offsets.');
  for (let i=0;i<=book.sheets.length;i++) if(timeline.stateStarts[i]!==starts[i]) throw new Error('Invalid state start offsets.');
  return timeline;
}
export function poseAt(timeline, seconds) {
  const time = Math.max(0,Math.min(timeline.duration,seconds));
  const segment = timeline.segments.find(s=>time>=s.start && time<s.end) ?? timeline.segments.at(-1);
  const p = segment.kind==='turn' ? Math.max(0,Math.min(1,(time-segment.start)/(segment.end-segment.start))) : 0;
  const eased = p*p*(3-2*p);
  const progress = Array.from({length:timeline.sheetCount},(_,i)=>i<segment.state ? 1 : i===segment.state && segment.kind==='turn' ? eased : 0);
  return {time,segment,progress,state:segment.state,turnProgress:segment.kind==='turn'?eased:0};
}
