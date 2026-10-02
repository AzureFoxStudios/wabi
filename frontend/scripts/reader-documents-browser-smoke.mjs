import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { chromium } from 'playwright';

// Production local Reader and production workspace bridge. This test stops at
// the navigation handoff; office-workspace-browser-smoke tests the real server.
const frontend=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const fixture=await mkdtemp(path.join(frontend,'.reader-documents-smoke-'));
const artifacts=process.env.READER_ARTIFACT_DIR||path.join(tmpdir(),'wabi-reader-artifacts');
await mkdir(artifacts,{recursive:true});
const file=relative=>JSON.stringify(path.join(fixture,relative));
let server,browser;
try {
    for(const relative of [
        'src/lib/components/ReaderTab.svelte','src/lib/components/ReaderDocumentWorkbench.svelte',
        'src/lib/components/ReaderTabImpl.svelte','src/lib/components/ReaderImportSheet.svelte',
        'src/lib/components/ReaderIcon.svelte','src/lib/components/readerTabHelpers.ts',
        'src/lib/components/readerDocumentTools.ts','src/lib/components/readerCode.css',
        'src/lib/readerWorkspace.ts','src/lib/readerDocuments.ts','src/lib/readerDocumentScope.ts',
        'src/lib/readerLibrary.ts','src/lib/readerCode.ts','src/lib/prism.ts',
        'src/lib/workspaces/bridge.ts','src/lib/workspaces/WorkspaceShortcuts.svelte',
        'src/styles/components/reader-tab.css'
    ]) {
        await mkdir(path.dirname(path.join(fixture,relative)),{recursive:true});
        await copyFile(path.join(frontend,relative),path.join(fixture,relative));
    }
    await writeFile(path.join(fixture,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'bundler',skipLibCheck:true}}));
    await writeFile(path.join(fixture,'environment.js'),'export const browser=true;export const dev=true;export const building=false;');
    await writeFile(path.join(fixture,'tabQueue.js'),'export const mobileTabQueue={registerAddonTab(){},openAddonTab(id){window.readerOpenedTab=id;}};');
    await writeFile(path.join(fixture,'channelStore.js'),`import {writable} from 'svelte/store';export const currentChannel=writable('general');export const channels=writable([]);`);
    await writeFile(path.join(fixture,'loreWorkspace.js'),'export const openLoreSurface=()=>{};');
    await writeFile(path.join(fixture,'serverUrl.js'),`import {writable,get} from 'svelte/store';export const activeServerUrl=writable('https://one.example');export const getServerUrl=()=>get(activeServerUrl);`);
    await writeFile(path.join(fixture,'presenceIdentity.js'),`import {writable} from 'svelte/store';export const currentUser=writable({dbUserId:7});`);
    await writeFile(path.join(fixture,'authSession.js'),`
        let storedDbUserId=7;export const getAuthToken=()=> 'token';export const getGuestSessionId=()=>null;
        export const getStoredDbUserId=()=>storedDbUserId;export const setStoredTestDbUserId=id=>{storedDbUserId=id;};export const onAuthSessionCleared=()=>()=>{};
    `);
    // No Notes source is used in this chat-source fixture. A mistaken Notes
    // lookup fails explicitly rather than accidentally constructing real storage.
    await writeFile(path.join(fixture,'notesScope.js'),`import {writable} from 'svelte/store';export const notebookOwner=writable({owner:null});export const captureNotebookOwner=async()=>{throw new Error('Unexpected Notes-owner lookup in Reader handoff test');};`);
    await writeFile(path.join(fixture,'notesDb.js'),`export class LocalNotebook{constructor(){throw new Error('Unexpected Notes database access');}}`);
    await writeFile(path.join(fixture,'notesBridge.js'),`export const parseReaderNoteSource=()=>null;`);
    await writeFile(path.join(fixture,'notesWorkspace.js'),`export const openNotesSurface=()=>{throw new Error('Unexpected Notes navigation');};`);
    await writeFile(path.join(fixture,'main.js'),`
        import {mount} from 'svelte';import {get} from 'svelte/store';
        import Reader from ${file('src/lib/components/ReaderTab.svelte')};
        import ${file('src/styles/components/reader-tab.css')};
        import {openReaderDocument,readerSelection,updateReaderPreferences} from ${file('src/lib/readerWorkspace.ts')};
        import {readerDocuments,readerDocumentSaveState,readerDocumentConflicts,readerDocumentScope} from ${file('src/lib/readerDocuments.ts')};
        import {targets} from ${file('src/lib/workspaces/bridge.ts')};
        import {currentUser} from ${file('presenceIdentity.js')};import {activeServerUrl} from ${file('serverUrl.js')};import {setStoredTestDbUserId} from ${file('authSession.js')};
        updateReaderPreferences({theme:'paper',fontSize:18});mount(Reader,{target:document.getElementById('app')});
        const openSource=(sourceId,title,content)=>openReaderDocument(title,content,'markdown','chat',undefined,sourceId);
        openSource('message-1','Class notes','# Lesson\\n\\nOriginal line for Timmy.');
        window.readerDocTest={
            state(){const selection=get(readerSelection),docs=Object.values(get(readerDocuments));const doc=selection?docs.find(candidate=>candidate.documentId===selection.documentId||candidate.sourceDocKey===selection.sourceDocKey)||null:null;
                return {selection,doc,count:docs.length,docs,scope:get(readerDocumentScope),save:doc?get(readerDocumentSaveState)[doc.documentId]:null,conflict:doc?get(readerDocumentConflicts)[doc.documentId]||null:null,targets:get(targets)};},
            openSource,setUser(id){setStoredTestDbUserId(id);currentUser.set({dbUserId:id});},setServer(url){activeServerUrl.set(url);}
        };
    `);
    await writeFile(path.join(fixture,'index.html'),'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#app{height:100%;width:100%;margin:0}body{background:#101221;font-family:system-ui}:root{--text-secondary:#d8dbea;--surface-base:#e7e1d2;--text-warning:#ffcc44;--font-sans:system-ui;--accent:#7774e7}</style></head><body><div id="app"></div><script type="module" src="/main.js"></script></body></html>');
    const overrides={ '$app/environment':'environment.js','$lib/mobileTabQueue':'tabQueue.js','$lib/channelStore':'channelStore.js','$lib/loreWorkspace':'loreWorkspace.js','$lib/serverUrl':'serverUrl.js','$lib/presenceIdentity':'presenceIdentity.js','$lib/authSession':'authSession.js','$lib/notes/scope':'notesScope.js','$lib/notes/db':'notesDb.js','$lib/notes/readerBridge':'notesBridge.js','$lib/notesWorkspace':'notesWorkspace.js'};
    server=await createServer({configFile:false,root:fixture,plugins:[svelte({configFile:false})],resolve:{dedupe:['svelte'],alias:[...Object.entries(overrides).map(([find,name])=>({find,replacement:path.join(fixture,name)})),{find:'$lib',replacement:path.join(fixture,'src/lib')}]},optimizeDeps:{rolldownOptions:{tsconfig:false}},server:{host:'127.0.0.1',port:0,fs:{allow:[frontend]}},logLevel:'warn'});
    await server.listen();const origin=server.resolvedUrls.local[0];
    browser=await chromium.launch({headless:false,executablePath:process.env.READER_CHROMIUM_PATH,args:['--no-sandbox']});
    const context=await browser.newContext({viewport:{width:1440,height:960},colorScheme:'dark',reducedMotion:'reduce'});
    await context.route('**/*',route=>new URL(route.request().url()).origin===new URL(origin).origin?route.continue():route.abort());
    const page=await context.newPage(),pageErrors=[];let uploads=0;
    page.on('pageerror',error=>pageErrors.push(error.message));page.on('request',request=>{if(request.url().includes('/api/workspace'))uploads++;});
    await page.goto(origin);await page.waitForFunction(()=>!!window.readerDocTest&&window.readerDocTest.state().scope.includes('user:7'));
    await page.getByRole('heading',{name:'Lesson',exact:true}).waitFor();
    assert.match(await page.locator('.reader-document-bar').innerText(),/Source unchanged/);
    await page.getByRole('button',{name:'Edit',exact:true}).click();await page.getByLabel('Document content').waitFor();
    let state=await page.evaluate(()=>window.readerDocTest.state());
    assert.equal(state.doc.kind,'working-copy');assert.equal(state.doc.shareState,'private');assert.equal(state.doc.sourceDocKey,'chat:message-1');assert.match(state.doc.scopeId,/user:7/);assert.equal(state.doc.originalContent,'# Lesson\n\nOriginal line for Timmy.');
    await page.getByLabel('Document content').fill('# Lesson\n\nEdited locally for Timmy.');
    await page.waitForFunction(()=>document.querySelector('.reader-document-body')?.textContent?.includes('Edited locally for Timmy.'));
    await page.waitForFunction(()=>window.readerDocTest.state().save==='saved');state=await page.evaluate(()=>window.readerDocTest.state());
    assert.match(state.doc.content,/Edited locally/);assert.equal(state.doc.originalContent,'# Lesson\n\nOriginal line for Timmy.');
    await page.screenshot({path:path.join(artifacts,'reader-documents-edit.png'),animations:'disabled'});
    await page.reload();await page.waitForFunction(()=>!!window.readerDocTest&&window.readerDocTest.state().scope.includes('user:7'));
    await page.getByRole('heading',{name:'Lesson',exact:true}).waitFor();await page.waitForFunction(()=>!!window.readerDocTest.state().doc);
    assert.match(await page.locator('.reader-document-bar').innerText(),/Local draft/);
    await page.getByRole('button',{name:'Edit',exact:true}).click();assert.match(await page.getByLabel('Document content').inputValue(),/Edited locally/);
    await page.getByRole('button',{name:'Read',exact:true}).click();await page.getByRole('button',{name:'Save as Wabi Document',exact:true}).click();
    await page.waitForFunction(()=>window.readerDocTest.state().selection?.source==='document');state=await page.evaluate(()=>window.readerDocTest.state());
    assert.equal(state.doc.kind,'native');assert.equal(state.selection.documentId,state.doc.documentId);
    await page.getByRole('button',{name:/^Suggest/}).click();await page.getByLabel('Document content').fill('# Lesson\n\nProposed wording only.');
    await page.waitForFunction(()=>document.querySelector('.reader-document-body')?.textContent?.includes('Proposed wording only.'));
    state=await page.evaluate(()=>window.readerDocTest.state());assert.match(state.doc.content,/Edited locally/);assert.equal(state.doc.suggestions.filter(item=>item.status==='open').length,1);
    await page.locator('.reader-suggestion-actions').getByRole('button',{name:'Reject',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.reader-document-body')?.textContent?.includes('Edited locally for Timmy.'));
    await page.getByRole('button',{name:/^Comment/}).click();await page.getByPlaceholder('Add a comment about this document…').fill('Ask Timmy why this line changed.');await page.getByRole('button',{name:'Add comment',exact:true}).click();assert.match(await page.locator('.reader-comments-pane').innerText(),/Ask Timmy why this line changed/);
    await page.getByRole('button',{name:'Resolve',exact:true}).click();assert.match(await page.locator('.reader-comments-pane').innerText(),/Resolved/);
    await page.getByRole('button',{name:'Read',exact:true}).click();await context.setOffline(true);await page.getByRole('button',{name:'Edit',exact:true}).click();await page.getByLabel('Document content').fill('# Lesson\n\nStill editable with no network.');
    await page.waitForFunction(()=>window.readerDocTest.state().save==='saved');assert.match(await page.locator('.reader-document-bar').innerText(),/Offline/);state=await page.evaluate(()=>window.readerDocTest.state());assert.match(state.doc.content,/Still editable with no network/);await context.setOffline(false);
    // The source remains private, but Share now hands its saved revision to the
    // real bridge. Do not regress this into the former notice-only behavior.
    await page.getByRole('button',{name:'Share',exact:true}).click();await page.waitForFunction(()=>window.readerDocTest.state().targets.documents?.shareMode==='snapshot');
    state=await page.evaluate(()=>window.readerDocTest.state());assert.equal(state.targets.documents.source.content,state.doc.content);assert.equal(state.targets.documents.source.title,state.doc.title);assert.match(state.targets.documents.source.sourceKey,new RegExp('reader:'+state.doc.documentId));assert.equal(state.doc.shareState,'private');
    assert.equal(await page.evaluate(()=>window.readerOpenedTab),'workspace-documents');
    await page.getByRole('button',{name:'Collaborate',exact:true}).click();await page.waitForFunction(()=>window.readerDocTest.state().targets.documents?.shareMode==='live');
    await page.getByRole('button',{name:'Make presentation',exact:true}).click();await page.waitForFunction(()=>!!window.readerDocTest.state().targets.present?.source);
    state=await page.evaluate(()=>window.readerDocTest.state());assert.equal(state.targets.present.source.content,state.doc.content);assert.equal(state.doc.shareState,'private');assert.equal(uploads,0,'Reader handoff must not publish before the user confirms sharing');
    await page.evaluate(()=>window.readerDocTest.setUser(8));await page.waitForFunction(()=>window.readerDocTest.state().scope.includes('user:8')&&window.readerDocTest.state().count===0);state=await page.evaluate(()=>window.readerDocTest.state());assert.equal(state.selection,null);assert.equal(state.doc,null);
    await page.evaluate(()=>window.readerDocTest.setUser(7));await page.waitForFunction(()=>window.readerDocTest.state().scope.includes('user:7')&&window.readerDocTest.state().count===1);
    await page.evaluate(()=>window.readerDocTest.setServer('https://two.example'));await page.waitForFunction(()=>window.readerDocTest.state().scope.includes('two.example')&&window.readerDocTest.state().count===0);assert.equal((await page.evaluate(()=>window.readerDocTest.state())).selection,null);
    await page.evaluate(()=>window.readerDocTest.setServer('https://one.example'));await page.waitForFunction(()=>window.readerDocTest.state().scope.includes('one.example')&&window.readerDocTest.state().count===1);
    // Two pages in ONE browser profile verify local CAS, not network collaboration.
    await page.evaluate(()=>window.readerDocTest.openSource('race-message','Race notes','# Race\n\nOriginal race line.'));await page.getByRole('button',{name:'Edit',exact:true}).click();await page.waitForFunction(()=>window.readerDocTest.state().doc?.sourceDocKey==='chat:race-message'&&window.readerDocTest.state().save==='saved');await page.getByRole('button',{name:'Read',exact:true}).click();
    const contender=await context.newPage();contender.on('pageerror',error=>pageErrors.push('contender: '+error.message));await contender.goto(origin);await contender.waitForFunction(()=>!!window.readerDocTest&&window.readerDocTest.state().scope.includes('user:7'));
    await contender.evaluate(()=>window.readerDocTest.openSource('race-message','Race notes','# Race\n\nOriginal race line.'));await contender.getByRole('button',{name:'Edit',exact:true}).click();await contender.getByLabel('Document content').waitFor();await page.getByRole('button',{name:'Edit',exact:true}).click();await page.getByLabel('Document content').waitFor();
    await Promise.all([page.getByLabel('Document content').fill('# Race\n\nWriter A local edit.'),contender.getByLabel('Document content').fill('# Race\n\nWriter B local edit.')]);await page.waitForTimeout(550);
    const raceA=await page.evaluate(()=>window.readerDocTest.state()),raceB=await contender.evaluate(()=>window.readerDocTest.state());assert.deepEqual([raceA.save,raceB.save].sort(),['error','saved']);assert.match(raceA.doc.content,/Writer A local edit/);assert.match(raceB.doc.content,/Writer B local edit/);assert.ok((raceA.save==='error'?raceA:raceB).conflict>=1);
    await contender.close();assert.deepEqual(pageErrors,[]);console.log('Reader local durability, source preservation, sharing handoff, account isolation and local CAS passed');
} finally {
    await browser?.close().catch(()=>{});await server?.close().catch(()=>{});await rm(fixture,{recursive:true,force:true}).catch(()=>{});
}
