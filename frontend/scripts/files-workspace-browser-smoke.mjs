// GF07: rendered current Files UI/session/API helpers, synthetic Lore HTTP only.
// No Authority, Lore service, accounts, passwords, or product modules are changed.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp('/tmp/wabi-files-gf07-');
const results = [], requests = [], consoleErrors = [], pageErrors = [], screenshots = [];
let vite, browser, page;
const fixture = { listErrors: new Set(), blobErrors: new Set(), repoMode: 'ok', scope: 'A', gate: null };
const contents = {
  'README.md': '# Synthetic Alpha\n\nGF07 fixture content, not external Lore data.',
  'docs/deep/guide & notes.md': '# Nested guide\n\nEncoded nested path fixture.',
  'bundle.bin': 'GF07 synthetic binary download\n',
  'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" fill="#157f70"/><text x="20" y="55" fill="white">GF07 fixture</text></svg>',
  'beta.md': '# Synthetic Beta\n\nSecond space only.'
};
const files = id => (id === 101 ? ['README.md', 'docs/deep/guide & notes.md', 'bundle.bin', 'logo.svg'] : ['beta.md']).map(path => ({ path, size: Buffer.byteLength(contents[path]), status: 'clean', etag: `synthetic-${path}` }));
const boundaries = `
import { writable } from 'svelte/store';
export const currentChannel=writable('ch_65');
export const channels=writable([{id:'ch_65',name:'Alpha synthetic',type:'lore'},{id:'ch_66',name:'Beta synthetic',type:'lore'}]);
let generation=0, scope='A'; const listeners=new Set();
export const getServerUrl=()=>location.origin+'/'+scope;
export const normalizeServerUrl=x=>x;
export const getAuthToken=()=> 'gf07-synthetic-not-a-credential';
export const getStoredDbUserId=()=>scope==='A'?1:2;
export const authSessionGeneration=()=>generation;
export const onAuthSessionCleared=()=>()=>{};
export const tryRefresh=async()=>false;
export const getSocket=()=>null;
export const captureGroupAccess=()=>{const old=generation;return ()=>old===generation};
export const groupMembership={onContextChanged:fn=>{listeners.add(fn);return ()=>listeners.delete(fn)},onRevoked:()=>()=>{}};
export const showToast=(message,kind)=>{window.__toasts.push({message,kind})};
window.__toasts=[];
window.__scopeChange=()=>{scope='B';generation++;for(const fn of listeners)fn()};
`;
const entry = `import { mount } from 'svelte'; import Files from '/src/lib/components/FilesWorkspace.svelte'; mount(Files,{target:document.querySelector('#fixture')}); window.__mounted=true;`;
const boundaryNames = new Set(['socket', 'socketConnection', 'serverUrl', 'authSession', 'groupAccess', 'toast', 'api/authRefresh']);
function plugin() { return {
  name: 'files-gf07-synthetic-boundaries', enforce: 'pre',
  resolveId(id, importer) {
    if (id === '/__files_entry.js') return '\0files-entry';
    if (id === '$app/environment') return '\0files-environment';
    let path = id;
    if (id.startsWith('.') && importer && !importer.startsWith('\0')) path = fileURLToPath(new URL(id, `file://${importer}`));
    path = path.replace(root + 'src/lib/', '').replace(/^\$lib\//, '').replace(/\.ts$/, '');
    if (boundaryNames.has(path)) return '\0files-boundaries';
  },
  load(id) {
    if (id === '\0files-entry') return entry;
    if (id === '\0files-boundaries') return boundaries;
    if (id === '\0files-environment') return 'export const browser=true,dev=true,building=false;';
  },
  configureServer(server) {
    server.middlewares.use((req,res,next)=>{
      if (req.url === '/favicon.ico') { res.statusCode=204; return res.end(); }
      if (req.url !== '/__files_gf07') return next();
      res.setHeader('Content-Type','text/html; charset=utf-8');
      res.end(`<!doctype html><title>GF07 Files — synthetic Lore fixture</title><style>
      :root{--space-1:4px;--space-2:8px;--space-3:12px;--space-4:16px;--radius-sm:4px;--font-size-xs:12px;--font-size-sm:14px;--font-size-lg:20px;--text-muted:#a9b2c1;--text-secondary:#d2d8e2;--text-heading:#eef3fa;--accent-primary:#338fce;--surface-sunken:#18202d;--surface-raised:#283246;--surface-base:#202938;--duration-fast:120ms;--ease-out:ease-out}*{box-sizing:border-box}body{margin:0;background:#202938;color:#eef3fa;font:14px system-ui}#label{height:32px;padding:6px 12px;background:#3b3148}#fixture{height:calc(100vh - 32px)}</style><div id="label">Synthetic Lore HTTP fixture — real Files component/session, NOT external integration</div><div id="fixture"></div><script type="module" src="/__files_entry.js"></script>`);
    });
  }
}; }
async function shot(name) { const path=`${scratch}/${name}.png`; await page.screenshot({path}); screenshots.push(path); return path; }
async function check(name, fn) {
  try { await fn(); results.push({name,status:'PASS'}); }
  catch(error) { results.push({name,status:'FAIL',error:error.message,dom:await page.locator('#fixture').innerText(),picker:await page.locator('.channel-picker').evaluate(el=>({value:el.value,options:[...el.options].map(o=>({value:o.value,label:o.text,selected:o.selected}))})),screenshot:await shot(`failure-${results.length+1}`)}); }
  await writeFile(`${scratch}/results.json`,JSON.stringify({results,screenshots,requests,consoleErrors,pageErrors},null,2));
  console.log(`${results.at(-1).status}: ${name}${results.at(-1).error?' — '+results.at(-1).error:''}`);
}
const fileButton = name => page.locator('.tree-file').filter({has:page.locator('.node-name').getByText(name,{exact:true})});
async function reset() {
  fixture.listErrors.clear();fixture.blobErrors.clear();fixture.repoMode='ok';fixture.gate=null;
  await page.goto(`${origin}/__files_gf07`); await page.getByRole('tree',{name:'File tree',exact:true}).waitFor();
  await fileButton('README.md').waitFor();
}
let origin;
try {
  vite=await createServer({root,cacheDir:`${scratch}/vite-cache`,configFile:false,resolve:{alias:{$lib:root+'src/lib'}},server:{host:'127.0.0.1',port:0,open:false},plugins:[plugin(),svelte({configFile:false})]});
  await vite.listen();origin=`http://127.0.0.1:${vite.httpServer.address().port}`;
  browser=await chromium.launch({headless:false,executablePath:process.env.WABI_SMOKE_CHROMIUM_PATH||'/usr/bin/chromium-browser'});
  page=await browser.newPage({viewport:{width:1440,height:900},acceptDownloads:true});page.setDefaultTimeout(8000);
  page.on('pageerror',err=>pageErrors.push(err.message));
  page.on('console',msg=>{if(msg.type()==='error')consoleErrors.push(msg.text())});
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin!==origin) throw new Error('Unexpected nonfixture network: '+url.href);
    const match=url.pathname.match(/^\/(A|B)\/api\/addons\/lore\/repos\/(\d+)(?:\/files(?:\/(.+))?)?$/);
    if(!match) return route.continue();
    const [,scope,idText,encoded]=match,id=Number(idText),isList=url.pathname.endsWith('/files');
    const path=encoded?decodeURIComponent(encoded):null;
    requests.push({scope,id,path,kind:path?'blob':isList?'list':'repo',method:route.request().method()});
    await appendFile(`${scratch}/requests.jsonl`,JSON.stringify(requests.at(-1))+'\n');
    const send=(status,body)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    if(fixture.gate?.matches({scope,id,path,isList})) { const gate=fixture.gate;gate.seen=true;await gate.promise; }
    if(path) {
      if(fixture.blobErrors.has(path))return send(500,{error:'Synthetic blob failure'});
      return route.fulfill({status:200,contentType:path.endsWith('.svg')?'image/svg+xml':path.endsWith('.bin')?'application/octet-stream':'text/plain',body:contents[path]||'STALE synthetic bytes'});
    }
    if(isList) {
      if(fixture.listErrors.has(id))return send(500,{error:'Synthetic listing failure'});
      return send(200,files(id));
    }
    if(fixture.repoMode==='unavailable')return send(503,{error:'Optional Lore service unavailable (synthetic)'});
    if(fixture.repoMode==='absent')return send(404,{error:'No connected repository (synthetic)'});
    return send(200,{channel_id:id,repo_name:`synthetic-${id}`,created_by:1,created_at:1,class:'native'});
  });
  await check('01 rendered listing and two synthetic spaces',async()=>{await reset();assert.equal(await page.locator('.channel-picker option').count(),2);assert.equal(await page.locator('.tree-root > li').count(),4);await shot('01-listing');});
  await check('02 nested folders and encoded path text preview',async()=>{
    await page.locator('.tree-folder').filter({hasText:'docs'}).click();await page.locator('.tree-folder').filter({hasText:'deep'}).click();await fileButton('guide & notes.md').click();
    await page.getByRole('heading',{name:'Nested guide',exact:true}).waitFor();assert.ok(requests.some(r=>r.path==='docs/deep/guide & notes.md'));assert.match(await page.locator('.tree-label').innerText(),/deep/);await shot('02-nested-preview');
  });
  await check('03 local filter and clear restore rows',async()=>{await page.getByRole('textbox',{name:'Search files',exact:true}).fill('bundle');assert.equal(await page.locator('.tree-file').count(),1);await fileButton('bundle.bin').waitFor();await page.getByRole('textbox',{name:'Search files',exact:true}).fill('');await fileButton('README.md').waitFor();});
  await check('04 rendered image decodes and close revokes blob URL',async()=>{await fileButton('logo.svg').click();const image=page.locator('.preview-image');await image.waitFor();await page.waitForFunction(()=>document.querySelector('.preview-image')?.naturalWidth===160);const url=await image.getAttribute('src');await shot('04-image');await page.getByRole('button',{name:'Close preview',exact:true}).click();assert.equal(await page.evaluate(async url=>{try{await fetch(url);return false}catch{return true}},url),true);});
  await check('05 unsupported preview downloads actual matching bytes',async()=>{await fileButton('bundle.bin').click();await page.getByText('No inline preview for this file.',{exact:true}).waitFor();const ready=page.waitForEvent('download');await page.getByRole('button',{name:'Download',exact:true}).click();const download=await ready;assert.equal(download.suggestedFilename(),'bundle.bin');assert.equal((await readFile(await download.path(),'utf8')),contents['bundle.bin']);await shot('05-download');});
  await check('06 preview error and rendered retry recover',async()=>{fixture.blobErrors.add('README.md');await fileButton('README.md').click();await page.locator('.preview-pane [role=alert]').filter({hasText:'Synthetic blob failure'}).waitFor();await shot('06-preview-error');fixture.blobErrors.clear();await page.locator('.preview-pane').getByRole('button',{name:'Retry',exact:true}).click();await page.getByRole('heading',{name:'Synthetic Alpha',exact:true}).waitFor();});
  await check('07 listing error and retry recover without empty success',async()=>{await reset();fixture.listErrors.add(102);await page.getByLabel('Choose a space').selectOption('102');await page.locator('.file-tree-wrap [role=alert]').waitFor();assert.equal(await page.locator('.tree-file').count(),0);await shot('07-list-error');fixture.listErrors.clear();await page.locator('.file-tree-wrap').getByRole('button',{name:'Retry',exact:true}).click();await fileButton('beta.md').waitFor();});
  await check('08 cross-space search renders both paths',async()=>{await reset();await page.getByRole('checkbox',{name:'Search all spaces',exact:true}).check();await page.getByRole('searchbox',{name:'Search all spaces',exact:true}).fill('.md');await page.getByRole('searchbox',{name:'Search all spaces',exact:true}).press('Enter');await page.waitForFunction(()=>document.querySelectorAll('.global-result').length===3);await shot('08-search');});
  await check('09 cross-space search opens result in correct space',async()=>{await page.locator('.global-result').filter({hasText:'beta.md'}).click();await page.getByRole('heading',{name:'Synthetic Beta',exact:true}).waitFor();assert.equal(await page.getByLabel('Choose a space').inputValue(),'102');});
  await check('10 partial search warning and retry restore results',async()=>{await reset();fixture.listErrors.add(102);await page.getByRole('checkbox',{name:'Search all spaces',exact:true}).check();await page.getByRole('searchbox').fill('.md');await page.getByRole('searchbox').press('Enter');await page.getByRole('status').filter({hasText:'Partial results'}).waitFor();assert.equal(await page.locator('.global-result').count(),2);await shot('10-partial-search');fixture.listErrors.clear();await page.getByRole('button',{name:'Retry',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.global-result').length===3);});
  await check('11 failed search and retry are distinct from no matches',async()=>{fixture.listErrors.add(101);fixture.listErrors.add(102);await page.getByRole('searchbox').press('Enter');await page.getByRole('alert').filter({hasText:'Search failed:'}).waitFor();assert.equal(await page.locator('.global-result').count(),0);fixture.listErrors.clear();await page.getByRole('button',{name:'Retry',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.global-result').length===3);});
  await check('12 cross-space no-match message',async()=>{await page.getByRole('searchbox').fill('nothing-matches-gf07');await page.getByRole('searchbox').press('Enter');await page.getByText('No matches for “nothing-matches-gf07”.',{exact:true}).waitFor();});
  await check('13 delayed old preview cannot replace new space',async()=>{await reset();let release;fixture.gate={matches:r=>r.path==='README.md',seen:false,promise:new Promise(r=>release=r)};await fileButton('README.md').click();await page.getByText('Loading preview…',{exact:true}).waitFor();for(let n=0;n<100&&!fixture.gate.seen;n++)await new Promise(r=>setTimeout(r,20));assert.equal(fixture.gate.seen,true);await page.getByLabel('Choose a space').selectOption('102');await fileButton('beta.md').click();await page.getByRole('heading',{name:'Synthetic Beta',exact:true}).waitFor();const completed=page.waitForResponse(r=>r.url().includes('/101/files/README.md'));release();fixture.gate=null;await (await completed).finished();await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));assert.equal(await page.getByRole('heading',{name:'Synthetic Alpha',exact:true}).count(),0);await shot('13-channel-scope');});
  await check('14 context transition clears visible old data and preview',async()=>{await reset();await fileButton('README.md').click();await page.getByRole('heading',{name:'Synthetic Alpha',exact:true}).waitFor();await page.evaluate(()=>window.__scopeChange());await page.getByText('Your context changed. Reload files.',{exact:true}).waitFor();assert.equal(await page.locator('.tree-file').count(),0);assert.equal(await page.getByRole('heading',{name:'Synthetic Alpha',exact:true}).count(),0);await shot('14-context-retired');});
  await check('15 context retry reloads same-channel files in new scope',async()=>{await page.getByRole('button',{name:'Retry',exact:true}).click();await fileButton('README.md').waitFor();assert.ok(requests.some(r=>r.scope==='B'&&r.kind==='list'));await shot('15-context-retry');});
  await check('15b single Retry fully recovers new-scope listing',async()=>{assert.equal(await page.getByText('Your context changed. Reload files.',{exact:true}).count(),0);assert.equal(await page.locator('.file-tree-wrap').getByRole('button',{name:'Retry',exact:true}).count(),0);await shot('15b-recovered');});
  await check('16 optional dependency unavailable is an honest error',async()=>{await reset();fixture.repoMode='unavailable';await page.reload();await page.getByRole('heading',{name:'Could not load spaces',exact:true}).waitFor({timeout:20000});await page.getByText(/Could not load spaces: Alpha synthetic: Optional Lore service unavailable/).waitFor();assert.equal(await page.getByText('No connected spaces yet',{exact:true}).count(),0);await shot('16-unavailable');});
  await check('17 optional dependency recovery through Retry',async()=>{fixture.repoMode='ok';await page.getByRole('button',{name:'Retry',exact:true}).click();await fileButton('README.md').waitFor();});
  await check('18 absent repository shows connected-space guidance',async()=>{fixture.repoMode='absent';await page.reload();await page.getByRole('heading',{name:'No connected spaces yet',exact:true}).waitFor();await page.getByText(/Open the Code view on a lore channel/).waitFor();await shot('18-absent');});
  await check('19 mobile Files controls stay within viewport',async()=>{await reset();await page.setViewportSize({width:390,height:844});await shot('19-mobile');const picker=await page.getByLabel('Choose a space').boundingBox();assert.ok(picker.x>=0&&picker.x+picker.width<=390,'space picker fits 390px viewport');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.setViewportSize({width:1440,height:900});});
  await check('20 no uncaught browser exceptions',async()=>{assert.deepEqual(pageErrors,[]);});
} catch(error) {
  results.push({name:'HARNESS',status:'FAIL',error:error.stack});console.error(error);
  if(page)await shot('harness-failure').catch(()=>{});
} finally {
  await browser?.close();await vite?.close();
  const summary={fixture:'Synthetic Lore HTTP, real FilesWorkspace/filesWorkspaceSession/api/lore; not external Lore integration',scratch,origin,passed:results.filter(r=>r.status==='PASS').length,failed:results.filter(r=>r.status==='FAIL').length,results,screenshots,requests,consoleErrors,pageErrors};
  await writeFile(`${scratch}/results.json`,JSON.stringify(summary,null,2));console.log(JSON.stringify(summary,null,2));
  if(summary.failed)process.exitCode=1;
}
