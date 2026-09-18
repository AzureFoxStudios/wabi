import { writable } from 'svelte/store';
import { mobileTabQueue } from '$lib/mobileTabQueue';
import { captureNotebookOwner, notebookOwner } from '$lib/notes/scope';
import { getServerUrl, activeServerUrl } from '$lib/serverUrl';
import { getAuthToken, onAuthSessionCleared } from '$lib/authSession';

export type ArtifactKind = 'document' | 'sheets' | 'present';
export type Tool = 'documents' | 'sheets' | 'present' | 'audience';
export type Role = 'owner' | 'editor' | 'commenter' | 'viewer';
export interface ProtectedRange {id:string;sheetId:string;rows:string[];columns:string[];label:string;}
export interface Meta {
    id:string;kind:ArtifactKind;format:string;title:string;mode:'live'|'snapshot';
    generation:number;accessRevision:number;sequence:number;revision:number;
    ownerUserId:number;role:Role;grants:Record<string,Role>|null;
    channelId:string|null;channelRole:Role;updatedAt:number;protectedRanges?:ProtectedRange[];
}
export interface Review {id:string;authorUserId:number;authorName:string;kind:'comment'|'suggestion';body:string;anchor:string|null;proposal:string|null;state:string;createdAt:number;parentId?:string|null;}
export interface Target {id?:string;sessionId?:string;anchor?:string;source?:{title:string;content:string;format:string;sourceKey:string};shareMode?:'snapshot'|'live';}
export const targets=writable<Partial<Record<Tool,Target>>>({});

// A handoff may contain private Reader text. It must not survive a server,
// account or logout transition and seed a document in the next identity.
let lastOwner:string|null|undefined;
let lastServer:string|undefined;
notebookOwner.subscribe(value=>{
    const owner=value.owner?.scopeId??null;
    if(lastOwner!==undefined&&owner!==lastOwner)targets.set({});
    lastOwner=owner;
});
activeServerUrl.subscribe(server=>{
    if(lastServer!==undefined&&server!==lastServer)targets.set({});
    lastServer=server;
});
onAuthSessionCleared(()=>targets.set({}));

export function openWorkspace(tool:Tool,target:Target={}) {
    targets.update(value=>({...value,[tool]:target}));
    mobileTabQueue.registerAddonTab({id:`workspace-${tool}`,label:tool==='documents'?'Documents':tool==='audience'?'Presentation':tool==='sheets'?'Sheets':'Present',shortLabel:tool==='documents'?'Docs':tool==='audience'?'Slides':tool==='sheets'?'Sheets':'Present'});
    mobileTabQueue.openAddonTab(`workspace-${tool}`);
}
export function workspaceLink(server:string,id:string,kind:ArtifactKind,anchor?:string){
    const url=new URL(server);url.searchParams.set('workspaceArtifact',id);url.searchParams.set('workspaceKind',kind);
    if(anchor)url.searchParams.set('workspaceAnchor',anchor);
    return url.toString();
}
export function presentationLink(server:string,id:string){const url=new URL(server);url.searchParams.set('workspaceSession',id);return url.toString();}
export interface Scope {scopeId:string;server:string;isCurrent:()=>boolean;}
export async function captureScope():Promise<Scope>{
    const owner=await captureNotebookOwner();const server=getServerUrl().replace(/\/$/,'');
    if(!owner.isCurrent())throw new WorkspaceError(401,'Account changed while opening the workspace.');
    return {scopeId:owner.scopeId,server,isCurrent:()=>owner.isCurrent()&&getServerUrl().replace(/\/$/,'')===server};
}
export class WorkspaceError extends Error {constructor(public status:number,message:string){super(message);}}

export async function request<T>(scope:Scope,path:string,body?:unknown,method?:string,signal?:AbortSignal):Promise<T>{
    const current=()=>{if(!scope.isCurrent())throw new WorkspaceError(401,'Account or server changed. Local work is retained.');};
    current();
    const token=getAuthToken(scope.server);
    if(!token)throw new WorkspaceError(401,'Sign in to share work. Local editing remains available.');
    const controller=new AbortController();
    const cancel=()=>controller.abort(signal?.reason);
    if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});
    const timer=setTimeout(()=>controller.abort(new DOMException('Workspace request timed out; local work is retained.','TimeoutError')),45000);
    try {
        const response=await fetch(`${scope.server}/api/workspace${path}`,{method:method||(body===undefined?'GET':'POST'),headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal});
        current();
        const limit=32*1024*1024;
        if(Number(response.headers.get('content-length'))>limit)throw new WorkspaceError(413,'Workspace response exceeds the supported size.');
        const reader=response.body?.getReader();let text='';
        if(reader){
            const decoder=new TextDecoder();let bytes=0;
            try {while(true){const item=await reader.read();if(item.done)break;bytes+=item.value.byteLength;if(bytes>limit){await reader.cancel();throw new WorkspaceError(413,'Workspace response exceeds the supported size.');}text+=decoder.decode(item.value,{stream:true});}text+=decoder.decode();}
            finally {reader.releaseLock();}
        }else{text=await response.text();if(text.length>limit)throw new WorkspaceError(413,'Workspace response exceeds the supported size.');}
        // Parsing is asynchronous relative to identity changes, too.
        current();
        let value:Record<string,unknown>;
        try {value=JSON.parse(text);if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();}
        catch {throw new WorkspaceError(response.ok?502:response.status,'Server did not return workspace data.');}
        current();
        if(!response.ok)throw new WorkspaceError(response.status,String(typeof value.error==='string'?value.error:typeof value.message==='string'?value.message:`Workspace request failed (${response.status})`).slice(0,2000));
        return value as T;
    } finally {clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
}
const disposers=new Map<ArtifactKind,Set<()=>Promise<void>>>();
export function registerWorkspaceDisposer(kind:ArtifactKind,fn:()=>Promise<void>){let set=disposers.get(kind);if(!set)disposers.set(kind,set=new Set());set.add(fn);return()=>set!.delete(fn);}
export async function closeWorkspaceKind(kind:ArtifactKind){for(const fn of [...(disposers.get(kind)||[])])await fn();}
export interface AudienceSlide{id:string;title:string;body:string;layout:string;image:string|null;}
export interface AudienceState{id:string;controller:number;canControl:boolean;generation:number;sequence:number;slideId:string;edition:string;slides:AudienceSlide[]|null;sourceSequence:number;blank:boolean;paused:boolean;ended:boolean;aspect:number;controllerConnected?:boolean;pointer?:{x:number;y:number;slideId:string}|null;}
export function workspaceToolFromTab(tab:string|null|undefined):Tool|null {
    const id=tab?.startsWith('addon:workspace-')?tab.slice('addon:workspace-'.length):'';
    return ['documents','sheets','present','audience'].includes(id)?id as Tool:null;
}
