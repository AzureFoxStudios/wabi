/** Production-component checks. HTTP handlers below are test doubles; these
 * checks do not claim Authority authorization or restart verification. */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {svelte} from '@sveltejs/vite-plugin-svelte';
import {chromium} from 'playwright';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=await mkdtemp(path.join(root,'.workspace-smoke-')),artifacts=process.env.WORKSPACE_BROWSER_ARTIFACTS||path.join(tmpdir(),'wabi-workspace-browser');
let server,browser;let tests=0;
try{
 await mkdir(artifacts,{recursive:true});
 await writeFile(path.join(dir,'environment.js'),'export const browser=true;export const dev=true;export const building=false;');
 await writeFile(path.join(dir,'auth.js'),`export const getAuthToken=()=>localStorage.getItem('fixture-token')||'test-owner';export const getStoredDbUserId=()=>Number(localStorage.getItem('fixture-user')||1);export const getGuestSessionId=()=>null;`);
 await writeFile(path.join(dir,'server.js'),`import {writable} from 'svelte/store';export const getServerUrl=()=>location.origin;export const activeServerUrl=writable('');`);
 await writeFile(path.join(dir,'channel.js'),`import {writable} from 'svelte/store';export const currentChannel=writable('general');export const channels=writable([{id:'general',name:'General',type:'text'}]);`);
 await writeFile(path.join(dir,'tabs.js'),'export const mobileTabQueue={openAddonTab(){}};');
 await writeFile(path.join(dir,'Fixture.svelte'),`<script>import Host from '$lib/workspaceArtifacts/WorkspaceHost.svelte';import {workspaceSelection} from '$lib/workspaceArtifacts/navigation';</script>{#if $workspaceSelection}<Host selection={$workspaceSelection}/>{/if}`);
 await writeFile(path.join(dir,'main.js'),`import {mount} from 'svelte';import {get} from 'svelte/store';import Fixture from './Fixture.svelte';import {openWorkspace,workspaceSelection} from '$lib/workspaceArtifacts/navigation';import {listDrafts} from '$lib/workspaceArtifacts/storage';import {captureScope,ArtifactSession} from '$lib/workspaceArtifacts/client';import {initializeAddons} from '$lib/addons/loader';await initializeAddons();mount(Fixture,{target:document.getElementById('app')});window.workspaceTest={open:openWorkspace,selection:()=>get(workspaceSelection),drafts:()=>listDrafts(captureScope().key),session:()=>ArtifactSession.open(captureScope())};openWorkspace({kind:'library'});`);
 await writeFile(path.join(dir,'index.html'),`<!doctype html><html><head><meta charset="utf-8"><style>html,body,#app{margin:0;width:100%;height:100%;font:15px system-ui;background:#19212d;color:#f3f4f6}button,input,select,textarea{font:inherit}button{cursor:pointer}:root{--bg-primary:#19212d;--bg-secondary:#273345;--bg-tertiary:#121a24;--text-primary:#f3f4f6;--text-secondary:#cad2de;--border-color:#667284;--accent:#6aa3e8}</style></head><body><div id="app"></div><script type="module" src="/main.js"></script></body></html>`);
 server=await createServer({configFile:false,root:dir,plugins:[svelte({configFile:false})],define:{'import.meta.env.VITE_WABI_SHEETS':'"1"','import.meta.env.VITE_WABI_PRESENT':'"1"'},resolve:{dedupe:['svelte'],alias:[{find:'$app/environment',replacement:path.join(dir,'environment.js')},{find:'$lib/authSession',replacement:path.join(dir,'auth.js')},{find:'$lib/serverUrl',replacement:path.join(dir,'server.js')},{find:'$lib/channelStore',replacement:path.join(dir,'channel.js')},{find:'$lib/mobileTabQueue',replacement:path.join(dir,'tabs.js')},{find:'$lib',replacement:path.join(root,'src/lib')}]},optimizeDeps:{rolldownOptions:{tsconfig:false}},server:{host:'127.0.0.1',port:0,fs:{allow:[root]}},logLevel:'error'});await server.listen();
 const origin=server.resolvedUrls.local[0],records=new Map();
 browser=await chromium.launch({headless:true,executablePath:process.env.WORKSPACE_CHROMIUM||'/usr/bin/chromium',args:['--no-sandbox']});
 const context=await browser.newContext({viewport:{width:1440,height:960},permissions:['clipboard-read','clipboard-write']});
 async function mock(route){const req=route.request(),u=new URL(req.url()),p=u.pathname.replace(/^\/api\/artifacts/,'');let data={};try{data=req.postDataJSON()||{};}catch{}
  const send=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
  if(p==='/capabilities')return send({sheets:true,present:true,documents:true,canConfigure:false});
  if(p==='/people')return send({people:[{id:2,name:'Editor Two'}]});
  if(p==='/presentations')return send({presentations:[]});
  if(p==='/'||p===''){
   if(req.method()==='POST'){const a={v:1,id:data.id,kind:data.kind,ownerId:1,fields:data.fields,versions:Object.fromEntries(Object.keys(data.fields).map(k=>[k,1])),revision:1,generation:1,mode:data.mode,channelId:data.channelId,channelAccess:data.channelAccess,grants:data.grants,reviews:[],deleted:false,createdAt:1,updatedAt:1};records.set(a.id,a);return send({artifact:a,access:'owner'});}
   return send({artifacts:[],next:null});
  }
  const id=p.slice(1).split('/')[0],a=records.get(id);if(!a)return send({error:'not found'},404);
  if(req.method()==='PATCH'){for(const c of data.changes){if(c.textPatch){const chars=[...a.fields[c.key]];a.fields[c.key]=chars.slice(0,c.textPatch.start).concat([...c.textPatch.insert],chars.slice(c.textPatch.start+c.textPatch.delete)).join('');}else if(c.remove)delete a.fields[c.key];else a.fields[c.key]=c.value;a.versions[c.key]=(a.versions[c.key]||0)+1;}a.revision++;return send({artifact:a,access:'owner'});}
  if(u.searchParams.get('since')===String(a.revision))return route.fulfill({status:204});return send({artifact:a,access:'owner'});
 }
 await context.route('**/api/artifacts**',mock);
 const page=await context.newPage(),requests=[],errors=[];page.on('request',r=>requests.push(r.url()));page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin);await page.getByRole('heading',{name:'Your work, on this device and this server'}).waitFor();
 assert.ok(!requests.some(u=>/sheets\/(?:Sheets|formula|calculation)|present\/(?:Present|fileCodec)|pdfjs/.test(u)));tests++;console.log('PASS no editor engine on library startup');
 await page.getByRole('button',{name:'Enable Sheets on this device'}).click();await page.getByRole('button',{name:'New sheet',exact:true}).waitFor();assert.ok(!requests.some(u=>/sheets\/(?:Sheets|formula|calculation)/.test(u)));tests++;console.log('PASS enable registers without starting spreadsheet engine');
 await page.getByRole('button',{name:'New sheet',exact:true}).click();await page.getByLabel('Formula or cell value').waitFor();
 await page.getByLabel('Formula or cell value').fill('12');await page.getByLabel('Formula or cell value').press('Enter');
 await page.getByRole('button',{name:/^A2:/}).click();await page.getByLabel('Formula or cell value').fill('=A1*2');await page.getByLabel('Formula or cell value').press('Enter');await page.getByRole('button',{name:'A2: 24',exact:true}).waitFor();tests++;console.log('PASS grid edit and worker calculation');
 await page.screenshot({path:path.join(artifacts,'sheets.png')});
 const sheetId=await page.evaluate(async()=>{const d=await window.workspaceTest.drafts();return d.find(x=>x.kind==='sheet').id;});
 await page.getByRole('button',{name:'Library',exact:true}).click();await page.evaluate(id=>window.workspaceTest.open({kind:'sheet',id}),sheetId);await page.getByRole('button',{name:'A2: 24',exact:true}).waitFor();tests++;console.log('PASS local sheet reopen');
 await page.getByRole('button',{name:'Library',exact:true}).click();await page.getByRole('button',{name:'Enable Present on this device'}).click();await page.getByRole('button',{name:'New presentation',exact:true}).click();await page.getByRole('button',{name:'Present locally',exact:true}).waitFor();tests++;console.log('PASS independent Present addon');
 await page.screenshot({path:path.join(artifacts,'present.png')});
 await page.getByRole('button',{name:'Library',exact:true}).click();await page.getByRole('button',{name:'New document',exact:true}).click();await page.getByLabel('Shared document content').fill('Hello 😀\n\nIndependent draft');
 await page.getByRole('button',{name:'Share…',exact:true}).click();await page.getByLabel('Sharing mode').selectOption('live');await page.getByLabel('Channel',{exact:true}).selectOption('general');await page.getByLabel('I approve sending this content to the server and granting the selected access.').check();await page.getByRole('button',{name:'Share saved revision'}).click();await page.getByRole('button',{name:'Manage access'}).waitFor();
 await page.getByLabel('Shared document content').fill('Hello 😺\n\nIndependent draft');await page.waitForFunction(()=>document.body.textContent.includes('Synced to this server'));
 assert.ok([...records.values()].some(a=>a.fields.text==='Hello 😺\n\nIndependent draft'));tests++;console.log('PASS actual client share and Unicode patch against HTTP contract double');
 await page.screenshot({path:path.join(artifacts,'documents.png')});
 // Fixture is intentionally not an Authority test. Exercise editor debounce and per-window persistence under rapid edits.
 const stress=await page.evaluate(async()=>{const s=await window.workspaceTest.session();for(let i=0;i<120;i++)s.edit('text',String(i));await s.flush();await s.close();return (await window.workspaceTest.drafts()).some(d=>d.fields.text==='119');});assert.equal(stress,true);tests++;console.log('PASS coalesced persistence retains latest rapid edit');
 assert.deepEqual(errors,[]);console.log(`${tests} production-component browser scenarios passed.`);
}finally{await browser?.close();await server?.close();await rm(dir,{recursive:true,force:true});}
