// Real Authority + two real browser clients. Disposable loopback data only.
// Covers optional origin/peer/fallback delivery and renders the actual controls.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { createServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { chromium } from 'playwright';
const binary=resolve(process.argv[2] || '../target/debug/wabi-server');
const fieldConfig=JSON.parse(await readFile(resolve(process.argv[3]),'utf8'));
const agents=[];const tunnels=[];const remoteBrowsers=[];
const root=resolve('.'); const scratch=await mkdtemp(join(tmpdir(),'wabi-boost-field-'));
const report={assertions:[],screenshots:[],pageErrors:[],measurements:{}};

const delay=ms=>new Promise(r=>setTimeout(r,ms));
let child, browser, vite, origin, childExit;
const bootstrap=randomBytes(32).toString('hex');
async function api(path,method='GET',body,token,first=false){
    const response=await fetch(origin+path,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`} : {}),...(first?{'X-Wabi-Bootstrap-Token':bootstrap}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});
    const value=await response.json(); assert.equal(response.status,200,`${method} ${path}: ${JSON.stringify(value)}`);return value;
}
async function until(fn,label){const end=Date.now()+45000;while(Date.now()<end){if(await fn())return;await delay(100);}throw new Error(`Timed out: ${label}`);}
async function check(name,fn){const began=performance.now();await fn();report.assertions.push(name);(report.durationsMs??={})[name]=Math.round(performance.now()-began);console.log('PASS: '+name);await writeFile(join(scratch,'results.json'),JSON.stringify(report,null,2));}
const entry=`import {mount} from 'svelte'; import Card from '/src/lib/components/settings/VolunteerBoostCard.svelte'; import Infrastructure from '/src/lib/components/admin/InfrastructureCenter.svelte'; import Tailcat from '/src/lib/components/admin/TailcatPanel.svelte'; import {setConfiguredServerUrl} from '/src/lib/serverUrl.ts'; import {setAuthToken,setStoredDbUserId,setStoredUsername} from '/src/lib/authSession.ts'; import * as booster from '/src/lib/volunteerBoosters.ts'; import {get} from 'svelte/store'; import '/src/styles/tokens.css'; import {initializeTheme} from '/src/lib/theme/initTheme.ts'; await initializeTheme(false);
const fixture=window.fixtureAccount; setConfiguredServerUrl(fixture.origin,true);setAuthToken(fixture.account.accessToken,fixture.origin);setStoredDbUserId(fixture.account.user.id,fixture.origin);setStoredUsername(fixture.account.user.username,fixture.origin);window.booster=booster;window.boostStatus=()=>get(booster.boosterState);mount(fixture.kind==='admin'?Infrastructure:fixture.kind==='tailcat'?Tailcat:Card,{target:document.querySelector('#app'),props:fixture.kind==='tailcat'?{canManageAdmin:true}:{}});window.fixtureReady=true;`;
const plugin={name:'boost-fixture',enforce:'pre',resolveId(id){if(id==='/__boost.js')return '\0boost-entry';if(id==='$app/environment')return '\0boost-env';},load(id){if(id==='\0boost-entry')return entry;if(id==='\0boost-env')return 'export const browser=true,dev=true,building=false;';},configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url==='/favicon.ico'){res.statusCode=204;return res.end();}if(req.url?.split('?')[0]!=='/')return next();res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wabi volunteer booster acceptance</title><style>*{box-sizing:border-box}body{margin:0;background:var(--surface-app);color:var(--text-heading);font:16px system-ui}#app{max-width:1100px;margin:24px auto;padding:16px}button,input{font:inherit}#boundary{padding:10px;background:var(--surface-raised)}</style><div id="boundary">Disposable test community · actual UI and direct file transfers</div><main id="app"></main><script type="module" src="/__boost.js"></script>');});}};
const initField = value=>{window.fixtureAccount=value;window.fieldRoutes=[];window.fieldPeerStates=[];const Original=window.RTCPeerConnection;
            const category=address=>{if(!address)return 'unknown';if(address.startsWith('fd7a:115c:a1e0:'))return 'management-vpn';if(/^(f[cd]|fe80:)/i.test(address))return 'private-lan';if(/^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./.test(address))return 'management-vpn';if(/^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(address))return 'private-lan';if(/^(127\.|::1$)/.test(address))return 'loopback';if(address.endsWith('.local'))return 'mdns';return 'public';};
            window.RTCPeerConnection=class extends Original {constructor(...args){super(...args);const history={stunServers:args[0]?.iceServers?.length??0,states:[],candidateTypes:[]};window.fieldPeerStates.push(history);for(const event of ['connectionstatechange','iceconnectionstatechange','signalingstatechange'])this.addEventListener(event,()=>history.states.push([event,this.connectionState,this.iceConnectionState,this.signalingState]));this.addEventListener('icecandidate',e=>{if(e.candidate)history.candidateTypes.push({type:e.candidate.type,network:category(e.candidate.address)});});this.fieldTimer=setInterval(async()=>{try{const stats=await this.getStats();for(const t of stats.values()){if(t.type!=='transport'||!t.selectedCandidatePairId)continue;const pair=stats.get(t.selectedCandidatePairId);if(!pair)continue;const local=stats.get(pair.localCandidateId),remote=stats.get(pair.remoteCandidateId);const sample={localType:local?.candidateType,remoteType:remote?.candidateType,localNetwork:category(local?.address),remoteNetwork:category(remote?.address),protocol:local?.protocol,bytesSent:pair.bytesSent,bytesReceived:pair.bytesReceived,currentRoundTripTime:pair.currentRoundTripTime};window.fieldRoutes.push(sample);if(window.fieldRoutes.length>200)window.fieldRoutes.shift();}}catch{}},100);}close(){clearInterval(this.fieldTimer);return super.close();}};
        };
try{
    const data=join(scratch,'data');await mkdir(data);await writeFile(join(data,'admin_policies.json'),JSON.stringify({auth_policy:{mode:'invite',allowRegister:true,allowGuest:false}}));
    const env=Object.fromEntries(['PATH','HOME','USERPROFILE','SystemRoot','TEMP','TMP'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
    Object.assign(env,{WABI_UPLOADS_DIR:join(data,'uploads'),WABI_LOG_DIR:join(scratch,'logs'),WABI_DESKTOP_BOOTSTRAP_TOKEN:bootstrap,WABI_SERVER_ROLE:'authority',WABI_MESH_ENABLED:'false',WABI_TAILCAT_BINARY:fieldConfig.tailcat,XDG_CONFIG_HOME:join(scratch,'config')});
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
        await context.addInitScript(initField,{origin,account,kind});
        const p=await context.newPage();p.on('pageerror',e=>report.pageErrors.push(e.message));await p.goto(ui);await p.waitForFunction(()=>window.fixtureReady);return p;
    }
    async function remote(machine,account){
        const directory=`.local/share/wabi-booster-field-${scratch.split('-').at(-1)}`;
        execFileSync('ssh',['-o','BatchMode=yes',machine.ssh,`mkdir -p ${directory} && chmod 700 ${directory}`]);
        execFileSync('scp',['-q',fieldConfig.tailcat,`${machine.ssh}:${directory}/tailcat`]);
        execFileSync('scp',['-q',resolve('../scripts/field-browser-agent.py'),`${machine.ssh}:${directory}/agent.py`]);
        const agent=spawn('ssh',['-o','BatchMode=yes','-o','ServerAliveInterval=10',machine.ssh,`python3 ${directory}/agent.py`],{stdio:['pipe','pipe','pipe']});agents.push(agent);
        let pending=[],queued=[];const lines=createInterface({input:agent.stdout});lines.on('line',line=>{let data;try{data=JSON.parse(line);}catch{return;}const waiter=pending.shift();if(waiter)waiter(data);else queued.push(data);});
        const next=()=>Promise.race([queued.length?Promise.resolve(queued.shift()):new Promise(r=>pending.push(r)),delay(45000).then(()=>{throw new Error('Remote agent timed out: '+machine.label);})]);
        agent.stderr.on('data',d=>{console.error(machine.label+': '+String(d).trim());});
        agent.stdin.write(JSON.stringify({config:machine})+'\n');const ready=await next();assert.equal(ready.ready,true,JSON.stringify(ready));
        const key=await api('/api/addons/tailcat/keys','POST',{publicKey:ready.publicKey,label:machine.label+' field browser'},account.accessToken);
        await api('/api/addons/tailcat/enable','POST',{confirm:true},owner.accessToken);
        let connection;await until(async()=>{connection=await api('/api/addons/tailcat/connect','GET',undefined,account.accessToken);return Boolean(connection.address);},'Tailcat listener address');
        async function reconnect(){await delay(1500);connection=await api('/api/addons/tailcat/connect','GET',undefined,account.accessToken);(report.transportTransitions??=[]).push({machine:machine.label,pipePort:connection.pipePort,addressDigest:createHash('sha256').update(connection.address).digest('hex').slice(0,12)});agent.stdin.write(JSON.stringify({op:'connect',address:connection.address,pipePort:connection.pipePort,localPort:Number(new URL(origin).port)})+'\n');const connected=await next();assert.equal(connected.connected,true,JSON.stringify(connected));}
        await reconnect();
        const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const localPort=listener.address().port;await new Promise(r=>listener.close(r));
        const uiPort=new URL(ui).port;
        const tunnel=spawn('ssh',['-N','-o','BatchMode=yes','-o','ExitOnForwardFailure=yes','-L',`127.0.0.1:${localPort}:127.0.0.1:${ready.cdpPort}`,'-R',`127.0.0.1:${uiPort}:127.0.0.1:${uiPort}`,machine.ssh],{stdio:['ignore','ignore','pipe']});tunnels.push(tunnel);tunnel.stderr.on('data',d=>console.error('CONTROL '+machine.label+': '+String(d).trim()));tunnel.on('exit',code=>console.log('Control tunnel exited: '+machine.label+' '+code));
        await until(async()=>{try{return(await fetch(`http://127.0.0.1:${localPort}/json/version`)).ok;}catch{return false;}},'remote browser control');
        const remoteBrowser=await chromium.connectOverCDP(`http://127.0.0.1:${localPort}`);remoteBrowsers.push(remoteBrowser);
        const context=await remoteBrowser.newContext({viewport:{width:1080,height:1000}});
        await context.addInitScript(initField,{origin,account,kind:'member'});
        const p=await context.newPage();p.on('pageerror',e=>report.pageErrors.push(e.message));await p.goto(ui);await p.waitForFunction(()=>window.fixtureReady);console.log('REMOTE READY: '+machine.label);
        return {p,key,reconnect,label:machine.label};
    }
    const a=await remote(fieldConfig.machines[0],volunteer);const b=fieldConfig.machines[1] ? await remote(fieldConfig.machines[1],recipient) : {p:await page(recipient),reconnect:async()=>{},label:'Coordinator'};await delay(2000);await a.reconnect();await a.p.reload();await a.p.waitForFunction(()=>window.fixtureReady);
    const source=a.p;const target=b.p;const admin=await page(owner,'admin');const ports=await page(owner,'tailcat');

    let originDownloads=0;let peerTickets=0;let lastTicket;let ticketPolls=0;target.on('response',async r=>{if(r.url()===origin+'/api/boosters/tickets' && r.request().method()==='POST' && r.status()===200)lastTicket=(await r.json()).id;});target.on('request',r=>{if(r.method()==='GET'&&r.url().includes('/api/boosters/tickets/'))ticketPolls++;});target.on('request',r=>{if(r.url()===fileUrl)originDownloads++;if(r.url()===origin+'/api/boosters/tickets')peerTickets++;});
    async function download(p){return p.evaluate(async url=>{const bytes=await(await window.booster.downloadWithBoosters(url)).arrayBuffer();const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');return {hash,size:bytes.byteLength,state:window.boostStatus()};},fileUrl);}
    await check('Origin download works with no volunteers',async()=>{const result=await download(target);assert.equal(result.hash,hash);assert.equal(originDownloads,1);});
    await check('Explicit opt-in starts a bounded volunteer; no automatic traffic claim',async()=>{
        assert.equal(await source.getByRole('button',{name:'Start boosting',exact:true}).isDisabled(),true);
        await source.getByLabel('Device name',{exact:true}).fill('Volunteer test laptop');await source.getByLabel('I volunteer this device', {exact:false}).check();
        console.log('Volunteer readiness: '+await source.locator('[role=alert]').allTextContents());await source.getByRole('button',{name:'Start boosting',exact:true}).click();await source.getByRole('button',{name:'Stop boosting and clear cache'}).waitFor();assert.equal((await source.evaluate(()=>window.boostStatus())).sentBytes,0);
        const seeded=await download(source);assert.equal(seeded.hash,hash);await until(async()=>{const d=await api('/api/boosters/admin','GET',undefined,owner.accessToken);return d.sessions[0]?.cachedFiles===1;},'cache heartbeat');
    });
    await target.getByLabel('Try volunteer downloads on this server',{exact:false}).check();
    await check('Cross-network download completes; peer delivery or fallback is recorded',async()=>{
        const before=originDownloads;const result=await download(target);assert.equal(result.hash,hash);report.measurements.peerDelivered=result.state.receivedBytes===payload.length;report.measurements.peerPayloadBytes=result.state.receivedBytes;report.measurements.originFileRequestsAvoided=originDownloads===before?1:0;report.peerStates={sender:await source.evaluate(()=>window.fieldPeerStates),recipient:await target.evaluate(()=>window.fieldPeerStates)};report.signaling={ticketPolls,answerPresentAtCompletion:lastTicket?Boolean((await api('/api/boosters/tickets/'+lastTicket,'GET',undefined,recipient.accessToken)).answer):false};report.routes={sender:await source.evaluate(()=>window.fieldRoutes),recipient:await target.evaluate(()=>window.fieldRoutes)};assert.equal(originDownloads, before+(report.measurements.peerDelivered?0:1));console.log('PEER OUTCOME: '+(report.measurements.peerDelivered?'verified direct payload':'intact origin fallback'));if(!report.measurements.peerDelivered){report.unavailable=['Consecutive peer delivery','Corrupt peer copy','Volunteer disappearing mid-payload'];return;}
        await until(async()=>{const d=await api('/api/boosters/admin','GET',undefined,owner.accessToken);return d.recipientConfirmedBytes===payload.length;},'recipient receipt');
    });

    if(report.measurements.peerDelivered) await check('Back-to-back peer downloads remain available',async()=>{
        const before=originDownloads;const result=await download(target);assert.equal(result.hash,hash);assert.equal(result.state.receivedBytes,2*payload.length);assert.equal(originDownloads,before);
    });
    await check('Admin observations match the live process and confirmed peer workload',async()=>{
        const health=await api('/api/admin/network-health','GET',undefined,owner.accessToken);
        const processStatus=await readFile(`/proc/${child.pid}/status`,'utf8');
        const rss=Number(processStatus.match(/VmRSS:\s+(\d+)/)[1])*1024;
        assert.ok(health.processMemoryBytes>0);assert.ok(Math.abs(health.processMemoryBytes-rss)<20*1048576);
        assert.ok(health.interfaces.length>0);assert.ok(health.httpRequestsTotal>0);
        await until(async()=>(await api('/api/boosters/admin','GET',undefined,owner.accessToken)).completedTransfers===(report.measurements.peerDelivered?2:0),'delivery receipts reach Authority');
        const contributions=await api('/api/boosters/admin','GET',undefined,owner.accessToken);
        assert.equal(contributions.recipientConfirmedBytes,report.measurements.peerDelivered?2*payload.length:0);assert.equal(contributions.completedTransfers,report.measurements.peerDelivered?2:0);
        report.measurements.adminProcessMemoryBytes=health.processMemoryBytes;
        report.measurements.confirmedPeerPayloadBytes=contributions.recipientConfirmedBytes;
    });
    await check('Opting out while discovery is pending never starts a peer request',async()=>{
        let entered;let release;const started=new Promise(r=>entered=r);const gate=new Promise(r=>release=r);
        await target.route(origin+'/api/boosters/file',async route=>{entered();await gate;await route.continue();});
        const before=peerTickets;const downloads=originDownloads;const pending=download(target);await started;
        await target.getByLabel('Try volunteer downloads on this server',{exact:false}).uncheck();release();const result=await pending;
        assert.equal(result.hash,hash);assert.equal(peerTickets,before);assert.equal(originDownloads,downloads+1);
        await target.unroute(origin+'/api/boosters/file');await target.getByLabel('Try volunteer downloads on this server',{exact:false}).check();
    });
    if(report.measurements.peerDelivered) await check('A corrupted peer payload is discarded and retried at the Authority',async()=>{
        await source.evaluate(()=>{const original=RTCDataChannel.prototype.send;window.restoreSend=()=>{RTCDataChannel.prototype.send=original;};let changed=false;RTCDataChannel.prototype.send=function(data){if(!changed && data instanceof ArrayBuffer && data.byteLength){const copy=data.slice(0);new Uint8Array(copy)[0]^=255;changed=true;return original.call(this,copy);}return original.call(this,data);};});
        const before=originDownloads;const received=(await target.evaluate(()=>window.boostStatus())).receivedBytes;const tickets=peerTickets;
        const result=await download(target);assert.equal(result.hash,hash);assert.equal(originDownloads,before+1);assert.equal(peerTickets,tickets+1);assert.equal(result.state.receivedBytes,received);await source.evaluate(()=>window.restoreSend());
    });
    await check('Stopping a booster clears its cache and downloads fall back to origin',async()=>{
        await source.getByRole('button',{name:'Stop boosting and clear cache'}).click();await until(async()=>!(await source.evaluate(()=>window.boostStatus())).active,'local stop');
        await until(async()=>(await api('/api/boosters/admin','GET',undefined,owner.accessToken)).sessions.length===0,'server stop');
        const before=originDownloads;const result=await download(target);assert.equal(result.hash,hash);assert.equal(originDownloads,before+1);assert.equal((await source.evaluate(()=>window.boostStatus())).cachedBytes,0);
    });

    if(report.measurements.peerDelivered) await check('A volunteer leaving during transfer still completes the original download',async()=>{
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
    await check('Tailcat remote device blocking, reallow and live port change',async()=>{
        const statusPath='/api/addons/tailcat/status';
        const before=(await api(statusPath,'GET',undefined,owner.accessToken)).pipePort;
        await api(`/api/addons/tailcat/keys/${a.key.id}/access`,'PUT',{allowed:false},owner.accessToken);
        await delay(2000);
        const denied=await source.evaluate(async url=>{try{const r=await fetch(url+'/api/boosters/status',{signal:AbortSignal.timeout(8000),headers:{authorization:'Bearer '+window.fixtureAccount.account.accessToken}});return r.status;}catch{return 0;}},origin);
        assert.notEqual(denied,200);
        await api(`/api/addons/tailcat/keys/${a.key.id}/access`,'PUT',{allowed:true},owner.accessToken);
        await until(async()=>Boolean((await api('/api/addons/tailcat/connect','GET',undefined,volunteer.accessToken)).address),'reallowed transport');await a.reconnect();
        await until(async()=>source.evaluate(async url=>{try{return(await fetch(url+'/api/boosters/status',{signal:AbortSignal.timeout(5000),headers:{authorization:'Bearer '+window.fixtureAccount.account.accessToken}})).status===200;}catch{return false;}},origin),'remote reallow recovery');
        const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const newPort=listener.address().port;await new Promise(r=>listener.close(r));
        await api('/api/addons/tailcat/port','PUT',{pipePort:newPort},owner.accessToken);
        await until(async()=>Boolean((await api('/api/addons/tailcat/connect','GET',undefined,volunteer.accessToken)).address),'changed port transport');await a.reconnect();await b.reconnect();
        assert.equal((await api(statusPath,'GET',undefined,owner.accessToken)).pipePort,newPort);assert.notEqual(before,newPort);
        await until(async()=>source.evaluate(async url=>{try{return(await fetch(url+'/api/boosters/status',{signal:AbortSignal.timeout(5000),headers:{authorization:'Bearer '+window.fixtureAccount.account.accessToken}})).status===200;}catch{return false;}},origin),'remote port recovery');
        await ports.getByRole('button',{name:'Refresh',exact:true}).click();
    });
    await check('Admin health and private-access port controls render without horizontal overflow',async()=>{
        await admin.getByRole('heading',{name:'Network health',exact:true}).waitFor();assert.notEqual(await admin.locator('h2').evaluate(e=>getComputedStyle(e).color),'rgb(0, 0, 0)','theme must be initialized');await admin.getByRole('heading',{name:'Volunteer boosters',exact:true}).waitFor();await ports.getByLabel('Private-access port',{exact:true}).waitFor();
        for(const [name,p] of [['admin',admin],['ports',ports],['volunteer',source]]){const path=join(scratch,`${name}.png`);await p.screenshot({path,fullPage:true,mask:name==='ports'?[p.locator('.address-box')]:[]});report.screenshots.push(path);}
        await source.setViewportSize({width:390,height:850});assert.equal(await source.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);const path=join(scratch,'volunteer-mobile.png');await source.screenshot({path,fullPage:true});report.screenshots.push(path);
    });
    assert.deepEqual(report.pageErrors,[]);console.log('Evidence: '+scratch);
}catch(e){report.failure=e.stack;console.error(e);process.exitCode=1;}
finally{for(const remoteBrowser of remoteBrowsers){try{const cdp=await remoteBrowser.newBrowserCDPSession();await cdp.send('Browser.close');}catch{}}for(const agent of agents)agent.stdin.end();await delay(2000);for(const tunnel of tunnels)tunnel.kill();await writeFile(join(scratch,'results.json'),JSON.stringify(report,null,2));await browser?.close();await vite?.close();if(child){child.stdin.end();await Promise.race([childExit,delay(10000).then(()=>child.kill('SIGTERM'))]);}console.log('Report: '+join(scratch,'results.json'));}
