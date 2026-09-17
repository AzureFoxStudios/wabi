import { writable } from 'svelte/store';
import { mobileTabQueue } from '$lib/mobileTabQueue';
import { captureNotebookOwner } from '$lib/notes/scope';
import { getServerUrl } from '$lib/serverUrl';
import { getAuthToken } from '$lib/authSession';
export type ArtifactKind = 'document' | 'sheets' | 'present';
export type Tool = 'documents' | 'sheets' | 'present' | 'audience';
export type Role = 'owner' | 'editor' | 'commenter' | 'viewer';
export interface Meta { id:string; kind:ArtifactKind; format:string; title:string; mode:'live'|'snapshot'; generation:number; accessRevision:number; sequence:number; revision:number; ownerUserId:number; role:Role; grants:Record<string,Role>|null; channelId:string|null; channelRole:Role; updatedAt:number; }
export interface Review {id:string;authorUserId:number;authorName:string;kind:'comment'|'suggestion';body:string;anchor:string|null;proposal:string|null;state:string;createdAt:number;}
export interface Target {id?:string;sessionId?:string;source?:{title:string;content:string;format:string;sourceKey:string};shareMode?:'snapshot'|'live';}
export const targets=writable<Partial<Record<Tool,Target>>>({});
export function openWorkspace(tool:Tool,target:Target={}) {targets.update(v=>({...v,[tool]:target}));mobileTabQueue.registerAddonTab({id:`workspace-${tool}`,label:tool==='documents'?'Documents':tool==='audience'?'Presentation':tool==='sheets'?'Sheets':'Present',shortLabel:tool==='documents'?'Docs':tool==='audience'?'Slides':tool==='sheets'?'Sheets':'Present'});mobileTabQueue.openAddonTab(`workspace-${tool}`);}
export function workspaceLink(server:string,id:string,kind:ArtifactKind){const url=new URL(server);url.searchParams.set('workspaceArtifact',id);url.searchParams.set('workspaceKind',kind);return url.toString();}
export function presentationLink(server:string,id:string){const url=new URL(server);url.searchParams.set('workspaceSession',id);return url.toString();}
export interface Scope {scopeId:string;server:string;isCurrent:()=>boolean;}
export async function captureScope():Promise<Scope>{const owner=await captureNotebookOwner();const server=getServerUrl().replace(/\/$/,'');return{scopeId:owner.scopeId,server,isCurrent:()=>owner.isCurrent()&&getServerUrl().replace(/\/$/,'')===server};}
export class WorkspaceError extends Error {constructor(public status:number,message:string){super(message);}}
export async function request<T>(scope:Scope,path:string,body?:unknown,method?:string,signal?:AbortSignal):Promise<T>{
    if(!scope.isCurrent())throw new WorkspaceError(401,'Account or server changed. Local work is retained.');
    const token=getAuthToken(scope.server);if(!token)throw new WorkspaceError(401,'Sign in to share work. Local editing remains available.');
    const response=await fetch(`${scope.server}/api/workspace${path}`,{method:method||(body===undefined?'GET':'POST'),headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal});
    if(!scope.isCurrent())throw new WorkspaceError(401,'Account or server changed.');
    const value=await response.json().catch(()=>({error:'Server did not return workspace data'}));
    if(!response.ok)throw new WorkspaceError(response.status,typeof value.error==='string'?value.error:typeof value.message==='string'?value.message:`Workspace request failed (${response.status})`);
    return value as T;
}
const disposers=new Map<ArtifactKind,Set<()=>Promise<void>>>();
export function registerWorkspaceDisposer(kind:ArtifactKind,fn:()=>Promise<void>){let set=disposers.get(kind);if(!set)disposers.set(kind,set=new Set());set.add(fn);return()=>set!.delete(fn);}
export async function closeWorkspaceKind(kind:ArtifactKind){for(const fn of [...(disposers.get(kind)||[])])await fn();}
export interface AudienceSlide{id:string;title:string;body:string;layout:string;image:string|null;}
export interface AudienceState{id:string;controller:number;canControl:boolean;generation:number;sequence:number;slideId:string;edition:string;slides:AudienceSlide[]|null;sourceSequence:number;blank:boolean;paused:boolean;ended:boolean;aspect:number;}

export function workspaceToolFromTab(tab: string | null | undefined): Tool | null {
    const id = tab?.startsWith('addon:workspace-') ? tab.slice('addon:workspace-'.length) : '';
    return ['documents','sheets','present','audience'].includes(id) ? id as Tool : null;
}
