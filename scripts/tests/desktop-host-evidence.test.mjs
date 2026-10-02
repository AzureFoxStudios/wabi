import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { buildEvidence, writeEvidence } from '../host-test-evidence.mjs';

function elf(id) { const b = Buffer.alloc(256, id); b.set([0x7f,69,76,70,2,1]); b.writeUInt16LE(62,18); return b; }
async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'wabi-evidence-'));
  const options = { revision: 'a'.repeat(40), target: 'x86_64-unknown-linux-gnu', installer:join(dir,'Wabi.AppImage'),server:join(dir,'wabi-server'),desktop:join(dir,'wabi-desktop') };
  try { await Promise.all(['installer','server','desktop'].map((key,i)=>writeFile(options[key],elf(i)))); await run(options,dir); }
  finally { await rm(dir,{recursive:true,force:true}); }
}
test('hashes actual bytes and never claims physical acceptance', async()=> fixture(async options=>{
  const result=await buildEvidence(options);
  assert.equal(result.artifacts[0].sha256,createHash('sha256').update(await readFile(options.installer)).digest('hex'));
  assert.equal(result.acceptance.cleanInstall,'not-run');
  assert.equal(result.acceptance.freshPrivateInvitation,'blocked-incomplete-transport');
  assert.equal(result.applicationIdentifier,'chat.wabi.hosttest');
}));
test('rejects missing or abbreviated source revisions',async()=>fixture(async o=>{
  for(const revision of [undefined,'cc7d917','not-a-commit']) await assert.rejects(buildEvidence({...o,revision}));
}));
test('rejects a raw Linux executable substituted for the installer',async()=>fixture(async o=>{
  await assert.rejects(buildEvidence({...o,installer:o.server}),/different file|installer/);
}));
test('rejects missing or empty artifacts',async()=>fixture(async o=>{
  await writeFile(o.desktop,''); await assert.rejects(buildEvidence(o),/nonempty/);
  await rm(o.desktop); await assert.rejects(buildEvidence(o));
}));
test('rejects wrong architecture',async()=>fixture(async o=>{
  const wrong=elf(3);wrong.writeUInt16LE(183,18);await writeFile(o.desktop,wrong);
  await assert.rejects(buildEvidence(o),/architecture/);
}));
test('rejects duplicate executable content across roles',async()=>fixture(async o=>{
  await writeFile(o.desktop,await readFile(o.server));await assert.rejects(buildEvidence(o),/identical/);
}));
test('refuses unsupported target and duplicate paths',async()=>fixture(async o=>{
  await assert.rejects(buildEvidence({...o,target:'../../escape'}));
  await assert.rejects(buildEvidence({...o,desktop:o.server}),/different/);
}));
test('never overwrites existing evidence',async()=>fixture(async(o,dir)=>{
  const path=join(dir,'evidence.json');const e=await buildEvidence(o);await writeEvidence(path,e);
  const original=await readFile(path);await assert.rejects(writeEvidence(path,{}),{code:'EEXIST'});
  assert.deepEqual(await readFile(path),original);
}));
test('rejects symlink artifacts', {skip: process.platform==='win32'},async()=>fixture(async(o,dir)=>{
  const link=join(dir,'linked-server');await symlink(o.server,link);
  await assert.rejects(buildEvidence({...o,server:link}),/symlink/);
}));

test('isolated test configuration leaves the normal identity unchanged',async()=>{
  const normal=JSON.parse(await readFile(new URL('../../src-tauri/tauri.conf.json',import.meta.url),'utf8'));
  const testing=JSON.parse(await readFile(new URL('../../src-tauri/tauri.hosttest.conf.json',import.meta.url),'utf8'));
  assert.equal(normal.identifier,'chat.wabi.app');
  assert.equal(testing.identifier,'chat.wabi.hosttest');
  assert.notEqual(testing.productName,normal.productName);
  assert.equal(testing.app.windows[0].label,'main');
  assert.equal(testing.bundle.linux.appimage.bundleMediaFramework,true);
});
