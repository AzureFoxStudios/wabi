// Headful rendering of the real /host and /join route components and real
// account/server stores. Native commands and HTTP are synthetic boundaries.
// This does NOT certify a packaged app, Authority, networking or disk recovery.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp('/tmp/wabi-desktop-host-ui-');
const report = { boundary: 'Real Svelte host/join routes + server/account stores; SYNTHETIC native and HTTP. No packaged/native/Authority/backup/network acceptance.', assertions: [], commands: [], screenshots: [], pageErrors: [], requests: [] };
let vite, browser, page, origin;
let failStart = false, joinSetup = false;
let lanAddresses = ['http://192.168.1.25:43129'];
let invitationGate;
let inviteExpiresAtOverride;
const fresh = () => ({ running:false, ready:false, setupRequired:null, localUrl:null, sharing:'local', error:null, dataDirectory:'/synthetic/Wabi/community', logDirectory:'/synthetic/Wabi/logs', backupIds:[], binaryAvailable:true, buildRevision:'synthetic-ui-fixture', testBuild:true, communityName:null, hasCommunity:false, serverId:null });
let host = fresh();
let owned = false;
let firstQr;
const account = { accessToken:'synthetic-access-not-a-credential', refreshToken:'synthetic-refresh-not-a-credential', user:{id:42,username:'fixture-owner'} };
async function native(name, args) {
  // Do not write owner passwords or invitation secrets into the report.
  report.commands.push({name, keys:Object.keys(args || {})});
  if(name === 'get_platform') return 'linux';
  if(name === 'host_status') return {...host};
  if(name === 'host_lan_addresses') return [...lanAddresses];
  if(name === 'host_start' || name === 'host_restart') {
    if(failStart) { host.error='Port is already in use. Close the other application and retry; your data is preserved.'; throw new Error(host.error); }
    host={...host,running:true,ready:true,hasCommunity:true,localUrl:'http://127.0.0.1:43129',setupRequired:!owned,error:null,serverId:'synthetic-stable-identity'};
  } else if(name === 'host_account') {
    if(args.register) { assert.equal(owned,false); owned=true;host.setupRequired=false;host.communityName=args.communityName; }
    return account;
  } else if(name === 'host_stop') { host.running=false;host.ready=false;host.setupRequired=null; }
  else if(name === 'host_sharing') { assert.equal(owned,true);assert.equal(args.confirm,true);host.sharing=args.lan?'lan':'local'; }
  else if(name === 'host_invite') { assert.equal(owned,true); if(invitationGate){invitationGate.started();await invitationGate.wait;} return {token:'ab'.repeat(32),expiresAt:inviteExpiresAtOverride ?? 1800000000}; }
  else if(name === 'host_backup') { assert.equal(args.confirm,true);host.backupIds=['snapshot-fixture']; }
  else if(name === 'host_restore') { assert.equal(args.id,'snapshot-fixture');assert.equal(args.confirm,true);host.sharing='local'; }
  else if(name !== 'host_open_folder' && name !== 'host_quit') throw new Error('Unexpected native command '+name);
  return {...host};
}
const entry = `import {mount} from 'svelte'; import Host from '/src/routes/host/+page.svelte'; import Join from '/src/routes/join/+page.svelte'; import '/src/styles/styles.css'; mount(location.pathname==='/join'?Join:Host,{target:document.querySelector('#fixture')}); window.fixtureReady=true;`;
const plugin = {
  name:'desktop-host-synthetic-boundaries',enforce:'pre',
  resolveId(id, importer) {
    if(id==='/__host_entry.js') return '\0host-entry';
    if(id==='$app/environment') return '\0host-env';
    if(id==='$app/navigation') return '\0host-navigation';
    if(id==='./api' && importer?.endsWith('/savedServerActions.ts')) return '\0host-metadata';
  },
  load(id) {
    if(id==='\0host-entry') return entry;
    if(id==='\0host-env') return 'export const browser=true,dev=true,building=false;';
    if(id==='\0host-navigation') return 'export async function goto(url){location.assign(url)}';
    if(id==='\0host-metadata') return 'export async function getLaunchPageConfigFrom(){return null} export async function getPublicFrontendAppMetadata(){return null}';
  },
  configureServer(server) {
    server.middlewares.use((req,res,next)=>{
      if(req.url==='/favicon.ico'){res.statusCode=204;return res.end()}
      if(!['/','/host','/join'].includes(req.url?.split('?')[0]))return next();
      res.setHeader('Content-Type','text/html; charset=utf-8');
      res.end(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Synthetic Desktop Host UI</title><style>*{box-sizing:border-box}body{margin:0;background:var(--surface-app,#1a1a2e);font:16px system-ui}#boundary{padding:8px 20px;color:white;background:#3b3148;font-size:12px}</style><div id="boundary">SYNTHETIC native/HTTP boundaries · real hosting UI and scoped stores</div>${req.url==='/'?'<h1>Community opened</h1>':'<div id="fixture"></div><script type="module" src="/__host_entry.js"></script>'}`);
    });
  }
};
const save = () => writeFile(`${scratch}/results.json`,JSON.stringify(report,null,2));
async function shot(name){const path=`${scratch}/${name}.png`;await page.screenshot({path,fullPage:true});report.screenshots.push(path)}
async function check(name, action) {
  try {await action();report.assertions.push({name,status:'PASS'});}
  catch(error) {report.assertions.push({name,status:'FAIL',error:error.stack});await shot(`failure-${report.assertions.length}`);}
  await save(); console.log(`${report.assertions.at(-1).status}: ${name}`);
}
async function loadHost(){await page.goto(origin+'/host');await page.waitForFunction(()=>window.fixtureReady);await page.getByRole('button',{name:'Host a community',exact:true}).click();await page.getByText('Checking this installation…').waitFor({state:'hidden'});}
async function ownerInputs(){await page.getByLabel('Community name',{exact:true}).fill('Synthetic friends');await page.getByLabel('Owner username',{exact:true}).fill('fixture-owner');await page.getByLabel('Owner password',{exact:true}).fill('synthetic-password');await page.getByLabel('Repeat password',{exact:true}).fill('synthetic-password');}
async function settings(){await loadHost();await page.getByRole('button',{name:'Open hosting settings',exact:true}).click();}
const calls = name => report.commands.filter(command=>command.name===name).length;
try {
  vite=await createServer({root,configFile:false,cacheDir:`${scratch}/vite-cache`,resolve:{alias:{$lib:root+'src/lib'}},plugins:[plugin,svelte({configFile:false})],server:{host:'127.0.0.1',port:0,open:false}});
  await vite.listen();origin=`http://127.0.0.1:${vite.httpServer.address().port}`;
  browser=await chromium.launch({headless:false,executablePath:process.env.WABI_SMOKE_CHROMIUM_PATH||'/usr/bin/chromium-browser'});
  page=await browser.newPage({viewport:{width:1100,height:900}});page.setDefaultTimeout(12000);
  page.on('pageerror',e=>report.pageErrors.push(e.message));
  await page.exposeBinding('__nativeFixture',(_source,name,args)=>native(name,args));
  await page.addInitScript(()=>{window.__TAURI_INTERNALS__={invoke:(name,args)=>window.__nativeFixture(name,args)};});
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin===origin)return route.continue();
    report.requests.push({method:route.request().method(),origin:url.origin,path:url.pathname});
    if(url.origin==='https://joined.example' && url.pathname==='/api/setup/status')return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({setupRequired:joinSetup})});
    if(url.origin==='https://joined.example' && url.pathname==='/api/auth/register'){
      const body=route.request().postDataJSON();assert.equal(body.inviteToken,'ab'.repeat(32));
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...account,user:{id:73,username:'fixture-member'}})});
    }
    throw new Error('Unexpected external request '+url.origin+url.pathname);
  });
  await check('Fresh chooser and switching to Join never start hosting',async()=>{
    await page.goto(origin+'/host');await page.getByText('No communities saved yet.',{exact:false}).waitFor();
    const headingColor=await page.locator('h1').evaluate(element=>getComputedStyle(element).color);
    assert.notEqual(headingColor,'rgb(0, 0, 0)','standalone hosting must initialize the existing theme');
    await page.getByRole('button',{name:'Join a community',exact:true}).click();
    await page.getByLabel('Invitation link or server address').fill('https://joined.example');
    joinSetup=true;await page.getByRole('button',{name:'Continue to community'}).click();
    await page.getByRole('alert').filter({hasText:'host must finish'}).waitFor();
    assert.equal(calls('host_start'),0);assert.equal(await page.evaluate(()=>localStorage.getItem('wabi.serverUrl')),null);
    await shot('01-join-unconfigured');
  });
  await check('Failed native startup is actionable and preserves owner form',async()=>{
    await loadHost();await page.getByRole('button',{name:/^Configurable/}).click();await page.getByText('Configurable setup',{exact:true}).waitFor();
    assert.equal(calls('host_start'),0);await page.getByRole('button',{name:'Change setup'}).click();await shot('02-setup-choices');
    await page.getByRole('button',{name:/^Simple/}).click();await ownerInputs();failStart=true;await page.getByRole('button',{name:'Host Server',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'Port is already in use'}).waitFor();
    assert.equal(await page.getByLabel('Community name',{exact:true}).inputValue(),'Synthetic friends');assert.equal(calls('host_account'),0);
    assert.equal(await page.locator('main').evaluate(element=>getComputedStyle(element).overflowY),'auto','long onboarding must scroll within the app shell');
    await page.getByText('Server status: Failed',{exact:true}).waitFor();await shot('02-startup-failed');failStart=false;
  });
  await check('Simple creates owner only after ready, then offers invitations using existing scoped registry/auth',async()=>{
    await page.getByRole('button',{name:'Host Server',exact:true}).click();await page.getByRole('heading',{name:'Invite a friend',exact:true}).waitFor();
    assert.equal(calls('host_account'),1);
    const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('wabi.savedServers.v1')));
    assert.equal(saved.entries[0].url,host.localUrl);assert.equal(saved.entries[0].localAlias,'Synthetic friends');assert.equal(saved.entries[0].lastDbUserId,42);
    assert.equal(await page.evaluate(()=>localStorage.getItem('wabi.serverUrl')),host.localUrl);
    assert.equal(host.sharing,'local');assert.equal(calls('host_invite'),0);
  });
  await check('Simple invitation confirms LAN, detects address, and creates a usable link without IP entry',async()=>{
    await page.getByRole('button',{name:'Create invitation',exact:true}).click();await page.getByRole('button',{name:'Cancel',exact:true}).click();
    assert.equal(calls('host_sharing'),0);assert.equal(calls('host_invite'),0);
    await page.getByRole('button',{name:'Create invitation',exact:true}).click();
    await page.locator('.confirmation').getByRole('button',{name:'Enable LAN sharing',exact:true}).click();
    await page.getByLabel('Invitation link',{exact:true}).waitFor();assert.equal(calls('host_lan_addresses'),1);
    assert.equal(await page.getByLabel('Invitation link',{exact:true}).inputValue(),`http://192.168.1.25:43129/join#invite=${'ab'.repeat(32)}`);
    await page.getByRole('img',{name:'One-use invitation QR code'}).waitFor();
    firstQr=await page.getByRole('img',{name:'One-use invitation QR code'}).getAttribute('src');
    assert.match(firstQr,/^data:image\/png;base64,/);
    assert.match(await page.locator('main').innerText(),/link and QR contain the same one-use invitation, expiring/);
    await shot('03-simple-invitation');
  });
  await check('Multiple interfaces require an address choice; no address never mints an unusable invitation',async()=>{
    const issued=calls('host_invite');lanAddresses.push('http://10.0.0.2:43129');
    await page.getByRole('button',{name:'Invite another friend',exact:true}).click();await page.getByLabel('Address on your friend’s network').waitFor();
    assert.equal(calls('host_invite'),issued);assert.equal(await page.getByRole('button',{name:'Create invitation',exact:true}).isDisabled(),true);
    await page.getByLabel('Address on your friend’s network').selectOption(lanAddresses[1]);await page.getByRole('button',{name:'Create invitation',exact:true}).click();
    await page.getByLabel('Invitation link',{exact:true}).waitFor();assert.equal(calls('host_invite'),issued+1);
    const secondQr=await page.getByRole('img',{name:'One-use invitation QR code'}).getAttribute('src');
    assert.notEqual(secondQr,firstQr,'a new destination must produce a different QR');
    lanAddresses=[];await page.getByRole('button',{name:'Invite another friend',exact:true}).click();await page.getByRole('button',{name:'Find network again'}).waitFor();
    assert.equal(calls('host_invite'),issued+1);assert.equal(await page.getByLabel('Invitation link',{exact:true}).count(),0);
    assert.equal(await page.getByRole('img',{name:'One-use invitation QR code'}).count(),0);
    lanAddresses=['http://192.168.1.25:43129'];await page.getByRole('button',{name:'Find network again'}).click();await page.getByLabel('Invitation link',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Open community',exact:true}).click();await page.getByRole('heading',{name:'Community opened'}).waitFor();
    host.sharing='local';
  });
  await check('Reopened community lists same profile; Stop requires explicit confirmation',async()=>{
    await page.goto(origin+'/host');await page.getByText('Synthetic friends',{exact:true}).waitFor();await page.getByRole('button',{name:'Open hosting settings',exact:true}).click();
    await page.getByRole('button',{name:'Stop',exact:true}).click();await page.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(calls('host_stop'),0);
    await page.getByRole('button',{name:'Stop',exact:true}).click();await page.getByRole('button',{name:'Continue',exact:true}).click();await page.getByText('Server status: Stopped',{exact:true}).waitFor();
    assert.equal(calls('host_stop'),1);await shot('03-stopped-same-community');
    await page.getByRole('button',{name:'Start & open',exact:true}).click();await page.getByRole('heading',{name:'Community opened'}).waitFor();assert.equal(calls('host_account'),1);
  });
  await check('Restart uses one native operation and keeps community identity',async()=>{
    await settings();const identity=host.serverId;await page.getByRole('button',{name:'Restart',exact:true}).click();await page.getByRole('button',{name:'Continue',exact:true}).click();await page.getByText('Server status: Ready',{exact:true}).waitFor();assert.equal(calls('host_restart'),1);assert.equal(host.serverId,identity);
  });
  await check('LAN opt-in is explicit; local-only LAN invitation fails before minting',async()=>{
    const issued=calls('host_invite'), sharing=calls('host_sharing');
    await page.getByLabel('Address your guest can reach').fill('http://192.168.1.25:43129');await page.getByRole('button',{name:'Create one-use invitation',exact:true}).click();await page.getByRole('alert').filter({hasText:'Enable LAN sharing before'}).waitFor();assert.equal(calls('host_invite'),issued);
    await page.getByRole('button',{name:'Enable LAN sharing',exact:true}).click();assert.equal(calls('host_sharing'),sharing);
    await page.locator('.confirmation').getByRole('button',{name:'Enable LAN sharing',exact:true}).click();await page.getByRole('button',{name:'Turn off LAN sharing',exact:true}).waitFor();assert.equal(calls('host_sharing'),sharing+1);
    await page.getByRole('button',{name:'Create one-use invitation',exact:true}).click();await page.getByLabel('Invitation link',{exact:true}).waitFor();assert.equal(await page.getByLabel('Invitation link',{exact:true}).inputValue(),`http://192.168.1.25:43129/join#invite=${'ab'.repeat(32)}`);await shot('04-invitation-settings');
  });
  await check('Expired invitation removes its link and QR and offers a fresh invitation',async()=>{
    inviteExpiresAtOverride=Math.floor(Date.now()/1000)+3;
    try {
      await page.getByRole('button',{name:'Create one-use invitation',exact:true}).click();
      await page.getByRole('status').filter({hasText:'Invitation created.'}).waitFor();
      await page.getByRole('img',{name:'One-use invitation QR code'}).waitFor();
      await page.getByRole('status').filter({hasText:'Previous invitation expired.'}).waitFor({timeout:6000});
      assert.equal(await page.getByLabel('Invitation link',{exact:true}).count(),0);
      assert.equal(await page.getByRole('img',{name:'One-use invitation QR code'}).count(),0);
      assert.equal(await page.getByRole('button',{name:'Copy invitation'}).count(),0);
    } finally { inviteExpiresAtOverride=undefined; }
  });
  await check('Backup and restore route through confirmed native commands',async()=>{
    await page.getByRole('button',{name:'Backup',exact:true}).first().click();await page.getByRole('button',{name:'Continue',exact:true}).click();await page.getByLabel('Saved snapshots').selectOption('snapshot-fixture');assert.equal(calls('host_backup'),1);
    await page.getByRole('button',{name:'Restore snapshot',exact:true}).click();await page.getByRole('button',{name:'Continue',exact:true}).click();await page.getByRole('status').filter({hasText:'Snapshot restored'}).waitFor();assert.equal(calls('host_restore'),1);
  });
  await check('Invitation retains its validated destination during an asynchronous native request',async()=>{
    let begin, release;const started=new Promise(resolve=>begin=resolve);const wait=new Promise(resolve=>release=resolve);
    invitationGate={started:begin,wait};
    try {
      await page.getByLabel('Address your guest can reach').fill('https://intended.example');await page.getByRole('button',{name:'Create one-use invitation',exact:true}).click();await started;
      assert.equal(await page.getByLabel('Address your guest can reach').isDisabled(),true);
      await page.getByLabel('Address your guest can reach').evaluate(input=>{input.value='https://different.example';input.dispatchEvent(new Event('input',{bubbles:true}));});
      release();await page.getByLabel('Invitation link',{exact:true}).waitFor();
      assert.equal(new URL(await page.getByLabel('Invitation link',{exact:true}).inputValue()).origin,'https://intended.example');
    } finally {release();invitationGate=undefined;}
  });
  await check('Restore clears an unfinished network choice and lets Simple enable LAN again',async()=>{
    await page.getByRole('button',{name:'Host a community',exact:true}).click();
    lanAddresses=['http://192.168.1.25:43129','http://10.0.0.2:43129'];
    await page.getByRole('button',{name:'Invite another friend',exact:true}).click();await page.locator('.confirmation').getByRole('button',{name:'Enable LAN sharing',exact:true}).click();
    await page.getByLabel('Address on your friend’s network').waitFor();
    await page.getByRole('button',{name:'Open hosting settings',exact:true}).click();
    await page.getByRole('button',{name:'Restore snapshot',exact:true}).click();await page.getByRole('button',{name:'Continue',exact:true}).click();await page.getByRole('status').filter({hasText:'Snapshot restored'}).waitFor();
    await page.getByRole('button',{name:'Host a community',exact:true}).click();assert.equal(await page.getByLabel('Address on your friend’s network').count(),0);
    await page.getByRole('button',{name:'Create invitation',exact:true}).click();await page.locator('.confirmation').getByRole('button',{name:'Enable LAN sharing',exact:true}).waitFor();await page.getByRole('button',{name:'Cancel',exact:true}).click();
  });
  await check('Invite join clears fragment, creates only remote member, preserves local account scope',async()=>{
    joinSetup=true;const starts=calls('host_start');await page.goto(origin+`/join#ticket=${encodeURIComponent(`https://joined.example/join#invite=${'ab'.repeat(32)}`)}`);await page.getByLabel('Username',{exact:true}).waitFor();assert.equal(new URL(page.url()).hash,'');
    await page.getByRole('button',{name:'Already a member? Sign in',exact:true}).click();await page.getByRole('alert').filter({hasText:'host must finish'}).waitFor();assert.equal(new URL(page.url()).pathname,'/join');assert.equal(await page.evaluate(()=>localStorage.getItem('wabi.serverUrl')),host.localUrl);joinSetup=false;
    await page.getByLabel('Username',{exact:true}).fill('fixture-member');await page.getByLabel('Password',{exact:true}).fill('member-password');await page.getByLabel('Repeat password',{exact:true}).fill('member-password');await page.getByRole('button',{name:'Accept invitation & create account',exact:true}).click();await page.getByRole('heading',{name:'Community opened'}).waitFor();
    assert.equal(calls('host_start'),starts);assert.equal(calls('host_account'),1);
    const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('wabi.savedServers.v1')));
    assert.equal(saved.entries.length,2);assert.equal(saved.entries.find(x=>x.url===host.localUrl).lastDbUserId,42);assert.equal(saved.entries.find(x=>x.url==='https://joined.example').lastDbUserId,73);
  });
  await check('Narrow layout has no horizontal overflow and keeps primary actions reachable',async()=>{
    await page.setViewportSize({width:390,height:844});await page.goto(origin+'/host');await page.getByText('Synthetic friends',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await shot('05-narrow-communities');
  });
  assert.deepEqual(report.pageErrors,[]);
} catch(error) { report.fatal=error.stack; console.error(error); }
finally {await save();await browser?.close();await vite?.close();console.log(`Report: ${scratch}/results.json`);}
if(report.fatal || report.assertions.some(x=>x.status==='FAIL'))process.exitCode=1;
