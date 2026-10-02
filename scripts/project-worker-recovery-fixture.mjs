// Two-computer acceptance only. Real Wabi HTTP/auth/leases, deterministic
// provider stub: no external model or paid session is launched.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {runWorker} from './wabi-project-worker.mjs';
const [connection,role,output,originOverride]=process.argv.slice(2);
if(!connection || !['primary','backup','returning'].includes(role) || !output)throw new Error('Use CONNECTION primary|backup|returning OUTPUT [LOOPBACK_ORIGIN]');
const raw=JSON.parse(await readFile(connection,'utf8'));
const config={...raw,wabi:originOverride??raw.wabi,workerId:role==='backup'?raw.backupId:raw.primaryId,workerName:role==='backup'?'Backup test computer':'Primary test computer'};
const base=`${config.wabi}/api/projects/${config.channel}`;
const getRuns=async()=>{const response=await fetch(`${base}/runs`,{headers:{Authorization:`Bot ${config.botToken}`},redirect:'error'});assert.equal(response.status,200);return (await response.json()).runs;};
if(role==='returning'){
 const run=(await getRuns()).find(r=>r.status==='completed');assert(run);
 const response=await fetch(`${base}/runs/${run.runId}/step`,{method:'POST',redirect:'error',headers:{Authorization:`Bot ${config.botToken}`,'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:run.revision,attempt:run.attempt-1,workerId:raw.primaryId,operationId:randomUUID(),tool:'create_card',arguments:{title:'Stale worker must not create this',status:'todo',priority:'medium'}})});
 assert.equal(response.status,409);await writeFile(output,JSON.stringify({returningWorkerRejected:true,status:response.status}),{mode:0o600});
}else{
 let calls=0;const controller=new AbortController();
 const fetcher=async(url,options)=>{
  if(!url.startsWith(config.provider+'/'))return fetch(url,options);
  calls++;
  if(role==='primary'){
   if(calls===1)return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({tool:'create_card',arguments:{title:'Two-computer recovery fixture',status:'todo',priority:'medium'}})}}]}));
   return new Promise((_,reject)=>{options.signal.addEventListener('abort',()=>reject(new Error('Fixture generation stopped')),{once:true});});
  }
  const body=JSON.parse(options.body);
  assert(body.messages.some(m=>m.content.startsWith('Recorded tool result: ') && m.content.includes('taskId')),'Backup must see the saved card result');
  return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({tool:'complete',arguments:{reply:'Resumed the saved step on the backup without creating a duplicate card.'}})}}]}));
 };
 await runWorker(config,{fetcher,signal:controller.signal,onProgress:event=>{
  if(role==='primary' && event.steps===1){void getRuns().then(runs=>{const run=runs.find(r=>r.runId===event.runId);return writeFile(output,JSON.stringify({runId:run.runId,attempt:run.attempt,revision:run.revision,steps:run.steps.length}),{mode:0o600});});}
  if(role==='backup' && event.status==='completed'){void writeFile(output,JSON.stringify({completed:true,providerCalls:calls}),{mode:0o600});controller.abort();}
 }});
}
