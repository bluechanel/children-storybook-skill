// Serve only browser resources from each story; copy them to dist only at build time.
import fs from 'node:fs/promises';
import path from 'node:path';
import { inside } from './story-paths.mjs';
import { storiesDir } from './project.mjs';
const allowed=/^[a-z0-9-]+\/(pages\/[a-z0-9-]+\/[^/]+\.svg|audio\/[a-z0-9-]+\/(master\.wav|timeline\.json))$/;

// Shared by the Vite plugin and the standalone server so the two can never disagree about
// what is publishable. Only browser-facing assets pass; prompts, backups and caches do not.
export const STORY_ASSET = allowed;
export function storyAssetKind(relative) {
  if (relative.endsWith('.svg')) return 'image/svg+xml';
  if (relative.endsWith('.wav')) return 'audio/wav';
  return 'application/json';
}
// Resolve a /stories/<id>/... request to a file, enforcing containment and the ready gate.
export async function resolveStoryAsset(root, relative) {
  if (!allowed.test(relative)) return null;
  const file = inside(root, path.join(root, relative));
  if (relative.includes('/audio/')) {
    try {
      const timeline = JSON.parse(await fs.readFile(path.join(path.dirname(file), 'timeline.json'), 'utf8'));
      if (timeline.mode !== 'ready') return null;
    } catch { return null; }
  }
  return file;
}
export function storyAssets(project) {
  // The URL prefix stays /stories/ — it is a fixed contract with src/active-story.js.
  // Only the folder on disk can move, and storyPaths() reads the same variable.
  const root=storiesDir(project);
  async function middleware(req,res,next) {
    if(!req.url?.startsWith('/stories/'))return next();
    try{
      const relative=decodeURIComponent(req.url.split('?')[0].slice('/stories/'.length));
      // Story selection imports are JS modules; let Vite transform them.
      if(/^[a-z0-9-]+\/(content|narration)\.js$/.test(relative)){inside(root,path.join(root,relative));return next();}
      if(!allowed.test(relative)){res.statusCode=404;res.end();return;}
      const file=inside(root,path.join(root,relative));
      if(relative.includes('/audio/')){
        const timeline=JSON.parse(await fs.readFile(path.join(path.dirname(file),'timeline.json'),'utf8'));
        if(timeline.mode!=='ready'){res.statusCode=404;res.end();return;}
      }
      const bytes=await fs.readFile(file);
      res.setHeader('Content-Type',file.endsWith('.svg')?'image/svg+xml':file.endsWith('.wav')?'audio/wav':'application/json');
      res.setHeader('Cache-Control','no-cache');res.end(bytes);
    }catch{res.statusCode=404;res.end();}
  }
  return {name:'story-local-assets',
    configureServer(server){server.middlewares.use(middleware);},
    async generateBundle(){
      async function walk(dir){
        let entries;try{entries=await fs.readdir(dir,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return;throw e;}
        for(const entry of entries){
          if(entry.name.startsWith('.')||entry.isSymbolicLink())continue;
          const file=path.join(dir,entry.name), relative=path.relative(root,file).split(path.sep).join('/');
          if(entry.isDirectory()){
            if(relative.split('/').length===1||relative.includes('/pages')||relative.includes('/audio'))await walk(file);
          }else if(allowed.test(relative)){
            if(relative.includes('/audio/')){const t=JSON.parse(await fs.readFile(path.join(path.dirname(file),'timeline.json'),'utf8'));if(t.mode!=='ready')continue;}
            thisPlugin.emitFile({type:'asset',fileName:'stories/'+relative,source:await fs.readFile(file)});
          }
        }
      }
      const thisPlugin=this;await walk(root);
    }
  };
}
