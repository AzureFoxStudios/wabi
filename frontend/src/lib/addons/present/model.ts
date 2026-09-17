import type {Fields,Json} from '../../workspaceArtifacts/model';
import {safeImage,type Page} from '../../workspaceArtifacts/presentation';
export interface Slide {title:string;body:string;layout:Page['layout'];image?:string|null;hidden?:boolean}
export const key=(id:string)=>`slide:${id}`;
export function slideIds(f:Fields):string[]{return Array.isArray(f.slides)?f.slides.filter((x):x is string=>typeof x==='string'):[];}
export function slide(f:Fields,id:string):Slide{const p=f[key(id)];if(!p||typeof p!=='object'||Array.isArray(p))throw new Error('Invalid slide');return p as unknown as Slide;}
export function asJson(value:unknown):Json{return value as Json;}
export function newDeck():Fields{const id=crypto.randomUUID();return {title:'Untitled presentation',slides:[id],theme:'paper',aspect:16/9,[key(id)]:{title:'Your title',body:'Your message',layout:'title',hidden:false,image:null}};}
export function audiencePages(f:Fields):Page[]{
  const theme=['paper','night','sage'].includes(String(f.theme))?f.theme as Page['theme']:'paper';
  const aspect=typeof f.aspect==='number'&&f.aspect>=.5&&f.aspect<=3?f.aspect:16/9;
  return slideIds(f).filter(id=>!slide(f,id).hidden).map(id=>{const p=slide(f,id);return {id,title:p.title||'',body:p.body||'',layout:p.layout||'body',image:safeImage(p.image)?p.image:null,theme,aspect};});
}
export function fromMarkdown(text:string,title='Presentation'):Fields{
  const parts=text.split(/^\s*---\s*$/m).flatMap(part=>part.split(/(?=^#\s)/m)).filter(p=>p.trim());
  if(!parts.length)throw new Error('The source document is empty');if(parts.length>300)throw new Error('The source exceeds 300 slides');
  const f:Fields={title,slides:[],theme:'paper',aspect:16/9};
  for(const part of parts){const lines=part.trim().split('\n'),heading=lines[0].match(/^#{1,3}\s+(.+)$/),id=crypto.randomUUID();(f.slides as Json[]).push(id);f[key(id)]={title:heading?heading[1]:'',body:(heading?lines.slice(1):lines).join('\n').trim(),layout:heading&&lines.length<3?'title':'body',image:null,hidden:false};}
  return f;
}
export async function normalizeImage(file:File):Promise<string>{
  if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>12*1024*1024)throw new Error('Choose a PNG, JPEG, or WebP image up to 12 MiB.');
  const bitmap=await createImageBitmap(file);try{if(bitmap.width*bitmap.height>40_000_000)throw new Error('Image dimensions are too large.');const factor=Math.min(1,1600/Math.max(bitmap.width,bitmap.height)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*factor));canvas.height=Math.max(1,Math.round(bitmap.height*factor));const context=canvas.getContext('2d');if(!context)throw new Error('Image conversion is unavailable');context.drawImage(bitmap,0,0,canvas.width,canvas.height);const result=canvas.toDataURL('image/webp',.88);if(!safeImage(result))throw new Error('Converted image exceeds the slide limit');return result;}finally{bitmap.close();}
}
