import {forumReferenceEntities} from './forumReferences';
import type {ObjectRefRecord} from './objectRefRegistry';
export interface ReferenceSource {load():Promise<ObjectRefRecord[]>;dispose():void}
export interface ReferenceSourceDescriptor {id:string;prefix:'w'|'g';create():ReferenceSource}
/** One reader owns its requests; repeated rendering coalesces and scope changes retire them. */
export function createReferenceHydrator(context:()=>string,register:(record:ObjectRefRecord)=>void) {
 let scope=context(),alive=true;
 const sources=new Map<string,{source:ReferenceSource;pending:Promise<void>}>();
 function clear() {for(const {source} of sources.values())source.dispose();sources.clear();}
 return {
  hydrate(text:string,available:ReferenceSourceDescriptor[]):Promise<void> {
   if(!alive)return Promise.resolve();
   const next=context();if(next!==scope){clear();scope=next;}
   const admitted=new Set(available.map(source=>`${source.prefix}:${source.id}`));
   for(const [key,entry] of sources)if(!admitted.has(key)){entry.source.dispose();sources.delete(key);}
   const needed=new Set<string>();
   forumReferenceEntities(text,token=>{needed.add(token[0]);return null;});
   const pending:Promise<void>[]=[];
   for(const descriptor of available) {
    if(!needed.has(descriptor.prefix))continue;
    const key=`${descriptor.prefix}:${descriptor.id}`;
    let entry=sources.get(key);
    if(!entry) {
     const source=descriptor.create(),captured=scope;
     const request=source.load().then(records=>{
      if(!alive || context()!==captured || sources.get(key)?.source!==source)return;
      for(const record of records)register(record);
     }).catch(()=>{/* Existing workspace error state owns the failure. */});
     entry={source,pending:request};sources.set(key,entry);
    }
    pending.push(entry.pending);
   }
   return Promise.all(pending).then(()=>{});
  },
  dispose(){alive=false;clear();}
 };
}
