import { expect, mock, test } from 'bun:test';
import { get, writable } from 'svelte/store';
mock.module('$lib/notes/scope', () => ({ notebookOwner:writable({owner:null}),captureNotebookOwner:async()=>({scopeId:'account',isCurrent:()=>true}) }));
mock.module('$lib/serverUrl', () => ({getServerUrl:()=> 'https://community.test',activeServerUrl:writable('https://community.test')}));
mock.module('$lib/authSession', () => ({getAuthToken:()=> 'token',onAuthSessionCleared:()=>()=>{}}));
const { openWorkspace, targets, workspaceToolFromTab, ensureWorkspaceTab, enterWorkspaceTab, workspaceTabId, OFFICE_TOOL_VIEW, OFFICE_TAB_LABEL } = await import('./bridge');
const { mobileTabQueue } = await import('../mobileTabQueue');
const { createWorkspaceNavigation } = await import('../workspaceNavigation');

/** The app's wiring (workspaceNavigationState.ts) over the real bridge and queue. */
function officeNavigation(){
    return createWorkspaceNavigation({
        addonIds:{notifications:'notifications',reader:'reader',model:'model-viewport',map:'server-map',media:'media-albums',planner:'planner',notes:'notes',lore:'lore',files:'files',
            documents:workspaceTabId('documents'),sheets:workspaceTabId('sheets'),present:workspaceTabId('present')},
        addonAliases:{[workspaceTabId('audience')]:OFFICE_TOOL_VIEW.audience},
        prepareAddonTab:view=>{if(view==='documents'||view==='sheets'||view==='present')enterWorkspaceTab(view);},
        queue:mobileTabQueue,channel:writable('general'),voice:writable(false),surface:writable<'messages'|'whiteboard'>('messages'),setSurface:()=>{}
    });
}
const readerHandoff={source:{title:'Field notes',content:'Private Reader text',format:'markdown',sourceKey:'reader:notes'},shareMode:'live' as const};

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
    // Registration alone leaves targets alone; the nav entry is enterWorkspaceTab.
    expect(get(targets)).toBe(before);
});
test('enterWorkspaceTab clears only that tool’s one-shot handoff and registers without navigating',()=>{
    captureNavigation(()=>{openWorkspace('documents',readerHandoff);openWorkspace('present',{source:readerHandoff.source});});
    mobileTabQueue.unregisterAddonTab('workspace-documents');
    mobileTabQueue.setActiveChannel('general');
    const events=captureNavigation(()=>expect(enterWorkspaceTab('documents')).toBe('workspace-documents'));
    expect(events).toHaveLength(0);
    expect(get(mobileTabQueue.activeTabId)).toBe('channel:general');
    expect(get(mobileTabQueue.addonTabs).filter(tab=>tab.id==='workspace-documents')).toHaveLength(1);
    expect(get(targets).documents).toEqual({});
    expect(get(targets).present).toEqual({source:readerHandoff.source});
});
test('entering an office view from the nav never replays the last handoff, and re-selecting keeps an open editor',()=>{
    const navigation=officeNavigation();
    // A Reader "share" handoff opens Documents with a share dialog preset; the user moves on.
    captureNavigation(()=>openWorkspace('documents',readerHandoff));
    expect(get(targets).documents).toBe(readerHandoff);
    navigation.select('messages');
    // Choosing Documents again mounts a new editor: it must open the library, not the handoff.
    const events=captureNavigation(()=>navigation.select('documents'));
    expect(events).toHaveLength(0);
    expect(get(mobileTabQueue.activeTabId)).toBe('addon:workspace-documents');
    expect(get(targets).documents).toEqual({});
    // Already in Documents: nothing is reset, so the open editor keeps its document.
    captureNavigation(()=>openWorkspace('documents',{id:'artifact'}));
    const opened=get(targets).documents;
    navigation.select('documents');
    expect(get(targets).documents).toBe(opened);
    // Present and Sheets behave the same way (no import preview or stale artifact on entry).
    for(const tool of ['present','sheets'] as const){
        captureNavigation(()=>openWorkspace(tool,tool==='present'?{source:readerHandoff.source}:{id:'sheet-artifact'}));
        navigation.select('messages');
        navigation.select(tool);
        expect(get(targets)[tool]).toEqual({});
    }
});
test('a joined presentation (audience) resolves to the Present view',()=>{
    expect(OFFICE_TOOL_VIEW).toEqual({documents:'documents',sheets:'sheets',present:'present',audience:'present'});
    const navigation=officeNavigation();
    captureNavigation(()=>openWorkspace('audience',{sessionId:'room'}));
    expect(get(mobileTabQueue.activeTabId)).toBe('addon:workspace-audience');
    expect(workspaceToolFromTab(get(mobileTabQueue.activeTabId))).toBe('audience');
    expect(get(navigation.activeView)).toBe('present');
    // Choosing Present while in the room keeps the room and its session target.
    const room=get(targets).audience;
    navigation.select('present');
    expect(get(mobileTabQueue.activeTabId)).toBe('addon:workspace-audience');
    expect(get(targets).audience).toBe(room);
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
