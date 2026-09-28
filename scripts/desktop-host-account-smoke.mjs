#!/usr/bin/env node
// Disposable real-Authority rehearsal; never opens an operator directory.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, readFile, writeFile, rm, cp, unlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import { randomBytes, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require=createRequire(new URL('../frontend/package.json',import.meta.url));
const { io }=require('socket.io-client');
assert.ok(process.argv[2], 'Supply a freshly compiled Authority binary');
const binary=resolve(process.argv[2]);
const root=await mkdtemp(join(tmpdir(),'wabi-host-account-'));
const running=new Set(); const sockets=new Set();
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function bounded(promise,ms,label) { let timer;try{return await Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error(`Timeout: ${label}`)),ms))]);}finally{clearTimeout(timer);} }
async function launch(data, host='127.0.0.1', fail=false) {
  await mkdir(data,{recursive:true});
  const env=Object.fromEntries(['PATH','SystemRoot','WINDIR','TEMP','TMP','HOME','USERPROFILE'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
  const bootstrapToken=randomBytes(32).toString('hex');
  Object.assign(env,{WABI_SERVER_ROLE:'authority',WABI_MESH_ENABLED:'false',WABI_LOG_DIR:join(root,'logs'),WABI_UPLOADS_DIR:join(data,'uploads'),WABI_DESKTOP_BOOTSTRAP_TOKEN:bootstrapToken});
  const child=spawn(binary,['--host',host,'--port','0','--data-dir',data,'--desktop-managed','--print-bound-address','--shutdown-on-stdin-close'],{env,cwd:root,stdio:['pipe','pipe','inherit'],windowsHide:true});
  running.add(child);
  const exit=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));}); exit.catch(()=>{});
  const lines=createInterface({input:child.stdout}); let announced=false;
  const announcement=new Promise((resolve,reject)=>{
    lines.on('line',line=>{try{const value=JSON.parse(line);if(value.event==='wabi-listener-bound'){announced=true;resolve(value);}}catch{}});
    exit.then(value=>reject(new Error(`Exited before readiness: ${JSON.stringify(value)}`)),reject);
  }); announcement.catch(()=>{});
  if(fail){const value=await bounded(exit,30000,'refuse unsafe startup');assert.notEqual(value.code,0);assert.equal(announced,false);running.delete(child);lines.close();return;}
  const record=await bounded(announcement,60000,'listener');assert.equal(record.pid,child.pid);
  const origin=`http://${record.address}`;
  let ready=false;const deadline=Date.now()+30000;
  while(Date.now()<deadline){try{if((await fetch(origin+'/readyz',{signal:AbortSignal.timeout(1000)})).ok){ready=true;break;}}catch{}await delay(100);}
  assert.ok(ready,'real readiness');
  return {child,exit,lines,origin,data,bootstrapToken};
}
async function stop(instance){instance.child.stdin.end();const result=await bounded(instance.exit,12000,'EOF drain with active clients');assert.deepEqual(result,{code:0,signal:null});instance.lines.close();running.delete(instance.child);}
async function api(instance,path,method='GET',body,token,status=200,bootstrap=false){
  const response=await fetch(instance.origin+path,{method,headers:{...(body?{'content-type':'application/json'}:{}),...(token?{authorization:`Bearer ${token}`} : {}),...(bootstrap?{'X-Wabi-Bootstrap-Token':instance.bootstrapToken}:{})},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(10000)});
  const text=await response.text();assert.equal(response.status,status,`${method} ${path}: ${text}`);return JSON.parse(text);
}
async function keys(data){return Promise.all(['jwt_secret','wabidb/root_key'].map(name=>readFile(join(data,name),'utf8')));}
try {
  await launch(join(root,'unclaimed'),'0.0.0.0',true);
  const data=join(root,'community');await mkdir(data,{recursive:true});
  await writeFile(join(data,'admin_policies.json'),JSON.stringify({auth_policy:{mode:'invite',allowRegister:true,allowGuest:false}}));
  let host=await launch(data);
  assert.equal((await api(host,'/api/setup/status')).setupRequired,true);
  const credentials={username:'hosting_owner',password:'Disposable-Hosting-Test-Only!',communityName:'Hosting smoke community'};
  await api(host,'/api/auth/register','POST',credentials,undefined,403);
  const owner=await api(host,'/api/auth/register','POST',credentials,undefined,200,true);
  const token=owner.accessToken;
  assert.equal((await api(host,'/api/setup/status')).setupRequired,false);
  await api(host,'/api/auth/register','POST',{username:'uninvited',password:credentials.password},undefined,403);
  await api(host,'/api/invites','POST',{expiresInHours:24},undefined,403);
  const invite=await api(host,'/api/invites','POST',{expiresInHours:24},token);
  const registry=await readFile(join(data,'join-invites-v1.json'),'utf8');assert.ok(!registry.includes(invite.token),'only token digests on disk');
  const member=await api(host,'/api/auth/register','POST',{username:'invited_member',password:credentials.password,inviteToken:invite.token});
  await api(host,'/api/auth/register','POST',{username:'replay_member',password:credentials.password,inviteToken:invite.token},undefined,403);
  await api(host,'/api/invites','POST',{expiresInHours:24},member.accessToken,403);
  const revoked=await api(host,'/api/invites','POST',{expiresInHours:1},token);
  await api(host,`/api/invites/${revoked.id}`,'DELETE',undefined,token);
  await api(host,'/api/auth/register','POST',{username:'revoked_member',password:credentials.password,inviteToken:revoked.token},undefined,403);
  const channel=await api(host,'/api/channels','POST',{name:'hosting-persistence',channel_type:'text'},token);
  const channelId=channel.id??channel.channel?.id;
  assert.ok(channelId,'persisted channel identity');
  await api(host,`/api/channels/${channelId}/join`,'POST',{},member.accessToken);
  await api(host,`/api/channels/${channelId}/retention`,'PUT',{retention:'forever'},token);
  const sent=await api(host,'/api/messages','POST',{channel_id:channelId,content:'Hosting restart canary',message_type:'text'},token);
  const bytes=Buffer.from('Hosting uploaded file canary');
  const upload=await api(host,'/api/upload/resumable/init','POST',{fileName:'hosting.txt',fileSize:bytes.length,mimeType:'text/plain',channelId},token);
  const chunk=await fetch(`${host.origin}/api/upload/resumable/chunk?uploadId=${encodeURIComponent(upload.uploadId)}&offset=0`,{method:'PUT',headers:{authorization:`Bearer ${token}`,'x-upload-token':upload.uploadToken,'content-type':'application/octet-stream'},body:bytes,signal:AbortSignal.timeout(10000)});
  assert.ok(chunk.ok,`upload chunk: ${chunk.status}`);
  const file=await api(host,'/api/upload/resumable/complete','POST',{uploadId:upload.uploadId,uploadToken:upload.uploadToken},token);
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  const verifyContent=async instance=>{
    const history=await api(instance,`/api/messages/${channelId}`,'GET',undefined,member.accessToken);
    assert.ok(history.messages.some(message=>message.id===sent.id&&message.content==='Hosting restart canary'),'member sees retained message');
    const download=await fetch(instance.origin+file.fileUrl,{headers:{authorization:`Bearer ${member.accessToken}`},signal:AbortSignal.timeout(10000)});
    assert.ok(download.ok,'member retrieves retained upload');
    assert.equal(hash(Buffer.from(await download.arrayBuffer())),hash(bytes));
  };
  await verifyContent(host);
  const preserved=await keys(data);
  const socket=io(host.origin,{auth:{token},transports:['websocket'],reconnection:false});sockets.add(socket);
  await bounded(new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',reject);}),10000,'actual Socket.IO client');
  await stop(host);socket.close();sockets.delete(socket);
  host=await launch(data);
  assert.deepEqual(await keys(data),preserved,'identity persists through restart');
  assert.equal((await api(host,'/api/auth/login','POST',credentials)).user.id,owner.user.id);
  await verifyContent(host);
  await api(host,'/api/auth/register','POST',{username:'replay_after_restart',password:credentials.password,inviteToken:invite.token},undefined,403);
  await stop(host);
  const restored=join(root,'restored');await cp(data,restored,{recursive:true,errorOnExist:true,force:false});
  host=await launch(restored);assert.deepEqual(await keys(restored),preserved);
  assert.equal((await api(host,'/api/auth/login','POST',credentials)).user.id,owner.user.id);
  await verifyContent(host);
  await api(host,'/api/auth/register','POST',{username:'replay_after_restore',password:credentials.password,inviteToken:invite.token},undefined,403);
  await stop(host);
  for (const missing of ['wabidb/root_key', 'wabidb/storage-manifest.json']) {
    const damaged = join(root, missing.endsWith('root_key') ? 'missing-key' : 'missing-manifest');
    await cp(data, damaged, { recursive: true, errorOnExist: true, force: false });
    await unlink(join(damaged, missing));
    await launch(damaged, '127.0.0.1', true);
    await assert.rejects(access(join(damaged, missing)), { code: 'ENOENT' }, 'missing identity/manifest must not be regenerated');
  }
  console.log('PASS: missing-key and missing-manifest recovery refusal on disposable copies.');
  console.log('PASS: protected local owner, fail-closed unclaimed exposure, invite admission/replay/revocation/role, Socket.IO EOF drain, identity/accounts/channels/messages/uploads restart and stopped-copy migration.');
  console.log('Not a native installer, cross-network private transport, physical media, or native restore-command acceptance test.');
} finally {
  for(const socket of sockets)socket.close();
  for(const child of running){if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await bounded(exited,5000,'cleanup').catch(()=>{});}}
  await rm(root,{recursive:true,force:true});
}
