import { expect, mock, test } from 'bun:test';
import { get, writable } from 'svelte/store';
mock.module('$lib/notes/scope', () => ({ notebookOwner:writable({owner:null}),captureNotebookOwner:async()=>({scopeId:'account',isCurrent:()=>true}) }));
mock.module('$lib/serverUrl', () => ({getServerUrl:()=> 'https://community.test',activeServerUrl:writable('https://community.test')}));
mock.module('$lib/authSession', () => ({getAuthToken:()=> 'token',onAuthSessionCleared:()=>()=>{}}));
const { openWorkspace, targets, workspaceToolFromTab, ensureWorkspaceTab, workspaceTabId, OFFICE_TOOL_VIEW, OFFICE_TAB_LABEL } = await import('./bridge');
const { mobileTabQueue } = await import('../mobileTabQueue');
const { createWorkspaceNavigation } = await import('../workspaceNavigation');

function captureNavigation(run:()=>void):CustomEvent[] {
    const before=globalThis.window;
    const events:CustomEvent[]=[];
    globalThis.window={dispatchEvent:(event:Event)=>{events.push(event as CustomEvent);return true;}} as unknown as Window & typeof globalThis;
    try {run();} finally {globalThis.window=before;}
    return events;
}

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
test('office tabs use one name per place and never the old short labels',()=>{
    for(const tool of ['documents','sheets','present','audience'] as const){
        mobileTabQueue.unregisterAddonTab(workspaceTabId(tool));
        captureNavigation(()=>openWorkspace(tool));
        const spec=get(mobileTabQueue.addonTabs).find(tab=>tab.id===`workspace-${tool}`);
        expect(spec).toEqual({id:`workspace-${tool}`,label:OFFICE_TAB_LABEL[tool],shortLabel:OFFICE_TAB_LABEL[tool]});
    }
    expect(OFFICE_TAB_LABEL).toEqual({documents:'Documents',sheets:'Sheets',present:'Present',audience:'Presentation'});
});
test('ensureWorkspaceTab registers an absent tab once without navigating or activating it',()=>{
    mobileTabQueue.unregisterAddonTab('workspace-sheets');
    mobileTabQueue.setActiveChannel('general');
    const before=get(targets);
    const events=captureNavigation(()=>{
        expect(ensureWorkspaceTab('sheets')).toBe('workspace-sheets');
        expect(ensureWorkspaceTab('sheets')).toBe('workspace-sheets');
    });
    expect(events).toHaveLength(0);
    expect(get(mobileTabQueue.activeTabId)).toBe('channel:general');
    expect(get(mobileTabQueue.addonTabs).filter(tab=>tab.id==='workspace-sheets')).toHaveLength(1);
    // Registration is not a navigation target: an editor keeps whatever it last opened.
    expect(get(targets)).toBe(before);
});
test('a joined presentation (audience) resolves to the Present view',()=>{
    expect(OFFICE_TOOL_VIEW).toEqual({documents:'documents',sheets:'sheets',present:'present',audience:'present'});
    const navigation=createWorkspaceNavigation({
        addonIds:{notifications:'notifications',reader:'reader',model:'model-viewport',map:'server-map',media:'media-albums',planner:'planner',notes:'notes',lore:'lore',files:'files',
            documents:workspaceTabId('documents'),sheets:workspaceTabId('sheets'),present:workspaceTabId('present')},
        addonAliases:{[workspaceTabId('audience')]:OFFICE_TOOL_VIEW.audience},
        ensureAddonTab:view=>{if(view==='documents'||view==='sheets'||view==='present')ensureWorkspaceTab(view);},
        queue:mobileTabQueue,channel:writable('general'),voice:writable(false),surface:writable<'messages'|'whiteboard'>('messages'),setSurface:()=>{}
    });
    captureNavigation(()=>openWorkspace('audience',{sessionId:'room'}));
    expect(get(mobileTabQueue.activeTabId)).toBe('addon:workspace-audience');
    expect(workspaceToolFromTab(get(mobileTabQueue.activeTabId))).toBe('audience');
    expect(get(navigation.activeView)).toBe('present');
    captureNavigation(()=>openWorkspace('documents'));
    expect(get(navigation.activeView)).toBe('documents');
    // The folio path: registering through the bridge, opening once, no second navigation.
    mobileTabQueue.unregisterAddonTab('workspace-present');
    const events=captureNavigation(()=>navigation.select('present'));
    expect(events).toHaveLength(0);
    expect(get(mobileTabQueue.activeTabId)).toBe('addon:workspace-present');
    expect(workspaceToolFromTab(get(mobileTabQueue.activeTabId))).toBe('present');
    expect(get(navigation.activeView)).toBe('present');
});
