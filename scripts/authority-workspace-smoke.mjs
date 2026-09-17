// Real disposable Authority, separate registered accounts, restart and hostile requests.
// No operator data or existing credentials are used.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
import net from 'node:net';
const option=process.argv.indexOf('--binary');assert.ok(option>=0&&process.argv[option+1]);
const binary=path.resolve(process.argv[option+1]),root=await mkdtemp('/tmp/wabi-workspace-authority-');let child,origin;let assertions=0;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function start(){const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));origin=`http://127.0.0.1:${port}`;child=spawn(binary,['--data-dir',root+'/data','--host','127.0.0.1','--port',String(port)],{cwd:root,env:{PATH:process.env.PATH,WABI_UPLOADS_DIR:root+'/uploads',WABI_LOG_DIR:root+'/logs'},stdio:['ignore','pipe','pipe']});const log=createWriteStream(root+`/process-${Date.now()}.log`);child.stdout.pipe(log);child.stderr.pipe(log);for(let i=0;i<600;i++){if(child.exitCode!==null)throw Error('Authority exited; logs: '+root);try{if((await fetch(origin+'/readyz')).ok)return;}catch{}await sleep(100);}throw Error('Authority startup timeout');}
async function stop(){if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('Shutdown timeout')),15000);child.once('exit',()=>{clearTimeout(t);resolve();});});assert.equal(child.exitCode,0);}}
async function call(account,p,method='GET',body,expected=200){const r=await fetch(origin+p,{method,headers:{...(account?{Authorization:`Bearer ${account.accessToken}`}:{ }),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});const text=await r.text();assert.equal(r.status,expected,`${method} ${p}: ${text}`);assertions++;return text?JSON.parse(text):null;}
const op=()=>randomUUID();
try{
 await start();const accounts=[];for(const username of ['workspace_owner','workspace_editor','workspace_reviewer','workspace_outsider'])accounts.push(await call(null,'/api/auth/register','POST',{username,password:'Disposable-Workspace-2026!'}));
 const [owner,editor,reviewer,outsider]=accounts;
 const ownerId=owner.user.id,editorId=editor.user.id,reviewerId=reviewer.user.id;
 await call(owner,'/api/artifacts/capabilities','PUT',{opId:op(),sheets:true,present:true});
 const id=op();let a=(await call(owner,'/api/artifacts/','POST',{id,opId:op(),kind:'document',fields:{title:'Shared fixture',text:'a😀b',format:'markdown'},mode:'live',channelId:null,channelAccess:'viewer',grants:{[editorId]:'editor',[reviewerId]:'commenter'}})).artifact;
 await call(outsider,'/api/artifacts/'+id,'GET',undefined,404);
 const listed=await call(outsider,'/api/artifacts/');assert.ok(!JSON.stringify(listed).includes('Shared fixture'));
 await call(reviewer,'/api/artifacts/'+id,'PATCH',{opId:op(),generation:a.generation,changes:[{key:'text',expected:1,value:'forged',remove:false}]},403);
 a=(await call(editor,'/api/artifacts/'+id,'PATCH',{opId:op(),generation:a.generation,changes:[{key:'text',expected:1,value:null,remove:false,textPatch:{start:1,delete:1,insert:'😺'}}]})).artifact;assert.equal(a.fields.text,'a😺b');
 await call(editor,'/api/artifacts/'+id,'PATCH',{opId:op(),generation:1,changes:[{key:'text',expected:1,value:'stale',remove:false}]},409);
 a=(await call(owner,'/api/artifacts/'+id,'PATCH',{opId:op(),generation:1,changes:[{key:'title',expected:1,value:'Independent title',remove:false}]})).artifact;
 assert.equal(a.fields.text,'a😺b');
 await call(owner,'/api/artifacts/'+id,'PATCH',{opId:op(),generation:1,changes:[{key:'grants',expected:0,value:{},remove:false}]},400);
 // A rejected schema must not poison the durable writer.
 a=(await call(editor,'/api/artifacts/'+id,'PATCH',{opId:op(),generation:1,changes:[{key:'text',expected:a.versions.text,value:'after invalid request',remove:false}]})).artifact;
 await call(owner,'/api/artifacts/','POST',{id,opId:op(),kind:'document',fields:{title:'newer local work',text:'do not acknowledge this as published',format:'text'},mode:'live',channelId:null,channelAccess:'viewer',grants:{}},409);
 assert.equal((await call(owner,'/api/artifacts/'+id)).artifact.fields.text,'after invalid request');
 const oldGeneration=a.generation;
 a=(await call(owner,'/api/artifacts/'+id+'/permissions','PUT',{opId:op(),revision:a.revision,channelId:null,channelAccess:'viewer',grants:{[reviewerId]:'commenter'}})).artifact;
 await call(editor,'/api/artifacts/'+id,'GET',undefined,404);
 await call(owner,'/api/artifacts/'+id,'PATCH',{opId:op(),generation:oldGeneration,changes:[{key:'text',expected:a.versions.text,value:'old epoch',remove:false}]},409);
 const acknowledged=structuredClone(a);await stop();await start();const recovered=(await call(owner,'/api/artifacts/'+id)).artifact;assert.deepEqual(recovered,acknowledged);assertions++;
 const channel=await call(owner,'/api/channels','POST',{name:'workspace-room',channel_type:'text'}),channelId=channel.id??channel.channel?.id;
 const page={id:op(),title:'Audience title',body:'Audience only',layout:'body',image:null,theme:'paper',aspect:16/9},sessionId=op();
 const sess=(await call(owner,'/api/artifacts/presentations','POST',{id:sessionId,opId:op(),channelId,title:'Talk',pages:[page]})).presentation;
 await call(outsider,'/api/artifacts/presentations/'+sessionId,'GET',undefined,404);
 await call(owner,'/api/artifacts/presentations','POST',{id:op(),opId:op(),channelId,title:'Must reject notes',pages:[{...page,notes:'SECRET'}]},422);
 const pub=await call(owner,'/api/artifacts/presentations/'+sessionId);assert.ok(!JSON.stringify(pub).includes('notes'));assert.equal(pub.controllerOnline,false);
 await call(owner,'/api/artifacts/presentations/'+sessionId+'/heartbeat','POST',{generation:1});assert.equal((await call(owner,'/api/artifacts/presentations/'+sessionId)).controllerOnline,true);
 await call(owner,'/api/artifacts/presentations/'+sessionId+'/control','POST',{opId:op(),generation:1,sequence:1,blank:true,end:false});
 await call(owner,'/api/artifacts/presentations/'+sessionId+'/control','POST',{opId:op(),generation:1,sequence:1,blank:false,end:false},409);
 await stop();await start();const resumed=await call(owner,'/api/artifacts/presentations/'+sessionId);assert.equal(resumed.controllerOnline,false);assert.equal(resumed.presentation.blank,true);assert.equal(resumed.presentation.slideId,page.id);assertions++;
 await stop();const report={passed:true,assertions,binarySha256:createHash('sha256').update(await readFile(binary)).digest('hex'),limits:['Disposable HTTP clients, not physical-device acceptance','Browser client merge tested separately','No full compatibility or performance certification']};await writeFile(root+'/report.json',JSON.stringify(report,null,2));console.log(`PASS ${assertions} real Authority checks; report ${root}/report.json`);
}finally{if(child&&child.exitCode===null)child.kill('SIGTERM');}
