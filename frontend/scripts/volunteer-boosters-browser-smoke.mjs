// Real Authority + two real browser clients. Disposable loopback data only.
// Covers optional origin/peer/fallback delivery and renders the actual controls.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { createServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { chromium } from 'playwright';
const binary=resolve(process.argv[2] || '../target/debug/wabi-server');
const root=resolve('.'); const scratch=await mkdtemp(join(tmpdir(),'wabi-boost-browser-'));
const report={assertions:[],screenshots:[],pageErrors:[],measurements:{}};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
let child, browser, vite, origin, childExit;
const bootstrap=randomBytes(32).toString('hex');
async function api(path,method='GET',body,token,first=false){
    const response=await fetch(origin+path,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`} : {}),...(first?{'X-Wabi-Bootstrap-Token':bootstrap}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});
    const value=await response.json(); assert.equal(response.status,200,`${method} ${path}: ${JSON.stringify(value)}`);return value;
}
async function until(fn,label){const end=Date.now()+15000;while(Date.now()<end){if(await fn())return;await delay(100);}throw new Error(`Timed out: ${label}`);}
async function check(name,fn){await fn();report.assertions.push(name);console.log('PASS: '+name);await writeFile(join(scratch,'results.json'),JSON.stringify(report,null,2));}
const entry=`import {mount} from 'svelte'; import Card from '/src/lib/components/settings/VolunteerBoostCard.svelte'; import Infrastructure from '/src/lib/components/admin/InfrastructureCenter.svelte'; import Tailcat from '/src/lib/components/admin/TailcatPanel.svelte'; import {setConfiguredServerUrl} from '/src/lib/serverUrl.ts'; import {setAuthToken,setStoredDbUserId,setStoredUsername} from '/src/lib/authSession.ts'; import * as booster from '/src/lib/volunteerBoosters.ts'; import {get} from 'svelte/store'; import '/src/styles/tokens.css'; import {initializeTheme} from '/src/lib/theme/initTheme.ts'; await initializeTheme(false);
const fixture=window.fixtureAccount; setConfiguredServerUrl(fixture.origin,true);setAuthToken(fixture.account.accessToken,fixture.origin);setStoredDbUserId(fixture.account.user.id,fixture.origin);setStoredUsername(fixture.account.user.username,fixture.origin);window.booster=booster;window.boostStatus=()=>get(booster.boosterState);mount(fixture.kind==='admin'?Infrastructure:fixture.kind==='tailcat'?Tailcat:Card,{target:document.querySelector('#app'),props:fixture.kind==='tailcat'?{canManageAdmin:true}:{}});window.fixtureReady=true;`;
const plugin={name:'boost-fixture',enforce:'pre',resolveId(id){if(id==='/__boost.js')return '\0boost-entry';if(id==='$app/environment')return '\0boost-env';},load(id){if(id==='\0boost-entry')return entry;if(id==='\0boost-env')return 'export const browser=true,dev=true,building=false;';},configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url==='/favicon.ico'){res.statusCode=204;return res.end();}if(req.url?.split('?')[0]!=='/')return next();res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wabi volunteer booster acceptance</title><style>*{box-sizing:border-box}body{margin:0;background:var(--surface-app);color:var(--text-heading);font:16px system-ui}#app{max-width:1100px;margin:24px auto;padding:16px}button,input{font:inherit}#boundary{padding:10px;background:var(--surface-raised)}</style><div id="boundary">Disposable test community · actual UI and direct file transfers</div><main id="app"></main><script type="module" src="/__boost.js"></script>');});}};
try{
    const data=join(scratch,'data');await mkdir(data);await writeFile(join(data,'admin_policies.json'),JSON.stringify({auth_policy:{mode:'invite',allowRegister:true,allowGuest:false}}));
    const env=Object.fromEntries(['PATH','HOME','USERPROFILE','SystemRoot','TEMP','TMP'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
    Object.assign(env,{WABI_UPLOADS_DIR:join(data,'uploads'),WABI_LOG_DIR:join(scratch,'logs'),WABI_DESKTOP_BOOTSTRAP_TOKEN:bootstrap,WABI_SERVER_ROLE:'authority',WABI_MESH_ENABLED:'false'});
    child=spawn(binary,['--host','127.0.0.1','--port','0','--data-dir',data,'--desktop-managed','--print-bound-address','--shutdown-on-stdin-close'],{cwd:scratch,env,stdio:['pipe','pipe','pipe']});
    let stderr='';child.stderr.on('data',d=>{stderr+=d;});
    childExit=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));const lines=createInterface({input:child.stdout});
    const address=await Promise.race([new Promise(resolve=>lines.on('line',line=>{try{const v=JSON.parse(line);if(v.event==='wabi-listener-bound')resolve(v.address);}catch{}})),childExit.then(()=>{throw new Error('Authority exited: '+stderr);}),delay(45000).then(()=>{throw new Error('Authority startup timed out');})]);
    origin=`http://${address}`;await until(async()=>{try{return(await fetch(origin+'/readyz')).ok;}catch{return false;}},'Authority readiness');
    const owner=await api('/api/auth/register','POST',{username:'boost_owner',password:'Fixture-passphrase-47!'},undefined,true);
    async function member(username){const invitation=await api('/api/invites','POST',{expiresInHours:1},owner.accessToken);return api('/api/auth/register','POST',{username,password:'Fixture-passphrase-47!',inviteToken:invitation.token});}
    const volunteer=await member('volunteer');const recipient=await member('recipient');
    await api('/api/boosters/policy','PUT',{enabled:true},owner.accessToken);
    const channel=await api('/api/channels','POST',{name:'booster-field-fixture',channel_type:'text'},owner.accessToken);
    for(const account of [volunteer,recipient])await api(`/api/channels/${channel.id}/join`,'POST',{},account.accessToken);
    const payload=randomBytes(256*1024);const hash=createHash('sha256').update(payload).digest('hex');
    const upload=await api('/api/upload/resumable/init','POST',{fileName:'boost-fixture.bin',fileSize:payload.length,mimeType:'application/octet-stream',channelId:channel.id},owner.accessToken);
    const chunk=await fetch(`${origin}/api/upload/resumable/chunk?uploadId=${upload.uploadId}&offset=0`,{method:'PUT',headers:{authorization:`Bearer ${owner.accessToken}`,'x-upload-token':upload.uploadToken,'content-type':'application/octet-stream'},body:payload});assert.equal(chunk.status,200);
    const file=await api('/api/upload/resumable/complete','POST',{uploadId:upload.uploadId,uploadToken:upload.uploadToken},owner.accessToken);const fileUrl=new URL(file.fileUrl,origin).href;
    vite=await createServer({root,configFile:false,cacheDir:join(scratch,'vite-cache'),resolve:{alias:{$lib:join(root,'src/lib')}},plugins:[plugin,svelte({configFile:false})],server:{host:'127.0.0.1',port:0,open:false}});await vite.listen();const ui=`http://127.0.0.1:${vite.httpServer.address().port}`;
    browser=await chromium.launch({headless:false,executablePath:process.env.WABI_SMOKE_CHROMIUM_PATH||'/usr/bin/chromium-browser'});
    async function page(account,kind='member'){
        const context=await browser.newContext({viewport:{width:1080,height:1000}});
        await context.addInitScript(value=>{window.fixtureAccount=value;},{origin,account,kind});
        const p=await context.newPage();p.on('pageerror',e=>report.pageErrors.push(e.message));await p.goto(ui);await p.waitForFunction(()=>window.fixtureReady);return p;
    }
    const source=await page(volunteer);const target=await page(recipient);const admin=await page(owner,'admin');const ports=await page(owner,'tailcat');
    let originDownloads=0;let peerTickets=0;target.on('request',r=>{if(r.url()===fileUrl)originDownloads++;if(r.url()===origin+'/api/boosters/tickets')peerTickets++;});
    async function download(p){return p.evaluate(async url=>{const bytes=await(await window.booster.downloadWithBoosters(url)).arrayBuffer();const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');return {hash,size:bytes.byteLength,state:window.boostStatus()};},fileUrl);}
    await check('Origin download works with no volunteers',async()=>{const result=await download(target);assert.equal(result.hash,hash);assert.equal(originDownloads,1);});
    await check('Explicit opt-in starts a bounded volunteer; no automatic traffic claim',async()=>{
        assert.equal(await source.getByRole('button',{name:'Start boosting',exact:true}).isDisabled(),true);
        await source.getByLabel('Device name',{exact:true}).fill('Volunteer test laptop');await source.getByLabel('I volunteer this device', {exact:false}).check();
        await source.getByRole('button',{name:'Start boosting',exact:true}).click();await source.getByRole('button',{name:'Stop boosting and clear cache'}).waitFor();assert.equal((await source.evaluate(()=>window.boostStatus())).sentBytes,0);
        const seeded=await download(source);assert.equal(seeded.hash,hash);await until(async()=>{const d=await api('/api/boosters/admin','GET',undefined,owner.accessToken);return d.sessions[0]?.cachedFiles===1;},'cache heartbeat');
    });
    await target.getByLabel('Try volunteer downloads on this server',{exact:false}).check();
    await check('Real WebRTC payload passes hash verification without another origin file request',async()=>{
        const before=originDownloads;const result=await download(target);assert.equal(result.hash,hash);assert.equal(result.state.receivedBytes,payload.length);assert.equal(originDownloads,before);report.measurements.peerPayloadBytes=payload.length;report.measurements.originFileRequestsAvoided=1;
        await until(async()=>{const d=await api('/api/boosters/admin','GET',undefined,owner.accessToken);return d.recipientConfirmedBytes===payload.length;},'recipient receipt');
    });

    await check('Back-to-back peer downloads remain available',async()=>{
        const before=originDownloads;const result=await download(target);assert.equal(result.hash,hash);assert.equal(result.state.receivedBytes,2*payload.length);assert.equal(originDownloads,before);
    });
    await check('Delayed volunteer discovery still completes within the transfer deadline',async()=>{
        const readyAt=Date.now()+7500;
        await source.route('**/api/boosters/sessions/*/offers',async route=>{if(Date.now()<readyAt)await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({offers:[]})});else await route.continue();});
        const before=originDownloads;const received=(await target.evaluate(()=>window.boostStatus())).receivedBytes;
        const result=await download(target);assert.equal(result.hash,hash);assert.equal(result.state.receivedBytes,received+payload.length);assert.equal(originDownloads,before);
        await source.unroute('**/api/boosters/sessions/*/offers');
    });
    await check('Opting out while discovery is pending never starts a peer request',async()=>{
        let entered;let release;const started=new Promise(r=>entered=r);const gate=new Promise(r=>release=r);
        await target.route(origin+'/api/boosters/file',async route=>{entered();await gate;await route.continue();});
        const before=peerTickets;const downloads=originDownloads;const pending=download(target);await started;
        await target.getByLabel('Try volunteer downloads on this server',{exact:false}).uncheck();release();const result=await pending;
        assert.equal(result.hash,hash);assert.equal(peerTickets,before);assert.equal(originDownloads,downloads+1);
        await target.unroute(origin+'/api/boosters/file');await target.getByLabel('Try volunteer downloads on this server',{exact:false}).check();
    });
    await check('A corrupted peer payload is discarded and retried at the Authority',async()=>{
        await source.evaluate(()=>{const original=RTCDataChannel.prototype.send;window.restoreSend=()=>{RTCDataChannel.prototype.send=original;};let changed=false;RTCDataChannel.prototype.send=function(data){if(!changed && data instanceof ArrayBuffer && data.byteLength){const copy=data.slice(0);new Uint8Array(copy)[0]^=255;changed=true;return original.call(this,copy);}return original.call(this,data);};});
        const before=originDownloads;const received=(await target.evaluate(()=>window.boostStatus())).receivedBytes;const tickets=peerTickets;
        const result=await download(target);assert.equal(result.hash,hash);assert.equal(originDownloads,before+1);assert.equal(peerTickets,tickets+1);assert.equal(result.state.receivedBytes,received);await source.evaluate(()=>window.restoreSend());
    });
    await check('Stopping a booster clears its cache and downloads fall back to origin',async()=>{
        await source.getByRole('button',{name:'Stop boosting and clear cache'}).click();await until(async()=>!(await source.evaluate(()=>window.boostStatus())).active,'local stop');
        await until(async()=>(await api('/api/boosters/admin','GET',undefined,owner.accessToken)).sessions.length===0,'server stop');
        const before=originDownloads;const result=await download(target);assert.equal(result.hash,hash);assert.equal(originDownloads,before+1);assert.equal((await source.evaluate(()=>window.boostStatus())).cachedBytes,0);
    });

    await check('A volunteer leaving during transfer still completes the original download',async()=>{
        await source.getByLabel('Upload limit (KiB/s)',{exact:true}).fill('64');await source.getByRole('button',{name:'Start boosting',exact:true}).click();await source.getByRole('button',{name:'Stop boosting and clear cache'}).waitFor();
        await download(source);await until(async()=>(await api('/api/boosters/admin','GET',undefined,owner.accessToken)).sessions[0]?.cachedFiles===1,'second session cache');
        const before=originDownloads;const pending=download(target);await until(async()=>(await source.evaluate(()=>window.boostStatus())).sentBytes>0,'first peer chunk');
        const sent=(await source.evaluate(()=>window.boostStatus())).sentBytes;assert.ok(sent<payload.length);await source.getByRole('button',{name:'Stop boosting and clear cache'}).click();
        const result=await pending;assert.equal(result.hash,hash);assert.equal(originDownloads,before+1);report.measurements.interruptedPeerBytes=sent;
    });
    await check('Account/server switches retire consent and local contribution counters',async()=>{
        await target.evaluate(async()=>{const {setConfiguredServerUrl}=await import('/src/lib/serverUrl.ts');setConfiguredServerUrl('http://127.0.0.1:1',true);});
        const state=await target.evaluate(()=>window.boostStatus());assert.equal(state.receiving,false);assert.equal(state.active,false);assert.equal(state.receivedBytes,0);
    });
    await check('Private-access enable and disable refresh a complete status without granting an empty allow-list',async()=>{
        await ports.getByRole('button',{name:'Turn on private access…',exact:true}).click();
        await ports.getByRole('button',{name:'Yes, turn it on',exact:true}).click();
        await ports.getByRole('button',{name:'Turn off now (kill-switch)',exact:true}).waitFor();
        const enabled=await api('/api/addons/tailcat/status','GET',undefined,owner.accessToken);
        assert.equal(enabled.enabled,true);assert.equal(enabled.running,false);assert.deepEqual(enabled.keys,[]);
        await ports.getByRole('button',{name:'Turn off now (kill-switch)',exact:true}).click();
        await ports.getByRole('button',{name:'Turn on private access…',exact:true}).waitFor();
        assert.equal((await api('/api/addons/tailcat/status','GET',undefined,owner.accessToken)).enabled,false);
    });
    await check('Admin health and private-access port controls render without horizontal overflow',async()=>{
        await admin.getByRole('heading',{name:'Network health',exact:true}).waitFor();assert.notEqual(await admin.locator('h2').evaluate(e=>getComputedStyle(e).color),'rgb(0, 0, 0)','theme must be initialized');await admin.getByRole('heading',{name:'Volunteer boosters',exact:true}).waitFor();await ports.getByLabel('Private-access port',{exact:true}).waitFor();
        for(const [name,p] of [['admin',admin],['ports',ports],['volunteer',source]]){const path=join(scratch,`${name}.png`);await p.screenshot({path,fullPage:true});report.screenshots.push(path);}
        await source.setViewportSize({width:390,height:850});assert.equal(await source.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);const path=join(scratch,'volunteer-mobile.png');await source.screenshot({path,fullPage:true});report.screenshots.push(path);
    });
    assert.deepEqual(report.pageErrors,[]);console.log('Evidence: '+scratch);
}catch(e){report.failure=e.stack;console.error(e);process.exitCode=1;}
finally{await writeFile(join(scratch,'results.json'),JSON.stringify(report,null,2));await browser?.close();await vite?.close();if(child){child.stdin.end();await Promise.race([childExit,delay(10000).then(()=>child.kill('SIGTERM'))]);}console.log('Report: '+join(scratch,'results.json'));}
