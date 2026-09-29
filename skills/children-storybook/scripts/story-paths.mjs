import fs from 'node:fs';
import path from 'node:path';
import { storiesDir } from './project.mjs';

export function inside(root, target) {
  const absolute=path.resolve(target), base=fs.realpathSync(root);
  let ancestor=absolute;
  while(!fs.existsSync(ancestor))ancestor=path.dirname(ancestor);
  const resolved=path.join(fs.realpathSync(ancestor),path.relative(ancestor,absolute));
  const relative=path.relative(base,resolved);
  if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw new Error(`Story output must stay inside ${root}`);
  return absolute;
}
export function storyPaths(project,book) {
  const id=book.storyId;
  if(!id||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))throw new Error('bookContent.storyId must identify the active story.');
  const parent=storiesDir(project), root=inside(parent,path.join(parent,id));
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
  if(manifest.id!==id)throw new Error('Story folder and manifest.id must match.');
  return {id,root,audio:inside(root,path.join(root,'audio')),video:inside(root,path.join(root,'video')),backups:inside(root,path.join(root,'backups'))};
}
export function storyUrl(story,file) {
  inside(story.root,file);
  return '/stories/'+story.id+'/'+path.relative(story.root,file).split(path.sep).map(encodeURIComponent).join('/');
}
