import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
const root = path.dirname(new URL(import.meta.url).pathname);
const browser = await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try {
 const page = await browser.newPage({viewport:{width:1100,height:780}});
 const results=[];
 for (const name of ['body','cover']) {
  const svg = await fs.readFile(path.join(root,`${name}.svg`),'utf8');
  await page.setContent('<body style="margin:0;background:#eee"><canvas width="1024" height="1400" style="height:760px"></canvas></body>');
  const result=await page.evaluate(async(svg)=>{
   const image = new Image(); image.src='data:image/svg+xml;base64,'+btoa(unescape(encodeURIComponent(svg))); await image.decode();
   const canvas=document.querySelector('canvas');const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
   const data=ctx.getImageData(0,0,1024,1400).data;
   let dark=0;for(let i=950*1024*4;i<data.length;i+=4)if(data[i]<100&&data[i+1]<120&&data[i+2]<140)dark++;
   return {width:image.naturalWidth,height:image.naturalHeight,visibleTextPixels:dark,exportable:canvas.toDataURL().startsWith('data:image/png')};
  },svg);
  if(result.width!==1024||result.height!==1400||result.visibleTextPixels<500||!result.exportable)throw Error(JSON.stringify(result));
  results.push({name,...result});await page.screenshot({path:path.join(root,`${name}.png`)});
 }
 await fs.writeFile(path.join(root,'browser-check.json'),JSON.stringify({fixture:'Synthetic solid-color artwork, not an image-generation evaluation',results},null,2));
 console.log(JSON.stringify(results));
} finally {await browser.close();}
