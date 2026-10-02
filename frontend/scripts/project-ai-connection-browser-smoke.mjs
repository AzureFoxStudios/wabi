// Actual component in a real headful browser; HTTP and account boundaries are
// fixtures. This proves candidate rendering, not a deployed owner setup.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { chromium } from 'playwright';
const root=fileURLToPath(new URL('../',import.meta.url));
const out=fileURLToPath(new URL('../../docs/testing/screenshots/2026-09-30-codex-test/',import.meta.url));
const scratch=await mkdtemp(tmpdir()+'/wabi-connect-browser-');
const server=await createServer({root,configFile:false,resolve:{alias:{$lib:root+'src/lib'}},server:{host:'127.0.0.1',port:0,fs:{allow:[root]}},plugins:[svelte({configFile:false}),{
 name:'connection-fixtures',enforce:'pre',resolveId(id,importer){
  if(id==='$app/environment')return '\0connect-environment';
  const resolved=id.startsWith('.')&&importer?fileURLToPath(new URL(id,`file://${importer}`)):id;
  const entry=resolved.replace(root+'src/lib/','$lib/').replace(/\.ts$/,'');
  if(entry==='$lib/authSession')return '\0connect-auth';
  if(entry==='$lib/serverUrl')return '\0connect-server';
  if(entry==='$lib/presenceIdentity')return '\0connect-owner';
 },load(id){
  if(id==='\0connect-environment')return 'export const browser=true;export const dev=true;export const building=false;';
  if(id==='\0connect-auth')return 'const listeners=new Set(); window.__resetAuth=()=>{window.__token="changed";for(const fn of listeners)fn()}; export const getAuthToken=()=>window.__token||"fixture-owner-token"; export const onAuthSessionCleared=fn=>{listeners.add(fn);return()=>listeners.delete(fn)};';
  if(id==='\0connect-server')return 'export const getServerUrl=()=>location.origin;';
  if(id==='\0connect-owner')return 'import {writable} from "svelte/store"; export const currentUser=writable({highestRole:"owner"});';
 },configureServer(vite){vite.middlewares.use((req,res,next)=>{if(req.url!=='/__project_ai_connect')return next();res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><title>Wabi AI connection candidate</title><style>body{margin:0;padding:24px;background:#13151d;color:#f0f1f7;font:16px system-ui}#harness{max-width:900px;margin:auto}</style></head><body><div id="harness"></div><script type="module" src="/test/project-ai-connection-browser-harness.ts"></script></body></html>')})}
}]});
let browser;
const requests=[];
try{
 await server.listen();await mkdir(out,{recursive:true});browser=await chromium.launch({headless:false,...(process.env.WABI_BROWSER_EXECUTABLE?{executablePath:process.env.WABI_BROWSER_EXECUTABLE}:{})});
 const page=await browser.newPage({viewport:{width:1100,height:950},acceptDownloads:true});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/**',async route=>{const req=route.request(),path=new URL(req.url()).pathname;requests.push({path,method:req.method(),body:req.method()==='POST'?req.postDataJSON():null});
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(path.endsWith('/create')?{botUserId:3190,botToken:'fixture-private-bot-token'}:{})});
 });
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__project_ai_connect`);
 await page.getByRole('button',{name:/Connect Codex/}).click();
 await page.getByLabel('Connection name').fill('Ronin design chat');
 await page.getByText('Computer and workspace (optional)',{exact:true}).click();
 await page.getByLabel('Computer',{exact:true}).fill('dotRonin');await page.getByLabel('Local workspace',{exact:true}).fill('/home/ironin/wabi');
 const create=page.getByRole('button',{name:'Create Project connection'});assert.equal(await create.isDisabled(),true);
 await page.getByRole('checkbox').check();await create.click();
 await page.getByRole('status').filter({hasText:'Project access granted'}).waitFor();
 assert.deepEqual(requests.filter(r=>r.method==='POST').map(r=>r.path),['/api/bot/create','/api/bot/project-access']);
 assert.equal(requests[1].body.channelId,'ch_test');assert.equal(requests[1].body.allow,true);
 assert.equal(await page.getByText('Existing chat using Project tools',{exact:true}).count(),1);
 assert.equal(await page.getByText('dotRonin',{exact:true}).count(),1);
 const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download connection file'}).click();const download=await pending;const file=scratch+'/connection.json';await download.saveAs(file);const connection=JSON.parse(await readFile(file,'utf8'));
 assert.equal(connection.runtime.harness,'codex');assert.equal(connection.runtime.mode,'existing_harness');assert.equal(connection.runtime.computer,'dotRonin');assert.equal(connection.botToken,'fixture-private-bot-token');
 assert(!await page.locator('body').innerText().then(text=>text.includes('fixture-private-bot-token')));
 await page.getByRole('button',{name:'Check Project access'}).click();await page.getByRole('status').filter({hasText:'read access checked'}).waitFor();
 assert.equal(requests.filter(r=>r.method==='GET').length,2);
 await page.screenshot({path:out+'connection-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.screenshot({path:out+'connection-mobile.png',fullPage:true});
 await page.getByRole('button',{name:'Revoke this connection'}).click();await create.waitFor();assert.equal(requests.at(-1).path,'/api/bot/disable');
 await page.getByRole('checkbox').check();await create.click();await page.getByRole('status').waitFor();
 await page.evaluate(()=>window.__resetAuth());await create.waitFor();assert.equal(await page.getByRole('button',{name:'Download connection file'}).count(),0);
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,checks:['explicit harness and existing-chat mode','consent and scoped grant','downloaded runtime labels and private credential','read access distinguished from online chat','revoke','account-change clears connection','desktop/mobile rendering without horizontal overflow'],limits:['fixture HTTP/account boundaries','not deployed','no command forwarding or worker launch']}));
}finally{await browser?.close();await server.close();await rm(scratch,{recursive:true,force:true});}
