import assert from 'node:assert/strict';
import {waitForState,verifyStateWaiter} from './office-state-wait.mjs';
import {compatibilityFixtures} from './office-compatibility-fixtures.mjs';
import {nativeCanvasAcceptance} from './office-native-canvas-acceptance.mjs';
import {documentRecoveryAcceptance} from './office-document-acceptance.mjs';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {svelte} from '@sveltejs/vite-plugin-svelte';
import {chromium,firefox} from 'playwright';

// Real editors, IndexedDB and Authority API; only identity/bootstrap and shell
// navigation are adapted. Relative imports must resolve to the same identity
// adapter as $lib aliases (the addon loader imports ../serverUrl).
const frontend=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const host=JSON.parse(await readFile(path.join(process.env.WABI_WORKSPACE_E2E_DIR||'','host.json'),'utf8'));
assert.equal(new URL(host.authorityUrl).hostname,'127.0.0.1');
const fixture=await mkdtemp(path.join(frontend,'.office-browser-'));
const artifacts=process.env.WORKSPACE_ARTIFACT_DIR||path.join(tmpdir(),'wabi-office-browser');
await mkdir(artifacts,{recursive:true});
const f=name=>path.join(fixture,name),mod=relative=>JSON.stringify(path.join(frontend,relative));
let server,browser,checks=0;const failures=[];
try {
    await verifyStateWaiter();
    await writeFile(f('environment.js'),'export const browser=true;export const dev=true;export const building=false;');
    await writeFile(f('identity.js'),`import {writable} from 'svelte/store';
        export const accounts=${JSON.stringify(host.accounts)};
        export const account=accounts[Number(new URLSearchParams(location.search).get('account')||0)];
        export const owner={scopeId:'acceptance:'+account.id,isCurrent:()=>true};
        export const notebookOwner=writable({owner});export const captureNotebookOwner=async()=>owner;
        export const getServerUrl=()=>location.origin;export const activeServerUrl=writable(location.origin);
        export const getAuthToken=()=>account.token;export const getStoredDbUserId=()=>account.id;
        export const getGuestSessionId=()=>null;export const onAuthSessionCleared=()=>()=>{};
        export const serverMembers=writable(accounts.map(a=>({dbUserId:a.id,username:a.name})));
        export const currentUser=writable({dbUserId:account.id,username:account.name});
        export const currentChannel=writable('');export const channels=writable([]);export const switchChannel=id=>currentChannel.set(id);`);
    await writeFile(f('tabs.js'),`import {writable} from 'svelte/store';
        export const active=writable('addon:workspace-'+(new URLSearchParams(location.search).get('tool')||'documents'));
        export const mobileTabQueue={activeTabId:active,registerAddonTab(){},setActiveChannel(id){active.set('channel:'+id)},openAddonTab(id){active.set('addon:'+id)},unregisterAddonTab(){active.set('none')}};`);
    await writeFile(f('App.svelte'),`<script>
        import WorkspaceHost from ${mod('src/lib/workspaces/WorkspaceHost.svelte')};import {active} from './tabs.js';
        import {workspaceToolFromTab} from ${mod('src/lib/workspaces/bridge.ts')};$:tool=workspaceToolFromTab($active);
        </script>{#if tool}<WorkspaceHost {tool}/>{/if}`);
    await writeFile(f('main.js'),`import {mount} from 'svelte';import App from './App.svelte';
        import {openWorkspace,captureScope} from ${mod('src/lib/workspaces/bridge.ts')};import {account} from './identity.js';
        mount(App,{target:document.getElementById('app')});window.workspaceTest={open:openWorkspace,account,
            async records(kind){const m=await import(${mod('src/lib/workspaces/session.ts')});return m.listLocal(await captureScope(),kind);},
            async record(id){
                const m=await import(${mod('src/lib/workspaces/session.ts')});
                const r=await m.readLocal(await captureScope(),id);
                if(!r)return null;
                // Inspect committed bytes, not a live editor session: opening one
                // here could itself save or sync and invalidate durability checks.
                const doc=new m.Y.Doc();
                try{
                    if(r.update.length)m.Y.applyUpdate(doc,r.update);
                    return {id:r.id,pending:Object.keys(r.pending).length,meta:r.meta,drafts:r.drafts||{},originalName:r.original?.name,data:doc.getMap('data').toJSON()};
                }finally{doc.destroy();}
            },
            async text(id){const m=await import(${mod('src/lib/workspaces/session.ts')});const s=await m.openArtifact(await captureScope(),id,'document');const text=s.body.toString();await s.close();return text;},
            async pdfText(encoded){const pdfjs=await import('pdfjs-dist');pdfjs.GlobalWorkerOptions.workerSrc=(await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;const task=pdfjs.getDocument({data:Uint8Array.from(atob(encoded),c=>c.charCodeAt(0)),enableXfa:false,useWasm:false,useWorkerFetch:false,disableFontFace:true});try{const pdf=await task.promise;const pages=[];for(let i=1;i<=pdf.numPages;i++){const page=await pdf.getPage(i);pages.push((await page.getTextContent()).items.map(item=>item.str||'').join(' '));}return pages;}finally{await task.destroy();}},
            async api(route,body){const response=await fetch('/api/workspace'+route,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+account.token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return{status:response.status,body:await response.json()};}};`);
    await writeFile(f('tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'bundler',skipLibCheck:true}}));
    await writeFile(f('index.html'),'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#app{height:100%;width:100%;margin:0}body{font-family:system-ui;background:#161826;color:#eef0f8}</style></head><body><div id="app"></div><script type="module" src="/main.js"></script></body></html>');
    const identities=['notes/scope','serverUrl','authSession','presenceIdentity','channelStore'];
    const identityPaths=new Set(identities.map(name=>path.join(frontend,'src/lib',name)));
    const bootstrap={name:'workspace-test-bootstrap',enforce:'pre',resolveId(source,importer){
        if(source==='$app/environment')return f('environment.js');
        const normalized=(source.startsWith('$lib/')?path.join(frontend,'src/lib',source.slice(5)):source.startsWith('.')&&importer?path.resolve(path.dirname(importer.split('?')[0]),source):source).replace(/\.(?:ts|js)$/,'');
        if(identityPaths.has(normalized))return f('identity.js');
        if(normalized===path.join(frontend,'src/lib/mobileTabQueue'))return f('tabs.js');
        return null;
    }};
    const alias=identities.map(name=>({find:'$lib/'+name,replacement:f('identity.js')}));
    alias.push({find:'$app/environment',replacement:f('environment.js')},{find:'$lib/mobileTabQueue',replacement:f('tabs.js')},{find:'@wabi/workspace-sheets',replacement:path.join(frontend,'src/lib/workspaces/sheets/addon.ts')},{find:'@wabi/workspace-present',replacement:path.join(frontend,'src/lib/workspaces/present/addon.ts')},{find:'$lib',replacement:path.join(frontend,'src/lib')});
    server=await createServer({configFile:false,root:fixture,plugins:[bootstrap,svelte({configFile:false})],resolve:{dedupe:['svelte','yjs'],alias},worker:{format:'es'},define:{__WABI_WORKSPACE_PACKAGED__:JSON.stringify({sheets:true,present:true})},optimizeDeps:{rolldownOptions:{tsconfig:false}},server:{host:'127.0.0.1',port:0,fs:{allow:[frontend]},proxy:{'/api':host.authorityUrl}},logLevel:'warn'});
    await server.listen();const origin=server.resolvedUrls.local[0];
    for(const engineName of(process.env.WORKSPACE_BROWSER||'chromium').split(',')){
        browser=await(engineName==='firefox'?firefox:chromium).launch({headless:!process.env.DISPLAY,...(engineName==='chromium'?{args:['--no-sandbox']}:{})});
        const ca=await browser.newContext({viewport:{width:1440,height:1000}}),cb=await browser.newContext({viewport:{width:1200,height:900}}),cc=await browser.newContext();
        const a=await ca.newPage(),b=await cb.newPage(),c=await cc.newPage(),errors=[];
        for(const page of[a,b,c]){page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(20000);}
        try {
            await a.goto(origin+'?account=0&tool=documents');await a.getByRole('button',{name:'New document',exact:true}).click();
            await a.locator('.cm-content').click();await a.keyboard.insertText('Original shared lesson คน 🙂');
            await a.getByLabel('Document title',{exact:true}).fill('Browser document '+engineName);await a.getByLabel('Document title',{exact:true}).press('Tab');
            const records=await a.evaluate(()=>window.workspaceTest.records('document')),id=records[0].id;
            await waitForState(a,async id=>(await window.workspaceTest.record(id))?.pending>0,id);checks++;
            await a.getByRole('button',{name:'Share…',exact:true}).click();await a.getByLabel('Person',{exact:true}).selectOption(String(host.accounts[1].id));await a.getByRole('button',{name:'Add person',exact:true}).click();
            await a.getByRole('button',{name:'Publish and save sharing',exact:true}).click();await a.locator('dialog[open]').waitFor({state:'hidden'});checks++;
            await b.goto(origin+'?account=1&tool=documents');await b.waitForFunction(()=>!!window.workspaceTest);await b.evaluate(id=>window.workspaceTest.open('documents',{id}),id);
            await b.waitForFunction(()=>document.querySelector('.cm-content')?.textContent?.includes('Original shared lesson'));checks++;
            await ca.setOffline(true);await a.locator('.cm-content').click();await a.keyboard.press('Control+End');await a.keyboard.insertText(' — Alice offline');await waitForState(a,async id=>(await window.workspaceTest.record(id))?.pending>0,id);checks++;
            await b.locator('.cm-content').click();await b.keyboard.press('Control+End');await b.keyboard.insertText(' — Bob online');await waitForState(b,async id=>(await window.workspaceTest.record(id))?.pending===0,id);
            await ca.setOffline(false);await a.waitForFunction(()=>document.querySelector('.cm-content')?.textContent?.includes('Bob online'));await b.waitForFunction(()=>document.querySelector('.cm-content')?.textContent?.includes('Alice offline'));
            assert.equal(await a.evaluate(id=>window.workspaceTest.text(id),id),await b.evaluate(id=>window.workspaceTest.text(id),id));checks++;
            await a.reload();await a.waitForFunction(()=>!!window.workspaceTest);await a.evaluate(id=>window.workspaceTest.open('documents',{id}),id);await a.waitForFunction(()=>document.querySelector('.cm-content')?.textContent?.includes('Alice offline'));checks++;
            await c.goto(origin+'?account=2&tool=audience');await c.waitForFunction(()=>!!window.workspaceTest);const denied=await c.evaluate(id=>window.workspaceTest.api(`/artifacts/${id}/sync`,{vector:''}),id);assert.equal(denied.status,404);checks++;
            await waitForState(a,async id=>(await window.workspaceTest.record(id))?.pending===0,id);
            await a.evaluate(()=>{window.workspaceWrites=0;const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){if(this.name==='artifacts')window.workspaceWrites++;return put.apply(this,args);};});
            await a.waitForTimeout(3600);assert.equal(await a.evaluate(()=>window.workspaceWrites),0,'Idle sync must not rewrite the entire document');checks++;
            await a.screenshot({path:path.join(artifacts,`${engineName}-documents.png`)});
            await a.evaluate(()=>window.workspaceTest.open('sheets'));await a.getByRole('button',{name:'Enable addon',exact:true}).click();await a.getByRole('button',{name:'New spreadsheet',exact:true}).click();
            const formula=a.getByLabel('Cell value or formula',{exact:true});await formula.fill('12');await formula.press('Enter');await a.locator('.sheet-grid').press('ArrowRight');await formula.fill('=A1*2');await formula.press('Enter');await a.waitForFunction(()=>Array.from(document.querySelectorAll('.sheet-grid td')).some(element=>element.textContent==='24'));checks++;
            await a.screenshot({path:path.join(artifacts,`${engineName}-sheets.png`)});
            await a.evaluate(()=>window.workspaceTest.open('present'));await a.getByRole('button',{name:'Enable addon',exact:true}).click();
            if(process.env.WORKSPACE_OFFICE_CONVERTER_TEST==='1'){
                for(const fixture of await compatibilityFixtures()){
                    let uploads=0;const track=request=>{if(request.url().endsWith('/api/workspace/conversion')&&request.method()==='POST')uploads++;};a.on('request',track);
                    await a.locator('input[type="file"]').first().setInputFiles({name:fixture.name,mimeType:fixture.mimeType,buffer:fixture.buffer});
                    await a.getByRole('heading',{name:'Convert a PowerPoint or OpenDocument presentation',exact:true}).waitFor();
                    assert.equal(uploads,0,'Selecting an Office file must not upload it');checks++;
                    const converting=a.waitForResponse(response=>response.url().endsWith('/api/workspace/conversion')&&response.request().method()==='POST');
                    await a.getByRole('button',{name:'Upload original for static conversion',exact:true}).click();
                    const converted=await converting;const output=await converted.json();assert.equal(converted.status(),200,JSON.stringify(output));
                    const pages=await a.evaluate(pdf=>window.workspaceTest.pdfText(pdf),output.pdf);
                    assert.equal(pages.length,1);assert(pages[0].includes(fixture.expected));assert(!pages.join('').includes('PRIVATE_'));checks++;
                    await a.getByRole('button',{name:'Create private deck',exact:true}).click();
                    await a.getByLabel('Slide title',{exact:true}).waitFor();
                    const records=await a.evaluate(()=>window.workspaceTest.records('present'));const imported=records.find(item=>item.title===fixture.name);
                    assert(imported);assert.equal((await a.evaluate(id=>window.workspaceTest.record(id),imported.id)).originalName,fixture.name);checks++;
                    await a.getByRole('button',{name:'Library',exact:true}).click();a.off('request',track);
                }
            }
            checks+=await nativeCanvasAcceptance(a,b,host.accounts,artifacts,engineName);
            await a.getByRole('button',{name:'New presentation',exact:true}).click();
            await a.getByLabel('Slide title',{exact:true}).fill('Visible first slide');await a.getByLabel('Private speaker notes',{exact:true}).fill('PRIVATE_NOTES_MUST_NEVER_REACH_AUDIENCE');
            await a.getByRole('button',{name:'Add',exact:true}).click();await a.getByLabel('Slide title',{exact:true}).fill('HIDDEN_SLIDE_MUST_NEVER_REACH_AUDIENCE');await a.getByRole('button',{name:'Hide from audience',exact:true}).click();
            await a.getByRole('button',{name:'Add',exact:true}).click();await a.getByLabel('Slide title',{exact:true}).fill('Visible final slide');
            await a.getByRole('button',{name:'Share…',exact:true}).click();await a.getByLabel('Person',{exact:true}).selectOption(String(host.accounts[1].id));await a.getByLabel('Recipient permission',{exact:true}).selectOption('viewer');await a.getByRole('button',{name:'Add person',exact:true}).click();await a.getByRole('button',{name:'Publish and save sharing',exact:true}).click();await a.locator('dialog[open]').waitFor({state:'hidden'});
            const starting=a.waitForResponse(response=>response.url().endsWith('/api/workspace/presentations')&&response.request().method()==='POST');await a.getByRole('button',{name:'Present to channel…',exact:true}).click();await a.getByRole('button',{name:'Start approved presentation',exact:true}).click();
            const response=await starting;assert.equal(response.status(),200);const session=await response.json();assert.equal(session.slides.length,2);checks++;
            await b.goto(origin+'?account=1&tool=audience');await b.waitForFunction(()=>!!window.workspaceTest);const payloads=[];b.on('response',response=>{if(response.url().includes('/api/workspace/'))void response.text().then(text=>payloads.push(text)).catch(()=>{});});await b.evaluate(id=>window.workspaceTest.open('audience',{sessionId:id}),session.id);await b.getByRole('heading',{name:'Visible first slide',exact:true}).waitFor();checks++;
            const before=await b.evaluate(id=>window.workspaceTest.api(`/presentations/${id}`),session.id);const forged=await b.evaluate(({id,generation,sequence})=>window.workspaceTest.api(`/presentations/${id}`,{action:'blank',generation,sequence}),{id:session.id,generation:before.body.generation,sequence:before.body.sequence});assert.equal(forged.status,403);checks++;
            await b.getByRole('button',{name:'Browse independently',exact:true}).click();await a.getByRole('button',{name:'Next',exact:true}).click();await a.getByRole('heading',{name:'Visible final slide',exact:true}).waitFor();assert.equal(await b.getByRole('heading',{name:'Visible first slide',exact:true}).count(),1);checks++;
            await b.getByRole('button',{name:'Back to presenter',exact:true}).click();await b.getByRole('heading',{name:'Visible final slide',exact:true}).waitFor();checks++;
            await b.screenshot({path:path.join(artifacts,`${engineName}-audience.png`)});const joined=payloads.join('\n');assert(!joined.includes('PRIVATE_NOTES_MUST_NEVER_REACH_AUDIENCE'));assert(!joined.includes('HIDDEN_SLIDE_MUST_NEVER_REACH_AUDIENCE'));checks++;
            await a.getByLabel('New presenter account ID',{exact:true}).fill(String(host.accounts[1].id));await a.getByRole('button',{name:'Pass control',exact:true}).click();await b.getByRole('button',{name:'End presentation',exact:true}).waitFor();await b.getByRole('button',{name:'End presentation',exact:true}).click();await b.waitForFunction(()=>document.body.textContent.includes('Ended'));checks++;
            const ended=await b.evaluate(id=>window.workspaceTest.api(`/presentations/${id}`),session.id);assert.equal(ended.body.ended,true);assert.deepEqual(ended.body.slides,[]);checks++;
            await a.evaluate(id=>window.workspaceTest.open('documents',{id}),id);await a.locator('.cm-content').waitFor();
            await b.evaluate(id=>window.workspaceTest.open('documents',{id}),id);await b.locator('.cm-content').waitFor();
            checks+=await documentRecoveryAcceptance(a,b,c,host.accounts,id,artifacts,engineName);
            assert.deepEqual(errors,[]);checks++;console.log(`${engineName}: real-Authority editor and audience checks passed`);
        }catch(error){
            failures.push(`${engineName}: ${error.stack||error}`);
            for(const[name,page]of[['alice',a],['bob',b],['carol',c]]){await page.screenshot({path:path.join(artifacts,`${engineName}-failure-${name}.png`)}).catch(()=>{});console.error(`${engineName}/${name}: `+(await page.locator('body').innerText().catch(()=>'' )).slice(0,6000));}
            console.error('Page errors: '+JSON.stringify(errors));
        }finally{await browser.close();browser=null;}
    }
    await writeFile(path.join(artifacts,'browser-results.json'),JSON.stringify({checks,failures,headful:Boolean(process.env.DISPLAY)},null,2));
    console.log(`Office browser checks completed: ${checks}`);assert.deepEqual(failures,[]);
}finally{await browser?.close();await server?.close();await rm(fixture,{recursive:true,force:true});}
