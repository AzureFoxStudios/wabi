import { expect, mock, test } from 'bun:test';
import { get, writable } from 'svelte/store';
mock.module('$lib/notes/scope', () => ({ notebookOwner:writable({owner:null}),captureNotebookOwner:async()=>({scopeId:'account',isCurrent:()=>true}) }));
mock.module('$lib/serverUrl', () => ({getServerUrl:()=> 'https://community.test',activeServerUrl:writable('https://community.test')}));
mock.module('$lib/authSession', () => ({getAuthToken:()=> 'token',onAuthSessionCleared:()=>()=>{}}));
const { openWorkspace, targets, workspaceToolFromTab } = await import('./bridge');
const { mobileTabQueue } = await import('../mobileTabQueue');

test('opening an Office workspace navigates the center while preserving its side panel', () => {
    const before = globalThis.window;
    const events: CustomEvent[] = [];
    globalThis.window = {dispatchEvent:(event:Event)=>{events.push(event as CustomEvent);return true;}} as unknown as Window & typeof globalThis;
    try {
        openWorkspace('documents',{id:'artifact'});
        expect(events).toHaveLength(1);
        expect(events[0].type).toBe('wabi:navigate');
        expect(events[0].detail).toEqual({view:'chat',preserveRightPanel:true});
        expect(get(targets).documents).toEqual({id:'artifact'});
        expect(get(mobileTabQueue.activeTabId)).toBe('addon:workspace-documents');
        openWorkspace('sheets',{id:'sheet-artifact'});
        expect(get(targets).documents).toEqual({id:'artifact'});
        expect(get(targets).sheets).toEqual({id:'sheet-artifact'});
    } finally {globalThis.window=before;}
});
test('only Office addon tokens select an Office editor',()=>{
    expect(workspaceToolFromTab('addon:workspace-present')).toBe('present');
    expect(workspaceToolFromTab('addon:workspace-audience')).toBe('audience');
    expect(workspaceToolFromTab('channel:workspace-documents')).toBeNull();
    expect(workspaceToolFromTab('addon:project-workers')).toBeNull();
    expect(workspaceToolFromTab('addon:workspace-unregistered')).toBeNull();
});
