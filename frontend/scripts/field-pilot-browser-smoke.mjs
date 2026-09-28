// Real FieldPilotWorkspace rendering with a synthetic Authority boundary.
// This checks UI behavior, not native phone, Wi-Fi, persistence, or server ACLs.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp('/tmp/wabi-field-pilot-ui-');
const report = { boundary: 'Real field Svelte UI, synthetic Authority and identity stores; no physical phone, LAN, NFC, or backend acceptance.', assertions: [], screenshots: [], pageErrors: [] };
let vite, browser, page;

const fixtureSocket = `
import { writable } from 'svelte/store';
export const currentUser = writable({ id:'user-42', dbUserId:42, username:'Leader', highestRole:'owner' });
export const serverMembers = writable([
  { id:'user-42', dbUserId:42, username:'Leader', highestRole:'owner', isRegistered:true },
  { id:'user-43', dbUserId:43, username:'Volunteer', highestRole:'member', isRegistered:true }
]);
window.fieldFixture = { setUser(id) { currentUser.set(id===42
  ? { id:'user-42', dbUserId:42, username:'Leader', highestRole:'owner' }
  : { id:'user-43', dbUserId:43, username:'Volunteer', highestRole:'member' }); } };
`;
const fixtureApi = `
import { get } from 'svelte/store';
import { currentUser } from '$lib/socket';
export class FieldApiError extends Error { constructor(message,status){super(message);this.status=status;} }
let session=null, serial=0;
const caller=()=>get(currentUser).dbUserId;
const ready=(signal)=>{if(signal?.aborted)throw new DOMException('Cancelled','AbortError');};
const copy=()=>structuredClone(session);
const visible=()=>{
  if(!session)throw new FieldApiError('Not found',404);
  const id=caller();
  if(!session.participants.some(p=>p.userId===id&&p.consented))throw new FieldApiError('Not found',404);
  const view=copy();view.isLeader=id===session.leaderUserId;
  if(!view.isLeader)view.participants=view.participants.filter(p=>p.consented);
  return view;
};
export async function listFieldSessions(signal){ready(signal); const id=caller();
  return {sessions:session?.participants.some(p=>p.userId===id&&p.consented)?[visible()]:[],
    invitations:session?.participants.some(p=>p.userId===id&&!p.consented)?[{id:session.id,title:session.title,leaderUserId:session.leaderUserId,expiresAt:session.expiresAt}]:[]};}
export async function getFieldSession(id,signal){ready(signal);return {session:visible()};}
export async function createFieldSession(input,signal){ready(signal); if(caller()!==42)throw new FieldApiError('Forbidden',403);
  const now=Date.now();session={id:'fixture-session',title:input.title,leaderUserId:42,createdAt:now,expiresAt:now+input.durationMinutes*60000,mapImageUrl:null,isLeader:true,
    participants:[42,...input.participantIds].map(id=>({userId:id,consented:id===42,lastCheckin:null,lastPosition:null,pendingHelp:null,lastHelpAcknowledgement:null}))};return {session:visible()};}
export async function consentToFieldSession(id,signal){ready(signal);session.participants.find(p=>p.userId===caller()).consented=true;return {session:visible()};}
export async function sendFieldCheckin(id,input,signal){ready(signal);const p=session.participants.find(p=>p.userId===caller());
  const now=Date.now(), checkin={id:'checkin-'+(++serial),status:input.status,x:input.x??null,y:input.y??null,source:input.x===undefined?null:'manual',observedAt:now,receivedAt:now,acknowledgedAt:null,acknowledgedByUserId:null};
  p.lastCheckin=checkin;
  if(input.x!==undefined)p.lastPosition={x:input.x,y:input.y,source:'manual',observedAt:now,receivedAt:now};
  if(input.status==='help')p.pendingHelp=checkin;
  window.fieldFixture.lastPosition=p.lastPosition;
  return {session:visible(),receipt:{checkinId:checkin.id,receivedAt:now,duplicate:false}};}
export async function acknowledgeFieldCheckin(id,checkinId,signal){ready(signal);if(caller()!==42)throw new FieldApiError('Forbidden',403);
  const p=session.participants.find(p=>p.pendingHelp?.id===checkinId);if(!p)throw new FieldApiError('Missing',404);
  const ackAt=Date.now();if(p.lastCheckin?.id===checkinId)p.lastCheckin.acknowledgedAt=ackAt;p.pendingHelp=null;
  p.lastHelpAcknowledgement={id:checkinId,acknowledgedAt:ackAt,acknowledgedByUserId:42};return {session:visible()};}
export async function leaveFieldSession(id,signal){ready(signal);session.participants=session.participants.filter(p=>p.userId!==caller());return {ok:true};}
export async function endFieldSession(id,signal){ready(signal);session=null;return {ok:true};}
export async function revokeFieldParticipant(id,userId,signal){ready(signal);session.participants=session.participants.filter(p=>p.userId!==userId);return {session:visible()};}
`;
const entry = `import { mount } from 'svelte'; import FieldPilotWorkspace from '/src/lib/addons/server-map/FieldPilotWorkspace.svelte'; mount(FieldPilotWorkspace,{target:document.querySelector('#fixture')}); window.fixtureReady=true;`;
const plugin = {
  name:'field-pilot-synthetic-boundaries', enforce:'pre',
  resolveId(id) {
    if(id==='/__field_entry.js')return '\0field-entry';
    if(id==='/__field_socket.js'||id==='$lib/socket'||id.endsWith('/src/lib/socket.ts'))return '\0field-socket';
    if(id==='/__field_server_url.js'||id==='$lib/serverUrl'||id.endsWith('/src/lib/serverUrl.ts'))return '\0field-server-url';
    if(id==='/__field_api.js'||id==='$lib/api/field'||id.endsWith('/src/lib/api/field.ts'))return '\0field-api';
    if(id==='$app/environment')return '\0field-env';
  },
  load(id) {
    if(id==='\0field-entry')return entry;
    if(id==='\0field-socket')return fixtureSocket;
    if(id==='\0field-server-url')return "import { writable } from 'svelte/store'; export const activeServerUrl=writable('http://127.0.0.1:8080');";
    if(id==='\0field-api')return fixtureApi;
    if(id==='\0field-env')return 'export const browser=true,dev=true,building=false;';
  },
  configureServer(server) {
    server.middlewares.use((req,res,next)=>{
      if(req.url?.split('?')[0]!=='/')return next();
      res.setHeader('Content-Type','text/html; charset=utf-8');
      res.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Field pilot fixture</title><style>*{box-sizing:border-box}body{margin:0;background:#171522;color:#eee;font:16px system-ui}#fixture{height:100vh}</style><div id="fixture"></div><script type="module" src="/__field_entry.js"></script>');
    });
  }
};

async function shot(name){const path=`${scratch}/${name}.png`;await page.screenshot({path,fullPage:true});report.screenshots.push(path);}
async function check(name, action){try{await action();report.assertions.push({name,status:'PASS'});}catch(error){report.assertions.push({name,status:'FAIL',error:error.stack});await shot(`failure-${report.assertions.length}`);}await writeFile(`${scratch}/results.json`,JSON.stringify(report,null,2));console.log(`${report.assertions.at(-1).status}: ${name}`);}

try {
  vite=await createServer({root,configFile:false,cacheDir:`${scratch}/vite-cache`,resolve:{alias:[
    {find:/^\$lib\/socket$/,replacement:'/__field_socket.js'},
    {find:/^\$lib\/serverUrl$/,replacement:'/__field_server_url.js'},
    {find:/^\$lib\/api\/field$/,replacement:'/__field_api.js'},
    {find:'$lib',replacement:root+'src/lib'}
  ]},plugins:[plugin,svelte({configFile:false})],server:{host:'127.0.0.1',port:0,open:false}});
  await vite.listen();
  const origin=`http://127.0.0.1:${vite.httpServer.address().port}`;
  browser=await chromium.launch({headless:true,executablePath:process.env.WABI_SMOKE_CHROMIUM_PATH||undefined,args:['--no-sandbox']});
  page=await browser.newPage({viewport:{width:1200,height:820},deviceScaleFactor:1});
	page.setDefaultTimeout(10_000);
  page.on('pageerror',error=>report.pageErrors.push(error.message));
  await page.goto(origin+'/'); await page.waitForFunction(()=>window.fixtureReady);
	assert.equal(await page.evaluate(() => Boolean(window.fieldFixture)), true, 'synthetic identity module must be loaded');
  await check('Leader creates a time-limited test session in the rendered field view',async()=>{
    await page.getByLabel('Session name').fill('Park walk test');
    await page.getByText('Volunteer',{exact:true}).last().click();
    await page.getByRole('button',{name:'Create session'}).click();
    await page.getByRole('heading',{name:'Park walk test'}).waitFor();
    await shot('01-leader-session');
  });
  await check('Invitee sees only invitation, then explicitly consents',async()=>{
    await page.evaluate(()=>window.fieldFixture.setUser(43));
    await page.getByRole('button',{name:'Join with consent'}).waitFor();
    assert.equal(await page.getByText('Volunteer',{exact:true}).count(),0);
    await page.getByRole('button',{name:'Join with consent'}).click();
    await page.getByRole('heading',{name:'Park walk test'}).waitFor();
  });
  await check('Phone-width volunteer taps manual pin and sends a deliberate check-in',async()=>{
    await page.setViewportSize({width:390,height:844});
    const schematic=page.getByRole('button',{name:'Choose a manual position on the schematic'});
    const bounds=await schematic.boundingBox(); assert.ok(bounds);
    await schematic.click({position:{x:bounds.width*.3,y:bounds.height*.7}});
    await page.getByText(/Ready to share a manual pin at X/).scrollIntoViewIfNeeded();
    await shot('02-phone-pin-preview');
    await page.getByRole('button',{name:"I'm okay"}).click();
    await page.getByText(/Authority received your check-in/).waitFor();
    assert.match(await page.locator('.participant').filter({hasText:'You'}).innerText(),/Position last reported .*manual/);
    await shot('03-phone-checkin');
  });
  await check('Text-only okay keeps older manual position and an open help stays visible',async()=>{
    const before=await page.evaluate(()=>window.fieldFixture.lastPosition.receivedAt);
    await page.getByRole('button',{name:'Clear pin'}).click();
    await page.getByRole('button',{name:'Need help'}).click();
    await page.getByText(/awaiting leader acknowledgement/).waitFor();
    await page.getByRole('button',{name:"I'm okay"}).click();
    assert.equal(await page.evaluate(()=>window.fieldFixture.lastPosition.receivedAt),before);
    await page.getByText(/Help request received .*awaiting leader acknowledgement/).waitFor();
    await shot('04-phone-open-help');
  });
  await check('Leader explicitly acknowledges the outstanding help',async()=>{
    await page.evaluate(()=>window.fieldFixture.setUser(42));
		await page.locator('.session-row').filter({hasText:'Park walk test'}).click();
    await page.getByRole('button',{name:'Acknowledge help'}).waitFor();
    await page.getByRole('button',{name:'Acknowledge help'}).click();
    await page.getByText('Leader acknowledgement recorded.').waitFor();
    assert.equal(await page.getByRole('button',{name:'Acknowledge help'}).count(),0);
		await page.getByText(/Help report .* acknowledged by You/).waitFor();
    await shot('05-phone-leader-ack');
  });
  assert.equal(report.pageErrors.length,0,`Browser errors: ${report.pageErrors.join('; ')}`);
  assert.ok(report.assertions.every(result=>result.status==='PASS'));
  console.log(`Field pilot browser smoke passed: ${report.assertions.length} scenarios; screenshots and results in ${scratch}`);
} finally {
  await browser?.close();
  await vite?.close();
}
