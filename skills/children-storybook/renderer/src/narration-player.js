import { validateTimeline } from '../../scripts/media-core.mjs';

export class NarrationPlayer {
  constructor(book, onChange = () => {}) {
    this.book=book;this.onChange=onChange;this.status='unconfigured';this.offset=0;this.session=0;
  }
  async load(url) {
    if(!url)return;
    this.status='loading';this.onChange();
    try{
      const response=await fetch(url);if(!response.ok)throw new Error('配音时间轴加载失败');
      this.timeline=validateTimeline(await response.json(),this.book);
      if(this.timeline.mode!=='ready')throw new Error('测试音频不能作为故事配音');
      const audioUrl=new URL(this.timeline.audioUrl,location.origin);
      if(audioUrl.origin!==location.origin)throw new Error('配音必须使用项目内音频');
      const audio=await fetch(audioUrl);if(!audio.ok)throw new Error('配音文件加载失败');
      this.bytes=await audio.arrayBuffer();
      const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',this.bytes)),b=>b.toString(16).padStart(2,'0')).join('');
      if(digest!==this.timeline.audioSha256)throw new Error('配音文件已变化，请重新生成时间轴');
      this.status='ready';
    }catch(error){this.status='error';this.error=error.message;this.timeline=null;}
    this.onChange();
  }
  get ready(){return ['ready','playing','paused','ended'].includes(this.status);}
  get time(){return this.status==='playing'?Math.min(this.timeline.duration,this.offset+this.context.currentTime-this.started):this.offset;}
  async play(state=0){
    if(!this.ready)return false;
    const token=++this.session;
    try{
      this.context ||= new AudioContext();
      await this.context.resume();
      if(!this.buffer){
        this.buffer=await this.context.decodeAudioData(this.bytes.slice(0));
        if(Math.abs(this.buffer.duration-this.timeline.duration)>1/1000)throw new Error('配音长度与时间轴不符');
      }
      if(token!==this.session)return false;
      if(this.status!=='paused')this.offset=this.timeline.stateStarts[state]??0;
      if(this.offset>=this.timeline.duration)this.offset=0;
      this.source?.stop();
      const source=this.context.createBufferSource();source.buffer=this.buffer;source.connect(this.context.destination);
      this.source=source;this.started=this.context.currentTime;
      source.start(this.started,this.offset);this.status='playing';
      source.onended=()=>{if(token===this.session&&this.status==='playing'){this.offset=this.timeline.duration;this.status='ended';this.onChange();}};
      this.onChange();return true;
    }catch(error){if(token===this.session){this.status='error';this.error=error.message;this.onChange();}return false;}
  }
  pause(){if(this.status!=='playing')return;this.offset=this.time;++this.session;this.source?.stop();this.source=null;this.status='paused';this.onChange();}
  stop(){++this.session;this.source?.stop();this.source=null;this.offset=0;if(this.ready)this.status='ready';this.onChange();}
}
