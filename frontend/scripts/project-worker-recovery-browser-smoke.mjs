// Real headful rendering of candidate components; fixture HTTP/account data.
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {mkdir,writeFile} from 'node:fs/promises';
import {createServer} from 'vite';
import {svelte} from '@sveltejs/vite-plugin-svelte';
import {chromium} from 'playwright';
const root=fileURLToPath(new URL('../',import.meta.url));
const out=fileURLToPath(new URL('../../docs/testing/screenshots/2026-09-30-worker-recovery/',import.meta.url));
const ids=['aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb','cccccccc-cccc-4ccc-cccc-cccccccccccc'];
const server=await createServer({root,configFile:false,resolve:{alias:{$lib:root+'src/lib'}},server:{host:'127.0.0.1',port:0,fs:{allow:[root]}},plugins:[svelte({configFile:false}),{
 name:'recovery-fixtures',enforce:'pre',resolveId(id,importer){
  if(id==='$app/environment')return '\0recovery-environment';
  const resolved=id.startsWith('.')&&importer?fileURLToPath(new URL(id,`file://${importer}`)):id;
  const name=resolved.replace(root+'src/lib/','$lib/').replace(/\.ts$/,'');
  if(['$lib/authSession','$lib/serverUrl','$lib/presenceIdentity','$lib/api/channelAccess'].includes(name))return '\0recovery-'+name;
 },load(id){
  if(id==='\0recovery-environment')return 'export const browser=true;export const dev=true;export const building=false;';
  if(id==='\0recovery-$lib/authSession')return 'const listeners=new Set();window.__clearAuth=()=>{window.__token="changed";for(const fn of listeners)fn()};export const getAuthToken=()=>window.__token||"fixture-token";export const onAuthSessionCleared=fn=>{listeners.add(fn);return()=>listeners.delete(fn)};';
  if(id==='\0recovery-$lib/serverUrl')return 'export const getServerUrl=()=>location.origin;';
  if(id==='\0recovery-$lib/presenceIdentity')return 'import {writable} from "svelte/store";export const currentUser=writable({highestRole:"owner"});';
  if(id==='\0recovery-$lib/api/channelAccess')return 'export const fetchChannel=(channel,url,options)=>fetch(url,options);';
 },configureServer(vite){vite.middlewares.use((req,res,next)=>{if(!req.url?.startsWith('/__worker_recovery'))return next();res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><title>Wabi worker recovery candidate</title><style>body{margin:0;background:#13151d;font:16px system-ui}#harness{height:100vh}</style></head><body><div id="harness"></div><script type="module" src="/test/project-worker-recovery-browser-harness.ts"></script></body></html>');});}
}]});
let browser,page;const requests=[];const errors=[];
let run={runId:'run_fixture',botUserId:2,createdByUserId:1,mode:'work',prompt:'Continue the saved task',reply:'',status:'running',revision:3,attempt:1,leaseUntilMicros:1,provider:'example.invalid',model:'chosen-model',checkpoint:'One step saved',workerId:ids[0],targetWorkerId:ids[0],pending:null,steps:[{operationId:'step_fixture',tool:'create_card',arguments:{title:'Saved card'},result:{taskId:'fixture_card'}}]};
try{
 await server.listen();await mkdir(out,{recursive:true});browser=await chromium.launch({headless:false,...(process.env.WABI_BROWSER_EXECUTABLE?{executablePath:process.env.WABI_BROWSER_EXECUTABLE}:{})});
 page=await browser.newPage({viewport:{width:1100,height:960}});page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/**',async route=>{
  const request=route.request(),path=new URL(request.url()).pathname,method=request.method();
  if(!path.startsWith('/api/'))return route.fallback();
  const body=method==='POST'?request.postDataJSON():null;requests.push({path,method,body});
  const now=Date.now()*1000;
  let data=path.endsWith('/workers')?{enabled:true,serverNowMicros:now,contactWindowMicros:180_000_000,workers:ids.map((workerId,i)=>({workerId,name:['Laptop','Desktop','Studio'][i],botUserId:2,harness:'api_worker',provider:'example.invalid',model:'chosen-model',lastSeenMicros:i===0?1:now,canRemove:true}))}:path.endsWith('/members')?{members:[{id:1,name:'Owner',isBot:false},{id:2,name:'Project worker',isBot:true}]}:path.endsWith('/runs')?{runs:[run]}:{};
  if(path.endsWith('/control')){run={...run,status:'queued',revision:4,targetWorkerId:body.workerId};data=run;}
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
 });
 const base=`http://127.0.0.1:${server.httpServer.address().port}/__worker_recovery`;
 await page.goto(base);await page.getByRole('heading',{name:'Laptop',exact:true}).waitFor();
 assert.equal(await page.getByText('Contact lost',{exact:true}).count(),1);assert.equal(await page.getByText('example.invalid / chosen-model',{exact:true}).count(),3);
 await page.screenshot({path:out+'connections-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:out+'connections-mobile.png',fullPage:true});
 await page.setViewportSize({width:1100,height:960});await page.goto(base+'?view=assistant');
 await page.getByRole('button',{name:'Resume saved work',exact:true}).waitFor();
 await page.getByLabel('Resume computer for Continue the saved task').selectOption(ids[1]);await page.getByRole('button',{name:'Resume saved work',exact:true}).click();
 assert(requests.some(r=>r.path.endsWith('/control')&&r.body.action==='resume'&&r.body.workerId===ids[1]&&r.body.expectedRevision===3));
 await page.getByLabel('Worker computer',{exact:true}).selectOption(ids[1]);
 const automatic=page.getByRole('checkbox',{name:/Allow one automatic recovery/});assert.equal(await automatic.isChecked(),false);await automatic.check();
 await page.getByRole('checkbox',{name:/Studio/}).check();await page.getByLabel('Your request').fill('Disposable recovery request');
 await page.getByRole('checkbox',{name:/Send this request/}).check();await page.getByRole('button',{name:'Send request',exact:true}).click();
 const sent=requests.find(r=>r.path.endsWith('/runs')&&r.method==='POST');assert.equal(sent.body.workerId,ids[1]);assert.deepEqual(sent.body.recoveryPolicy,{automatic:true,backupWorkerIds:[ids[2]],maxRecoveries:1});
 await page.screenshot({path:out+'assistant-recovery-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:out+'assistant-recovery-mobile.png',fullPage:true});
 await page.goto(base);await page.getByRole('heading',{name:'Laptop',exact:true}).waitFor();await page.evaluate(()=>window.__clearAuth());assert.equal(await page.getByRole('heading',{name:'Laptop',exact:true}).count(),0);
 assert.deepEqual(errors,[]);
 const report={passed:true,checks:['Project-scoped worker roster','contact loss distinct from online claim','reported harness and model','explicit resume target','automatic recovery off by default','chosen backup and one-recovery policy','account-change clears roster','desktop/mobile no horizontal overflow'],limits:['fixture HTTP/account boundaries','not deployed','not a native Codex worker']};await writeFile(out+'browser-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){console.error(JSON.stringify({errors,requests,body:await page?.locator('body').innerText().catch(()=>null)}));throw error;}
finally{await browser?.close();await server.close();}
