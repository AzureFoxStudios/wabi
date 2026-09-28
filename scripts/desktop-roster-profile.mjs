#!/usr/bin/env node
// Real Tauri/WebKit client memory against a disposable remote Authority.
import { spawn } from 'node:child_process';
import { readFile, mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { measureDesktopIdle } from './desktop-idle-metrics.mjs';
const binary = resolve(process.argv[2] || 'src-tauri/target/release/wabi-desktop');
const serverUrl = process.env.WABI_LOAD_URL;
const username = process.env.WABI_LOAD_USER;
const password = process.env.WABI_LOAD_PASSWORD;
if (!serverUrl || !username || !password) throw new Error('Set WABI_LOAD_URL, WABI_LOAD_USER and WABI_LOAD_PASSWORD.');
const scratch = await mkdtemp(join(tmpdir(), 'wabi-roster-desktop-'));
for (const name of ['data', 'config', 'cache']) await mkdir(join(scratch, name));
const listener = createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
listener.close();
const driver = spawn(process.env.WABI_WEBKIT_DRIVER || 'WebKitWebDriver', [`--port=${port}`, '--host=127.0.0.1'], { env: { ...process.env, XDG_DATA_HOME: join(scratch,'data'), XDG_CONFIG_HOME:join(scratch,'config'), XDG_CACHE_HOME:join(scratch,'cache'), GDK_BACKEND:'x11', TAURI_WEBVIEW_AUTOMATION:'true', WABI_SKIP_VIEWER_TEST:'1' }, stdio:['ignore','pipe','pipe'] });
let driverError = '';
driver.stderr.on('data', chunk => driverError += chunk);
let session;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function request(method, path, body) {
 const response=await fetch(`http://127.0.0.1:${port}${path}`,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
 const result=await response.json();if(!response.ok||result.value?.error)throw new Error(`${method} ${path}: ${JSON.stringify(result.value)}`);return result.value;
}
async function execute(script,args=[]){return request('POST',`/session/${session}/execute/sync`,{script,args});}
async function waitFor(script,label,ms=30000){const end=Date.now()+ms;while(Date.now()<end){try{if(await execute(script))return;}catch(error){if(!String(error).includes('no such frame'))throw error;}await sleep(250);}throw new Error(`Timed out: ${label}; body=${String(await execute('return document.body.innerText')).slice(0,500)}`);}
async function clickText(text){await execute('const text=arguments[0]; const element=[...document.querySelectorAll("button")].find(e=>e.textContent.trim()===text); if(!element)throw Error("Missing button: "+text); element.click();',[text]);}
async function input(selector,value){await execute('const e=document.querySelector(arguments[0]); if(!e)throw Error("Missing input: "+arguments[0]); e.value=arguments[1];e.dispatchEvent(new Event("input",{bubbles:true}));',[selector,value]);}
try {
 let launched=false;for(let n=0;n<30;n++){try{const value=await request('POST','/session',{capabilities:{alwaysMatch:{browserName:'wry','webkitgtk:browserOptions':{binary},timeouts:{implicit:0,pageLoad:60000,script:30000}}}});session=value.sessionId;launched=true;break;}catch(error){if(n===29)throw error;await sleep(500);}}
 if(!launched)throw new Error('Driver launch failed');
 await waitFor('return document.body.innerText.includes("My communities")','entry');
 await clickText('Join a community');
 await input('#join-address',serverUrl);
 await clickText('Continue to community');
 await waitFor('return Boolean(document.querySelector(".auth-form"))','login form');
 await input('input[autocomplete="username"]',username);
 await input('input[autocomplete="current-password"]',password);
 await execute('document.querySelector(".auth-form button[type=submit]").click()');
 await waitFor('return Boolean(document.querySelector(".app-container"))','workspace',60000);
 await sleep(30000);
 const children=(await readFile(`/proc/${driver.pid}/task/${driver.pid}/children`,'utf8')).trim().split(/\s+/);
 let appPid;for(const pid of children){const cmd=await readFile(`/proc/${pid}/cmdline`,'utf8').catch(()=>'');if(cmd.split('\0')[0]===binary)appPid=Number(pid);}
 if(!appPid)throw new Error('Native app process not found');
 const footprint=await execute('return {nodes:document.querySelectorAll("*").length, workspaceVisible:Boolean(document.querySelector(".app-container"))}');
 const idle=await measureDesktopIdle(appPid,15);
 console.log(JSON.stringify({footprint,idle}));
} finally {if(session)await request('DELETE',`/session/${session}`).catch(()=>{});driver.kill();console.error(`evidence=${scratch}${driverError?` driver=${driverError.slice(0,300)}`:''}`);}
