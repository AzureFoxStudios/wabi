import {getServerUrl} from '$lib/serverUrl';
import {getAuthToken,getStoredDbUserId,getGuestSessionId} from '$lib/authSession';
import {writable,get,type Writable} from 'svelte/store';
import {changes,equal,newId,rebase,type Artifact,type ArtifactKind,type Access,type Draft,type Fields,type Json,type Conflict} from './model';
import {saveDraft,findDraft} from './storage';
export interface Scope {server:string;userId:number;token:string|null;key:string;current:()=>boolean}
export class HttpError extends Error {constructor(public status:number,message:string){super(message);}}
export function captureScope():Scope{
  const server=getServerUrl().replace(/\/$/,''),token=getAuthToken(server),userId=Number(getStoredDbUserId(server)||0),guest=getGuestSessionId(server);
  let device='anonymous';try{device=localStorage.getItem('wabi-workspace-device-v1')||newId();localStorage.setItem('wabi-workspace-device-v1',device);}catch{/* storage failure is surfaced by the durable save */}
  const current=()=>getServerUrl().replace(/\/$/,'')===server&&getAuthToken(server)===token&&Number(getStoredDbUserId(server)||0)===userId&&getGuestSessionId(server)===guest;
  return {server,userId,token,key:`${server}|${userId?`user:${userId}`:(guest?`guest:${guest}`:`device:${device}`)}`,current};
}
export async function request<T>(scope:Scope,path:string,method='GET',body?:unknown,signal?:AbortSignal):Promise<T|null>{
  if(!scope.current())throw new Error('Account or server changed');
  const timeout=AbortSignal.timeout(15000),combined=signal?AbortSignal.any([timeout,signal]):timeout;
  const response=await fetch(`${scope.server}/api/artifacts${path}`,{method,signal:combined,cache:'no-store',credentials:'omit',headers:{...(scope.token?{Authorization:`Bearer ${scope.token}`}:{ }),...(body!==undefined?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  if(!scope.current())throw new Error('Account or server changed');
  if(response.status===204)return null;
  const data=await response.json().catch(()=>null);
  if(!response.ok)throw new HttpError(response.status,data?.error||`Workspace request failed (${response.status})`);
  if(!data)throw new Error('Server returned an invalid workspace response');
  return data as T;
}
export type View={artifact:Artifact;access:Access|'owner'};
export type SessionState={draft:Draft;access:Access|'owner';save:'saving'|'saved'|'error';network:'local'|'syncing'|'synced'|'offline'|'blocked';error:string|null};
export class ArtifactSession{
  readonly scope:Scope;readonly state:Writable<SessionState>;private stop=false;private timer:ReturnType<typeof setTimeout>|undefined;
  private serial:Promise<void>=Promise.resolve();private persisting=false;private pendingPersist:{epoch:number;draft:Draft}|null=null;private syncing=false;private epoch=0;private ackEpoch=0;private abort=new AbortController();
  private constructor(scope:Scope,draft:Draft){this.scope=scope;this.state=writable<SessionState>({draft,access:draft.base?.ownerId===scope.userId?'owner':draft.lastAccess||'viewer',save:'saving',network:draft.base?'offline':'local',error:null});}
  static async open(scope:Scope,id?:string,kind:ArtifactKind='document',seed:Fields={title:'Untitled',text:'',format:'markdown'},draftKey?:string):Promise<ArtifactSession>{
    const saved=id?await findDraft(scope.key,id,draftKey):undefined;
    const writer=newId(),artifactId=id||newId();
    const draft:Draft=saved?{...structuredClone(saved),writer,key:`${scope.key}|${artifactId}|${writer}`}:{v:1,key:`${scope.key}|${artifactId}|${writer}`,scope:scope.key,writer,id:artifactId,kind,base:null,fields:structuredClone(seed),conflicts:[],updatedAt:Date.now(),privateNotes:{}};
    // Each window owns a recovery record. Opening another window never overwrites its draft.
    const session=new ArtifactSession(scope,draft);await session.persist();
    if(id&&(!saved||saved.base)){try{const view=await request<View>(scope,`/${encodeURIComponent(id)}`);if(view)await session.receive(view);}catch(e){if(e instanceof HttpError&&(e.status===403||e.status===404)&&!saved){throw e;}session.failure(e);}}
    session.schedule();return session;
  }
  private mutate(fn:(s:SessionState)=>SessionState){this.state.update(fn);}
  private current():boolean{return !this.stop&&this.scope.current();}
  private failure(error:unknown){this.mutate(s=>({...s,network:error instanceof HttpError&&[400,401,403,404,413,422].includes(error.status)?'blocked':'offline',error:error instanceof Error?error.message:String(error)}));}
  private persist():Promise<void>{
    const epoch=++this.epoch;
    this.mutate(s=>({...s,save:'saving',draft:{...s.draft,updatedAt:Math.max(Date.now(),s.draft.updatedAt+1)}}));
    // Keep one latest immutable draft reference, not one full workbook clone per keystroke.
    // saveDraft takes its own isolated snapshot immediately before the transaction.
    this.pendingPersist={epoch,draft:get(this.state).draft};
    if(!this.persisting){
      this.persisting=true;
      this.serial=Promise.resolve().then(async()=>{
        while(this.pendingPersist){
          const next=this.pendingPersist;this.pendingPersist=null;
          await saveDraft(next.draft);this.ackEpoch=next.epoch;
        }
        if(this.current()&&this.ackEpoch===this.epoch)this.mutate(s=>({...s,save:'saved'}));
      }).catch(error=>{
        if(this.current())this.mutate(s=>({...s,save:'error',error:error instanceof Error?error.message:'Local storage failed'}));
        throw error;
      }).finally(()=>{this.persisting=false;});
    }
    return this.serial;
  }
  edit(key:string,value:Json|undefined):void{
    if(!this.current())return;
    this.mutate(s=>{const fields={...s.draft.fields};if(value===undefined)delete fields[key];else fields[key]=structuredClone(value);return {...s,draft:{...s.draft,fields},network:s.draft.resumeRequired||s.network==='blocked'?'blocked':s.draft.base?'syncing':'local'};});
    void this.persist().catch(()=>{});this.schedule(450);
  }
  editMany(update:Fields,remove:string[]=[]):void{
    if(!this.current())return;
    this.mutate(s=>{const fields={...s.draft.fields,...structuredClone(update)};remove.forEach(k=>delete fields[k]);return {...s,draft:{...s.draft,fields},network:s.draft.resumeRequired||s.network==='blocked'?'blocked':s.draft.base?'syncing':'local'};});void this.persist().catch(()=>{});this.schedule(450);
  }
  note(id:string,text:string):void{if(!this.current())return;this.mutate(s=>({...s,draft:{...s.draft,privateNotes:{...s.draft.privateNotes,[id]:text}}}));void this.persist().catch(()=>{});}
  resolve(key:string,choice:'mine'|'theirs'):void{
    this.mutate(s=>{const conflict=s.draft.conflicts.find(c=>c.key===key);if(!conflict)return s;const fields={...s.draft.fields},value=choice==='mine'?conflict.mine:conflict.theirs;if(value===undefined)delete fields[key];else fields[key]=structuredClone(value);return {...s,draft:{...s.draft,fields,conflicts:s.draft.conflicts.filter(c=>c.key!==key)}};});void this.persist().catch(()=>{});this.schedule(100);
  }
  private async receive(view:View):Promise<void>{
    if(!this.current())return;
    const s=get(this.state),old=s.draft.base;
    if(old&&view.artifact.revision<old.revision)return;
    const needsReview=Boolean(old&&old.generation!==view.artifact.generation&&(changes(old,s.draft.fields).length||s.draft.conflicts.length));
    const merged=old?rebase(old.fields,s.draft.fields,view.artifact.fields,s.draft.kind):{fields:view.artifact.fields,conflicts:[]};
    // An unresolved local conflict remains unresolved even when a subsequent poll has no new text.
    const conflicts=new Map(s.draft.conflicts.map(c=>[c.key,c]));for(const c of merged.conflicts)conflicts.set(c.key,c);
    for(const [key,c] of conflicts){c.mine=s.draft.fields[key];c.theirs=view.artifact.fields[key];if(equal(c.mine,c.theirs))conflicts.delete(key);else if(c.mine===undefined)delete merged.fields[key];else merged.fields[key]=c.mine;}
    this.mutate(st=>({...st,access:view.access,network:needsReview||st.draft.resumeRequired?'blocked':'synced',error:needsReview?'Permissions or collaboration mode changed. Review your local changes before resuming.':null,draft:{...st.draft,lastAccess:view.access,resumeRequired:needsReview||st.draft.resumeRequired,base:view.artifact,kind:view.artifact.kind,fields:merged.fields,conflicts:[...conflicts.values()]}}));await this.persist();
  }
  private schedule(delay=1400):void{if(this.timer)clearTimeout(this.timer);if(!this.current())return;this.timer=setTimeout(()=>{this.timer=undefined;void this.sync().finally(()=>this.schedule());},delay);}
  async sync(forcePublish=false):Promise<void>{
    if(this.syncing||!this.current())return;this.syncing=true;
    try{
      await this.serial;const s=get(this.state),base=s.draft.base;
      if(!base||s.draft.resumeRequired||s.network==='blocked'||s.save==='error'||this.ackEpoch!==this.epoch)return;
      const mayWrite=s.access==='owner'||s.access==='editor';
      if(mayWrite&&!s.draft.conflicts.length&&(base.mode==='live'||forcePublish)){
        const patch=changes(base,s.draft.fields);
        if(patch.length){
          if(patch.length>4096)throw new Error('This edit exceeds the 4,096-cell synchronized batch limit. Export your local copy; split the edit before publishing.');
          const sentFields=structuredClone(s.draft.fields),sentBase=base;
          this.mutate(st=>({...st,network:'syncing'}));
          try{
            const view=await request<View>(this.scope,`/${base.id}`,'PATCH',{opId:newId(),generation:base.generation,changes:patch},this.abort.signal);
            if(view&&this.current()){
              // Changes made while the request was in flight are rebased onto its acknowledged result.
              const current=get(this.state),pending=rebase(sentFields,current.draft.fields,view.artifact.fields,current.draft.kind);
              this.mutate(st=>({...st,access:view.access,network:'synced',draft:{...st.draft,lastAccess:view.access,base:view.artifact,fields:pending.fields,conflicts:pending.conflicts}}));await this.persist();
            }
          }catch(e){if(e instanceof HttpError&&e.status===409){const latest=await request<View>(this.scope,`/${sentBase.id}`);if(latest)await this.receive(latest);}else throw e;}
          return;
        }
      }
      if(typeof document!=='undefined'&&document.hidden&&!forcePublish)return;
      const latest=await request<View>(this.scope,`/${base.id}?since=${base.revision}`,'GET',undefined,this.abort.signal);if(latest)await this.receive(latest);else this.mutate(st=>({...st,network:'synced',error:null}));
    }catch(e){if(this.current())this.failure(e);}finally{this.syncing=false;}
  }
  async publish(options:{mode:'snapshot'|'live';channelId:string|null;channelAccess:Access;grants:Record<string,Access>}):Promise<void>{
    await this.persist();if(!this.current())throw new Error('Account changed');const s=get(this.state);
    if(s.draft.base)throw new Error('This artifact is already shared; use Manage access or Publish revision.');
    if(!this.scope.token||!this.scope.userId)throw new Error('Sign in to publish. Your local copy remains saved here.');
    const sent=structuredClone(s.draft.fields);let view:View|null;
    try{view=await request<View>(this.scope,'/','POST',{id:s.draft.id,opId:newId(),kind:s.draft.kind,fields:sent,...options},this.abort.signal);}
    catch(error){
      if(error instanceof HttpError&&error.status===409){
        const existing=await request<View>(this.scope,`/${s.draft.id}`,'GET',undefined,this.abort.signal);
        if(existing&&existing.access==='owner'&&existing.artifact.kind===s.draft.kind&&this.current()){
          const local=get(this.state).draft.fields,conflicts:Conflict[]=[];
          for(const key of new Set([...Object.keys(local),...Object.keys(existing.artifact.fields)]))if(!equal(local[key],existing.artifact.fields[key]))conflicts.push({key,base:undefined,mine:local[key],theirs:existing.artifact.fields[key]});
          this.mutate(st=>({...st,access:'owner',network:'blocked',draft:{...st.draft,base:existing.artifact,lastAccess:'owner',conflicts,resumeRequired:true}}));
          await this.persist();
          throw new Error('A previous publication was recovered. Your newer local work was kept. Review differences and access before resuming.');
        }
      }
      throw error;
    }
    if(view&&this.current()){
      const pending=rebase(sent,get(this.state).draft.fields,view.artifact.fields,s.draft.kind);
      this.mutate(st=>({...st,access:view.access,network:'synced',draft:{...st.draft,lastAccess:view.access,base:view.artifact,fields:pending.fields,conflicts:pending.conflicts}}));await this.persist();this.schedule(100);
    }
  }
  async action(path:string,method:string,body:unknown):Promise<void>{await this.serial;const id=get(this.state).draft.base?.id;if(!id)throw new Error('Share this artifact first');const view=await request<View>(this.scope,`/${id}${path}`,method,body,this.abort.signal);if(view)await this.receive(view);}
  async resume():Promise<void>{const s=get(this.state);if(s.access!=='owner'&&s.access!=='editor')throw new Error('You no longer have editing access. Keep or export the private copy.');this.mutate(st=>({...st,draft:{...st.draft,resumeRequired:false},network:'offline'}));await this.persist();await this.sync();}
  async restorePrivateNotes(notes:Record<string,string>):Promise<void>{
    if(!this.current())return;
    this.mutate(s=>({...s,draft:{...s.draft,privateNotes:structuredClone(notes)}}));await this.persist();
  }
  async annotate(sourceId?:string,originalId?:string):Promise<void>{this.mutate(s=>({...s,draft:{...s.draft,...(sourceId?{sourceId}:{}),...(originalId?{originalId}:{})}}));await this.persist();}
  async flush():Promise<void>{await this.persist();}
  async retry():Promise<void>{await this.persist();this.mutate(s=>({...s,network:s.draft.base?'offline':'local'}));await this.sync();}
  async close():Promise<void>{await this.persist();this.stop=true;if(this.timer)clearTimeout(this.timer);this.abort.abort();}
  abortOnUnmount():void{this.stop=true;if(this.timer)clearTimeout(this.timer);this.abort.abort();void this.persist().catch(()=>{});}
}
