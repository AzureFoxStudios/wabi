import * as Y from 'yjs';
import { writable, get } from 'svelte/store';
import { request, WorkspaceError, registerWorkspaceDisposer, type Scope, type ArtifactKind, type Meta, type Review } from './bridge';
export interface LocalArtifact {schema:1;key:string;scopeId:string;id:string;kind:ArtifactKind;format:string;title:string;update:Uint8Array;pending:Record<string,Uint8Array>;meta:Meta|null;reviews:Review[];updatedAt:number;sourceKey?:string;original?:{name:string;type:string;blob:Blob};}
let database:Promise<IDBDatabase>|null=null;
function db(){if(database)return database;database=new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('wabi-workspace-artifacts-v1',1);r.onupgradeneeded=()=>{const store=r.result.createObjectStore('artifacts',{keyPath:'key'});store.createIndex('scope','scopeId');r.result.createObjectStore('private-notes',{keyPath:'key'});};r.onerror=()=>reject(r.error);r.onblocked=()=>reject(new Error('Another Wabi window must close its older workspace database.'));r.onsuccess=()=>{r.result.onversionchange=()=>{r.result.close();database=null;};resolve(r.result);};}).catch(error=>{database=null;throw error;});return database;}
function key(scopeId:string,id:string){return `${scopeId}\u0000${id}`;}
export async function readLocal(scope:Scope,id:string):Promise<LocalArtifact|null>{const database=await db();return new Promise((resolve,reject)=>{const tx=database.transaction('artifacts','readonly');const r=tx.objectStore('artifacts').get(key(scope.scopeId,id));r.onsuccess=()=>resolve(r.result||null);r.onerror=()=>reject(r.error);});}
export async function listLocal(scope:Scope,kind:ArtifactKind):Promise<Pick<LocalArtifact,'id'|'title'|'updatedAt'|'sourceKey'>[]>{const database=await db();return new Promise((resolve,reject)=>{const rows:Pick<LocalArtifact,'id'|'title'|'updatedAt'|'sourceKey'>[]=[];const tx=database.transaction('artifacts','readonly');const r=tx.objectStore('artifacts').index('scope').openCursor(IDBKeyRange.only(scope.scopeId));r.onsuccess=()=>{const cursor=r.result;if(!cursor){resolve(rows.sort((a,b)=>b.updatedAt-a.updatedAt));return;}const row=cursor.value as LocalArtifact;if(row.kind===kind)rows.push({id:row.id,title:row.title,updatedAt:row.updatedAt,sourceKey:row.sourceKey});cursor.continue();};r.onerror=()=>reject(r.error);});}
async function persist(input:LocalArtifact,add:Record<string,Uint8Array>,ack:string[]):Promise<LocalArtifact>{
    const database=await db();return new Promise((resolve,reject)=>{const tx=database.transaction('artifacts','readwrite');const store=tx.objectStore('artifacts');let output:LocalArtifact;
        const r=store.get(input.key);r.onsuccess=()=>{try{const old=r.result as LocalArtifact|undefined;if(old&&(old.scopeId!==input.scopeId||old.id!==input.id||old.kind!==input.kind))throw new Error('Workspace identity mismatch');
            const update=old?Y.mergeUpdates([old.update,input.update]):input.update;
            if(update.byteLength>12*1024*1024)throw new Error('Workspace exceeds local storage limit. Export a recovery copy.');
            const pending={...(old?.pending||{}),...add};for(const id of ack)delete pending[id];
            const newer=old?.meta&&(!input.meta||old.meta.revision>input.meta.revision)?old:input;
            output={...input,update,pending,meta:newer.meta,reviews:newer.reviews,original:input.original||old?.original};store.put(output);
        }catch(error){tx.abort();reject(error);}};
        tx.oncomplete=()=>resolve(output);tx.onerror=()=>reject(tx.error||new Error('Local workspace save failed'));tx.onabort=()=>reject(tx.error||new Error('Local workspace save was interrupted'));
    });
}
export async function readPrivateNotes(scope:Scope,id:string):Promise<Record<string,string>>{const database=await db();return new Promise((resolve,reject)=>{const r=database.transaction('private-notes','readonly').objectStore('private-notes').get(key(scope.scopeId,id));r.onsuccess=()=>resolve(r.result?.notes||{});r.onerror=()=>reject(r.error);});}
export async function savePrivateNote(scope:Scope,id:string,slide:string,text:string){if(text.length>32000)throw new Error('Speaker note limit exceeded');const database=await db();await new Promise<void>((resolve,reject)=>{const tx=database.transaction('private-notes','readwrite');const store=tx.objectStore('private-notes');const r=store.get(key(scope.scopeId,id));r.onsuccess=()=>store.put({key:key(scope.scopeId,id),notes:{...(r.result?.notes||{}),[slide]:text}});tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('Notes save interrupted'));});}
export function to64(bytes:Uint8Array){let text='';for(let i=0;i<bytes.length;i+=16384)text+=String.fromCharCode(...bytes.subarray(i,i+16384));return btoa(text);}
export function from64(value:string){if(value.length>18*1024*1024)throw new Error('Workspace response too large');return Uint8Array.from(atob(value),c=>c.charCodeAt(0));}
export function editText(text:Y.Text,value:string,origin:unknown){const old=text.toString();if(old===value)return;let start=0,endOld=old.length,endNew=value.length;while(start<endOld&&start<endNew&&old[start]===value[start])start++;if(start&&/[\uD800-\uDBFF]/.test(old[start-1]))start--;while(endOld>start&&endNew>start&&old[endOld-1]===value[endNew-1]){endOld--;endNew--;}if(endOld<old.length&&/[\uDC00-\uDFFF]/.test(old[endOld])){endOld++;endNew++;}text.doc!.transact(()=>{if(endOld>start)text.delete(start,endOld-start);if(endNew>start)text.insert(start,value.slice(start,endNew));},origin);}
export interface SessionState{tick:number;status:string;error:string|null;meta:Meta|null;reviews:Review[];}
interface SyncResponse{meta:Meta;delta:string;reviews:Review[];accepted?:boolean;}
const liveSessions=new Map<string,ArtifactSession>();

export class ArtifactSession{
    readonly doc=new Y.Doc();readonly origin={};readonly state=writable<SessionState>({tick:0,status:'Loading',error:null,meta:null,reviews:[]});
    readonly undo:Y.UndoManager;
    private added:Record<string,Uint8Array>={};private acked:string[]=[];private saving:Promise<void>=Promise.resolve();private syncing:Promise<void>|null=null;private saveTimer:ReturnType<typeof setTimeout>|null=null;private poll:ReturnType<typeof setTimeout>|null=null;private polling=false;private closed=false;private references=1;private abort=new AbortController();private bus:BroadcastChannel|null=null;private unregister:()=>void=()=>{};
    constructor(readonly scope:Scope,public record:LocalArtifact){
        if(record.update.length)Y.applyUpdate(this.doc,record.update,'initial');this.doc.getText('title');this.doc.getText('body');this.doc.getMap('data');
        this.undo=new Y.UndoManager([this.doc.getText('body'),this.doc.getText('title'),this.doc.getMap('data')],{trackedOrigins:new Set([this.origin]),captureTimeout:400});
        this.doc.on('update',this.changed);this.bus=typeof BroadcastChannel==='undefined'?null:new BroadcastChannel('wabi-workspace-committed');
        if(this.bus)this.bus.onmessage=event=>{if(event.data===record.key&&!this.closed&&scope.isCurrent())void this.reloadCommitted();};
        this.unregister=registerWorkspaceDisposer(record.kind,async()=>{if(!(await this.close(true)))throw new Error('Save failed. Export recovery before disabling this addon.');});
        this.show();if(record.meta)this.startPolling();
    }
    get id(){return this.record.id;}get title(){return this.doc.getText('title').toString();}get body(){return this.doc.getText('body');}get data(){return this.doc.getMap<unknown>('data');}
    get editable(){return !this.record.meta||['owner','editor'].includes(this.record.meta.role);}
    retain(){this.references++;return this;}
    private changed=(update:Uint8Array,origin:unknown)=>{if(this.closed)return;if(!['initial','remote','storage'].includes(String(origin)))this.added[crypto.randomUUID()]=update;this.state.update(v=>({...v,tick:v.tick+1,status:Object.keys(this.added).length?'Saving on this device…':v.status}));if(this.saveTimer)clearTimeout(this.saveTimer);this.saveTimer=setTimeout(()=>void this.flush().catch(()=>{}),120);};
    private show(error:string|null=null){const pending=Object.keys(this.record.pending).length+Object.keys(this.added).length;this.state.update(v=>({tick:v.tick+1,meta:this.record.meta,reviews:this.record.reviews,error,status:error?'Needs attention':!this.record.meta?'Saved on this device':pending?(navigator.onLine?'Saved here · waiting to sync':'Offline · changes saved here'):'Synced to this server'}));}
    private async reloadCommitted(){try{const record=await readLocal(this.scope,this.id);if(!record||!this.scope.isCurrent()||this.closed)return;Y.applyUpdate(this.doc,record.update,'storage');if(!this.record.meta||(record.meta&&record.meta.revision>=this.record.meta.revision)){this.record.meta=record.meta;this.record.reviews=record.reviews;}this.record.pending=record.pending;this.show();}catch(error){this.show(String(error));}}
    flush():Promise<void>{
        if(this.saveTimer){clearTimeout(this.saveTimer);this.saveTimer=null;}
        const action=async()=>{const added={...this.added},ack=[...this.acked];const input={...this.record,title:this.title,update:Y.encodeStateAsUpdate(this.doc),updatedAt:Date.now()};
            try{const saved=await persist(input,added,ack);for(const id of Object.keys(added))delete this.added[id];this.acked=this.acked.filter(id=>!ack.includes(id));this.record=saved;Y.applyUpdate(this.doc,saved.update,'storage');this.bus?.postMessage(saved.key);this.show();}
            catch(error){this.show(error instanceof Error?error.message:'Local storage failed');throw error;}
        };const result=this.saving.catch(()=>{}).then(action);this.saving=result;return result;
    }
    private accept(response:SyncResponse,ack:string[]){Y.applyUpdate(this.doc,from64(response.delta),'remote');if(!this.record.meta||response.meta.revision>=this.record.meta.revision){this.record.meta=response.meta;this.record.reviews=response.reviews;}this.acked.push(...ack);}
    async publish(mode:'snapshot'|'live'){
        if(this.record.meta){await this.sync(true);return;}
        await this.flush();const ids=Object.keys(this.record.pending);const response=await request<SyncResponse>(this.scope,'/artifacts',{id:this.id,kind:this.record.kind,format:this.record.format,mode,update:to64(Y.encodeStateAsUpdate(this.doc))},undefined,this.abort.signal);
        this.accept(response,response.accepted?ids:[]);await this.flush();this.startPolling();
    }
    async sync(publish=false):Promise<void>{
        if(this.syncing){await this.syncing;if(!publish)return;}
        const action=async()=>{
            if(this.closed||!this.record.meta)return;if(!this.scope.isCurrent()){this.stopPolling();return;}
            await this.flush();const meta=this.record.meta!;const pending=this.record.pending;const ids=Object.keys(pending);
            // Snapshot drafts must keep their recorded base revision until explicitly published.
            if(meta.mode==='snapshot'&&ids.length&&!publish)return;
            const sending=ids.length>0&&this.editable&&(meta.mode==='live'||publish);
            const body:{vector:string;update?:string;generation?:number;publish?:boolean;baseSequence?:number}={vector:to64(Y.encodeStateVector(this.doc))};
            if(sending){body.update=to64(Y.mergeUpdates(ids.map(id=>pending[id])));body.generation=meta.generation;body.publish=publish;body.baseSequence=meta.sequence;}
            const response=await request<SyncResponse>(this.scope,`/artifacts/${this.id}/sync`,body,undefined,this.abort.signal);this.accept(response,sending?ids:[]);await this.flush();
        };
        this.syncing=action().catch(error=>{if(!(error instanceof DOMException&&error.name==='AbortError'))this.show(error instanceof Error?error.message:String(error));if(error instanceof WorkspaceError&&[401,403,404,409].includes(error.status))this.stopPolling();throw error;}).finally(()=>{this.syncing=null;});return this.syncing;
    }
    startPolling(){if(this.closed||!this.record.meta||this.polling)return;this.polling=true;const run=async()=>{try{await this.sync();}catch{/* Status retains the error and the durable outbox. */}if(this.polling&&!this.closed)this.poll=setTimeout(run,document.hidden?6000:1200);};this.poll=setTimeout(run,100);}
    stopPolling(){this.polling=false;if(this.poll)clearTimeout(this.poll);this.poll=null;}
    async access(grants:Record<string,string>,channelId:string|null,channelRole:string,mode:string,expectedRevision:number){if(!this.record.meta)throw new Error('Publish first');const response=await request<{meta:Meta}>(this.scope,`/artifacts/${this.id}/access`,{grants,channelId,channelRole,mode,expectedRevision});this.record.meta=response.meta;await this.flush();this.startPolling();}
    async review(action:Record<string,unknown>){const response=await request<{meta:Meta;reviews:Review[]}>(this.scope,`/artifacts/${this.id}/reviews`,action);this.record.meta=response.meta;this.record.reviews=response.reviews;await this.flush();await this.sync();}
    recovery(){return JSON.stringify({...this.record,update:to64(Y.encodeStateAsUpdate(this.doc)),pending:Object.fromEntries(Object.entries({...this.record.pending,...this.added}).map(([id,bytes])=>[id,to64(bytes)])),original:undefined},null,2);}
    async close(force=false){if(this.closed)return true;if(!force&&--this.references>0)return true;this.stopPolling();this.abort.abort();try{await this.flush();}catch{this.references=0;this.abort=new AbortController();return false;}this.closed=true;if(this.saveTimer)clearTimeout(this.saveTimer);this.doc.off('update',this.changed);this.bus?.close();this.unregister();this.undo.destroy();this.doc.destroy();liveSessions.delete(this.record.key);return true;}
}
export async function createArtifact(scope:Scope,kind:ArtifactKind,title:string,seed:(doc:Y.Doc)=>void,format='native',sourceKey?:string,original?:LocalArtifact['original']){
    const id=crypto.randomUUID();const doc=new Y.Doc();doc.getText('title').insert(0,title.trim().slice(0,200)||'Untitled');doc.getText('body');doc.getMap('data');seed(doc);const update=Y.encodeStateAsUpdate(doc);doc.destroy();
    const record:LocalArtifact={schema:1,key:key(scope.scopeId,id),scopeId:scope.scopeId,id,kind,format,title,update,pending:{},meta:null,reviews:[],updatedAt:Date.now(),sourceKey,original};
    const saved=await persist(record,{[crypto.randomUUID()]:update},[]);if(!scope.isCurrent())throw new Error('Account changed; draft was preserved under its original account');const session=new ArtifactSession(scope,saved);liveSessions.set(record.key,session);return session;
}
export async function openArtifact(scope:Scope,id:string,kind:ArtifactKind){
    if(!/^[0-9a-f-]{36}$/i.test(id))throw new Error('Invalid workspace ID');const k=key(scope.scopeId,id);const active=liveSessions.get(k);if(active&&active.scope.isCurrent())return active.retain();
    let record=await readLocal(scope,id);
    if(!record){const response=await request<SyncResponse>(scope,`/artifacts/${id}/sync`,{vector:''});if(response.meta.kind!==kind)throw new Error('Wrong workspace type');record={schema:1,key:k,scopeId:scope.scopeId,id,kind,format:response.meta.format,title:response.meta.title,update:from64(response.delta),pending:{},meta:response.meta,reviews:response.reviews,updatedAt:Date.now()};record=await persist(record,{},[]);}
    if(record.kind!==kind)throw new Error('Wrong local workspace type');if(!scope.isCurrent())throw new Error('Account changed');const session=new ArtifactSession(scope,record);liveSessions.set(k,session);return session;
}
export function download(name:string,text:string|Blob,type='application/json'){const blob=typeof text==='string'?new Blob([text],{type}):text;const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
export {Y};
