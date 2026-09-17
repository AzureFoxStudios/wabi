import type {Draft} from './model';
const DB='wabi-workspace-artifacts-v1';
let opening:Promise<IDBDatabase>|undefined;
const recovery=new Map<string,Draft>();
function open():Promise<IDBDatabase>{
  if(!globalThis.indexedDB)return Promise.reject(new Error('Device storage is unavailable. Export your work before leaving.'));
  return opening??=new Promise((resolve,reject)=>{let abandoned=false;const r=indexedDB.open(DB,2);r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains('drafts')){const s=r.result.createObjectStore('drafts',{keyPath:'key'});s.createIndex('scope','scope');}if(!r.result.objectStoreNames.contains('originals'))r.result.createObjectStore('originals',{keyPath:'id'});};r.onsuccess=()=>{if(abandoned){r.result.close();return;}r.result.onversionchange=()=>{r.result.close();opening=undefined;};resolve(r.result);};r.onerror=()=>{opening=undefined;reject(r.error);};r.onblocked=()=>{abandoned=true;opening=undefined;reject(new Error('Another Wabi window is blocking device storage. Close it and retry.'));};});
}
export async function saveDraft(draft:Draft):Promise<void>{
  const copy=structuredClone(draft);recovery.set(copy.key,copy);
  const db=await open();await new Promise<void>((resolve,reject)=>{
    const tx=db.transaction('drafts','readwrite',{durability:'strict'});tx.objectStore('drafts').put(copy);
    tx.oncomplete=()=>{if(recovery.get(copy.key)?.updatedAt===copy.updatedAt)recovery.delete(copy.key);resolve();};tx.onerror=()=>reject(tx.error||new Error('Local save failed'));tx.onabort=()=>reject(tx.error||new Error('Local save was interrupted'));
  });
}
export async function listDrafts(scope:string):Promise<Draft[]>{
  let saved:Draft[];try{const db=await open();saved=await new Promise<Draft[]>((resolve,reject)=>{const tx=db.transaction('drafts','readonly'),r=tx.objectStore('drafts').index('scope').getAll(scope);r.onsuccess=()=>resolve(r.result as Draft[]);r.onerror=()=>reject(r.error);});}catch(error){if(![...recovery.values()].some(d=>d.scope===scope))throw error;saved=[];}
  const combined=new Map(saved.map(d=>[d.key,d]));for(const d of recovery.values())if(d.scope===scope)combined.set(d.key,structuredClone(d));return [...combined.values()].sort((a,b)=>b.updatedAt-a.updatedAt);
}
export async function findDraft(scope:string,id:string,key?:string):Promise<Draft|undefined>{return (await listDrafts(scope)).find(d=>d.id===id&&(!key||d.key===key));}
export async function deleteDraft(scope:string,key:string):Promise<void>{
  const all=await listDrafts(scope);if(!all.some(d=>d.key===key))throw new Error('Draft is outside the current account');
  const db=await open();await new Promise<void>((resolve,reject)=>{const tx=db.transaction('drafts','readwrite');tx.objectStore('drafts').delete(key);tx.oncomplete=()=>{recovery.delete(key);resolve();};tx.onerror=()=>reject(tx.error);});
}
export function downloadJson(name:string,value:unknown):void{
  const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

export async function saveOriginal(scope:string,file:File):Promise<string>{
  if(file.size>32*1024*1024)throw new Error('Files above 32 MiB exceed this importer’s limit.');
  const id=crypto.randomUUID(),db=await open();
  await new Promise<void>((resolve,reject)=>{const tx=db.transaction('originals','readwrite',{durability:'strict'});tx.objectStore('originals').put({id,scope,name:file.name,blob:file});tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('Original file was not saved'));});return id;
}
export async function loadOriginal(scope:string,id:string):Promise<{name:string;blob:Blob}|undefined>{
  const db=await open();return new Promise((resolve,reject)=>{const r=db.transaction('originals','readonly').objectStore('originals').get(id);r.onsuccess=()=>resolve(r.result?.scope===scope?r.result:undefined);r.onerror=()=>reject(r.error);});
}
export function downloadBlob(name:string,blob:Blob):void{const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
