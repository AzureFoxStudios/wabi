import {writable} from 'svelte/store';
import {mobileTabQueue} from '$lib/mobileTabQueue';
import type {ArtifactKind,Fields} from './model';
export type Selection={nonce:string;kind:ArtifactKind|'library'|'audience';id?:string;draftKey?:string;seed?:Fields;sourceId?:string;originalId?:string;shareRequested?:boolean;initialMode?:'snapshot'|'live';privateNotes?:Record<string,string>};
export const workspaceSelection=writable<Selection|null>(null);
export function openWorkspace(input:Omit<Selection,'nonce'>):void{workspaceSelection.set({...input,nonce:crypto.randomUUID()});mobileTabQueue.openAddonTab('reader');}
export function closeWorkspace():void{workspaceSelection.set(null);}

/** A link selects content only on the already selected Authority; it never
 * changes servers, executes code, or grants access. The API enforces access. */
export function openWorkspaceLink(location: Location = window.location): boolean {
  const url = new URL(location.href);
  const presentation = url.searchParams.get('wabiPresentation');
  const artifact = url.searchParams.get('wabiArtifact');
  const id = presentation || artifact;
  if (!id || !/^[a-f0-9-]{36}$/i.test(id)) return false;
  openWorkspace({kind: presentation ? 'audience' : 'document', id});
  return true;
}
