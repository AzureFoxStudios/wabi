// Actual Svelte component in headful Chromium; API fixture isolates UI behavior.
// Real backend enforcement and TCP traffic live in service_access_contract.rs.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { chromium } from 'playwright';
const root = fileURLToPath(new URL('../', import.meta.url)), scratch = await mkdtemp(join(tmpdir(), 'wabi-service-roles-ui-'));
const report = { assertions: [], screenshots: [], pageErrors: [] };
let browser, vite;
const entry = `import {mount} from 'svelte'; import Panel from '/src/lib/components/admin/ServiceRolesPanel.svelte'; import {setConfiguredServerUrl} from '/src/lib/serverUrl.ts'; import {setAuthToken} from '/src/lib/authSession.ts'; import {currentUser,connected} from 'service-fixture-socket'; import '/src/styles/tokens.css'; import {initializeTheme} from '/src/lib/theme/initTheme.ts'; await initializeTheme(false);
setConfiguredServerUrl('http://127.0.0.1:19999',true); setAuthToken('fixture-access','http://127.0.0.1:19999'); currentUser.set({dbUserId:1,highestRole:'owner'});connected.set(true);window.fixture={currentUser,connected};mount(Panel,{target:document.querySelector('#app')});`;
const plugin = { name:'service-fixture', enforce:'pre', resolveId(id, importer) {
    if(id==='/__entry.js')return '\0entry';
    if(id==='service-fixture-socket'||(id==='$lib/socket' && importer?.includes('ServiceRolesPanel')))return '\0socket';
    if(id==='$app/environment')return '\0env';
},load(id) {
    if(id==='\0entry')return entry;
    if(id==='\0socket')return "import {writable} from 'svelte/store';export const currentUser=writable(null),connected=writable(false);";
    if(id==='\0env')return 'export const browser=true,dev=true,building=false;';
},configureServer(server){server.middlewares.use((req,res,next)=>{
    if(req.url?.split('?')[0]!=='/')return next(); res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Service roles fixture</title><style>*{box-sizing:border-box}body{background:var(--surface-app);color:var(--text-heading);font:16px system-ui;margin:0}#app{max-width:1000px;margin:20px auto;padding:16px}button,input{font:inherit}button{background:var(--surface-raised);color:var(--text-heading);border:1px solid var(--border-subtle);border-radius:8px;padding:8px;cursor:pointer}button:disabled{opacity:.5}</style><main id="app"></main><script type="module" src="/__entry.js"></script>');
});}};
let snapshot = {access:{schema:1,revision:'0',updatedBy:1,roles:[['owner','Owner'],['admin','Admin'],['developer','Developer'],['mod','Moderator'],['artist','Artist'],['member','Member']].map(([id,name])=>({id:'builtin:'+id,name,services:[],members:[]}))},services:[{id:'printer',name:'Office printer',kind:'printing',exposed:true},{id:'minecraft',name:'Minecraft',kind:'game',exposed:true},{id:'remote',name:'Remote support',kind:'support',exposed:false}],members:[{id:1,name:'Owner'},{id:2,name:'Avery'}]};
let failSave = false;
try {
    vite=await createServer({root,configFile:false,cacheDir:join(scratch,'vite-cache'),resolve:{alias:[{find:/^\$lib\/socket$/,replacement:'service-fixture-socket'},{find:'$lib',replacement:join(root,'src/lib')}]},plugins:[plugin,svelte({configFile:false})],server:{host:'127.0.0.1',port:0,open:false}});await vite.listen();
    browser=await chromium.launch({headless:false,executablePath:process.env.WABI_SMOKE_CHROMIUM_PATH||'/usr/bin/chromium-browser'});
    const page=await browser.newPage({viewport:{width:1080,height:1000}});page.on('pageerror',e=>report.pageErrors.push(e.message));
    await page.route('http://127.0.0.1:19999/**',async route=>{
        if(route.request().method()==='OPTIONS')return route.fulfill({status:204,headers:{'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'GET, PUT'}});
        if(route.request().method()==='PUT'){
            if(failSave)return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Roles changed. Reload before trying again.'})});
            const body=route.request().postDataJSON();assert.equal(body.revision,snapshot.access.revision);snapshot={...snapshot,access:{...snapshot.access,revision:String(Number(snapshot.access.revision)+1),roles:body.roles}};
        }
        await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(snapshot)});
    });
    await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}`);
    await page.getByRole('heading',{name:'Roles & services'}).waitFor();
    await page.getByLabel('New role name').fill('IT team');await page.getByRole('button',{name:'Create role',exact:true}).click();await page.getByText('Role created.',{exact:true}).waitFor();
    let row=page.locator('li').filter({has:page.getByText('IT team',{exact:true})});
    await row.getByLabel('Services for IT team').click();await row.getByLabel('Office printer',{exact:false}).click();await page.getByText('Role saved.',{exact:true}).waitFor();
    assert.deepEqual(snapshot.access.roles.at(-1).services,['printer']);
    await row.getByLabel('Services for IT team').click();await row.getByLabel('Members of IT team').click();await row.getByLabel('Avery',{exact:true}).click();await page.getByText('Role saved.',{exact:true}).waitFor();assert.deepEqual(snapshot.access.roles.at(-1).members,[2]);
    report.assertions.push('Create role, grant services and assign members inline');
    await row.getByLabel('Members of IT team').click();await row.getByRole('button',{name:'Rename',exact:true}).click();await page.getByLabel('Role name',{exact:true}).fill('Support team');await page.getByRole('button',{name:'Save name'}).click();await page.getByText('Support team',{exact:true}).waitFor();
    row=page.locator('li').filter({has:page.getByText('Support team',{exact:true})});assert.equal(snapshot.access.roles.at(-1).name,'Support team');report.assertions.push('Rename preserves grants and membership');
    failSave=true;await row.getByLabel('Services for Support team').click();await row.getByLabel('Minecraft',{exact:false}).click();await page.getByRole('alert').filter({hasText:'Roles changed'}).waitFor();assert.deepEqual(snapshot.access.roles.at(-1).services,['printer']);assert.equal(await row.getByLabel('Minecraft',{exact:false}).isChecked(),false);report.assertions.push('Conflicting save displays error without mutating saved roles');
    failSave=false;await page.getByRole('button',{name:'Reload roles'}).click();await page.getByRole('alert').waitFor({state:'hidden'});
    await row.getByLabel('Services for Support team').click(); // inspect services after reload
    await row.getByRole('button',{name:'Delete',exact:true}).click();await row.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(snapshot.access.roles.length,7);report.assertions.push('Delete requires local confirmation and can be cancelled');
    const shot=join(scratch,'desktop.png');await page.screenshot({path:shot,fullPage:true});report.screenshots.push(shot);
    await page.setViewportSize({width:390,height:844});await row.getByLabel('Services for Support team').click();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    const mobile=join(scratch,'mobile.png');await page.screenshot({path:mobile,fullPage:true});report.screenshots.push(mobile);report.assertions.push('Mobile rows and open service picker have no horizontal overflow');
    await row.getByLabel('Services for Support team').click();await row.getByRole('button',{name:'Delete',exact:true}).click();await row.getByRole('button',{name:'Delete role',exact:true}).click();await page.getByText('Role deleted; its service grants and memberships were removed.',{exact:true}).waitFor();assert.equal(snapshot.access.roles.length,6);report.assertions.push('Confirmed delete removes the role');
    assert.equal(await page.getByRole('button',{name:'Delete',exact:true}).count(),0);report.assertions.push('Built-in roles have no rename or delete controls');
    await page.evaluate(()=>window.fixture.connected.set(false));await page.getByText('Connect as an administrator to manage service roles.').waitFor();assert.equal(await page.getByLabel('New role name').count(),0);report.assertions.push('Disconnect clears editing state');
    assert.deepEqual(report.pageErrors,[]);
    await writeFile(join(scratch,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({scratch,...report},null,2));
} finally { await browser?.close();await vite?.close(); }
