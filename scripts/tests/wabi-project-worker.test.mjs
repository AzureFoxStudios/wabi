import { test } from 'node:test';
import assert from 'node:assert/strict';
import { origin, parseAction, runWorker } from '../wabi-project-worker.mjs';
const config={wabi:'http://127.0.0.1:1',channel:'project_a',botToken:'private-bot-token',provider:'http://127.0.0.1:2',apiKey:'private-provider-key',model:'free-test'};
const response=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
test('origins and actions fail closed',()=>{
 assert.throws(()=>origin('http://remote.invalid','server'));
 assert.throws(()=>origin('https://name:secret@example.org','server'));
 assert.throws(()=>parseAction('do something'));
 assert.throws(()=>parseAction('{"tool":"complete","arguments":[]}'));
 assert.equal(parseAction('```json\n{"tool":"complete","arguments":{"reply":"done"}}\n```').tool,'complete');
});
test('provider sees no credentials; a completed action stops the bounded worker',async()=>{
 let run={runId:'run_a',revision:1,attempt:0,status:'queued',mode:'chat',prompt:'Hello',steps:[],leaseUntilMicros:Date.now()*1000+120_000_000}; let providers=0;
 const fetcher=async(url,options)=>{
  if(url.startsWith(config.provider)) {
   providers++; assert.equal(options.headers.Authorization,'Bearer private-provider-key');
   assert(!options.body.includes('private-bot-token'));assert(!options.body.includes('private-provider-key'));
   return response({choices:[{message:{content:'{"tool":"complete","arguments":{"reply":"Hello there"}}'}}]});
  }
  assert.equal(options.headers.Authorization,'Bot private-bot-token');
  if(url.endsWith('/runs')) return response({runs:[run]});
  if(url.endsWith('/claim')) {run={...run,status:'running',revision:2,attempt:1};return response(run);}
  const action=JSON.parse(options.body);assert.equal(action.expectedRevision,2);assert.equal(action.attempt,1);
  run={...run,status:'completed',revision:3,reply:action.arguments.reply};return response(run);
 };
 const done=await runWorker(config,{once:true,fetcher}); assert.equal(done.status,'completed');assert.equal(providers,1);
});
test('human takeover during generation stops before an edit and is not retried',async()=>{
 let run={runId:'run_a',revision:1,attempt:0,status:'queued',mode:'work',prompt:'Create a card',steps:[],leaseUntilMicros:Date.now()*1000+120_000_000};let edits=0,providerCalls=0;
 const fetcher=async(url,options)=>{
  if(url.startsWith(config.provider)) {providerCalls++;run={...run,status:'taken_over',attempt:2,revision:3};return response({choices:[{message:{content:'{"tool":"create_card","arguments":{"title":"No","status":"todo","priority":"medium"}}'}}]});}
  if(url.endsWith('/runs'))return response({runs:[run]});
  if(url.endsWith('/claim')){run={...run,status:'running',revision:2,attempt:1};return response(run);}
  edits++;return new Response('{}',{status:409});
 };
 const stopped=await runWorker(config,{once:true,fetcher});assert.equal(edits,0);assert.equal(providerCalls,1);assert.equal(stopped.status,'taken_over');
});
test('empty reasoning-only response records failure without retry or Project edits',async()=>{
 let run={runId:'run_a',revision:1,attempt:0,status:'queued',mode:'work',prompt:'Disposable test',steps:[],leaseUntilMicros:Date.now()*1000+120_000_000};let providerCalls=0,actions=[];
 const settings={...config,provider:'https://openrouter.ai',reasoningEffort:'none',maxTokens:8192};
 const fetcher=async(url,options)=>{
  if(url.startsWith(settings.provider)) {
   providerCalls++;const body=JSON.parse(options.body);
   assert.equal(body.max_tokens,8192);assert.deepEqual(body.response_format,{type:'json_object'});assert.deepEqual(body.reasoning,{effort:'none'});
   return response({model:'free-test',choices:[{finish_reason:'length',message:{content:''}}]});
  }
  if(url.endsWith('/runs'))return response({runs:[run]});
  if(url.endsWith('/claim')){run={...run,status:'running',revision:2,attempt:1};return response(run);}
  const action=JSON.parse(options.body);actions.push(action.tool);
  assert.match(action.arguments.reply,/no action content/);run={...run,status:'failed',revision:3};return response(run);
 };
 await assert.rejects(runWorker(settings,{once:true,fetcher}));assert.equal(providerCalls,1);assert.deepEqual(actions,['fail']);assert.equal(run.status,'failed');
 await assert.rejects(runWorker({...settings,maxTokens:200000},{once:true,fetcher}));assert.equal(providerCalls,1);
});
test('invalid later response preserves the completed write and reports partial progress honestly',async()=>{
 let run={runId:'run_a',revision:1,attempt:0,status:'queued',mode:'work',prompt:'Disposable test',steps:[],leaseUntilMicros:Date.now()*1000+120_000_000}; let calls=0;
 const fetcher=async(url,options)=>{
  if(url.startsWith(config.provider)) return response({choices:[{message:{content:++calls === 1 ? '{"tool":"create_card","arguments":{"title":"Fixture"}}' : 'invalid'}}]});
  if(url.endsWith('/runs')) return response({runs:[run]});
  if(url.endsWith('/claim')) {run={...run,status:'running',revision:2,attempt:1};return response(run);}
  const action=JSON.parse(options.body);
  if(action.tool==='create_card') {run={...run,revision:3,steps:[{tool:action.tool,arguments:action.arguments,result:{taskId:'fixture'}}]};return response(run);}
  assert.equal(action.tool,'fail');assert.match(action.arguments.reply,/Earlier recorded steps remain applied/);assert(!action.arguments.reply.includes('no edit was attempted'));
  run={...run,status:'failed',revision:4};return response(run);
 };
 await assert.rejects(runWorker(config,{once:true,fetcher}));assert.equal(run.steps.length,1);assert.equal(calls,2);
});

test('expired attempt makes no provider call or failure write',async()=>{
 let run={runId:'run_a',revision:1,attempt:0,status:'queued',mode:'work',prompt:'Fixture',steps:[]};
 let providers=0,steps=0;
 const fetcher=async(url)=>{
  if(url.startsWith(config.provider)){providers++;throw new Error('Must not call provider');}
  if(url.endsWith('/runs'))return response({runs:[run]});
  if(url.endsWith('/claim')){run={...run,status:'running',revision:2,attempt:1,leaseUntilMicros:Date.now()*1000-1};return response(run);}
  steps++;throw new Error('Must not write');
 };
 await runWorker(config,{once:true,fetcher});
 assert.equal(providers,0);assert.equal(steps,0);
});

test('returning worker discards a response after a replacement attempt starts',async()=>{
 let run={runId:'run_a',revision:1,attempt:0,status:'queued',mode:'work',prompt:'Fixture',steps:[]};
 let steps=0;
 const fetcher=async(url)=>{
  if(url.startsWith(config.provider)){
   run={...run,attempt:3,revision:4};
   return response({choices:[{message:{content:'{"tool":"create_card","arguments":{"title":"Stale"}}'}}]});
  }
  if(url.endsWith('/runs'))return response({runs:[run]});
  if(url.endsWith('/claim')){run={...run,status:'running',revision:2,attempt:1,leaseUntilMicros:Date.now()*1000+120_000_000};return response(run);}
  steps++;throw new Error('Old worker must not edit or fail the new attempt');
 };
 await runWorker(config,{once:true,fetcher});assert.equal(steps,0);assert.equal(run.attempt,3);
});

test('replacement worker receives recorded steps without replaying their writes',async()=>{
 const recorded={tool:'create_card',arguments:{title:'Already created'},result:{taskId:'saved_card'}};
 let run={runId:'run_a',revision:5,attempt:2,status:'queued',mode:'work',prompt:'Fixture',steps:[recorded]};
 const actions=[];
 const fetcher=async(url,options)=>{
  if(url.startsWith(config.provider)){
   const messages=JSON.parse(options.body).messages;
   assert(messages.some(m=>m.content==='Recorded tool result: '+JSON.stringify(recorded.result)));
   return response({choices:[{message:{content:'{"tool":"complete","arguments":{"reply":"Continued from the saved card"}}'}}]});
  }
  if(url.endsWith('/runs'))return response({runs:[run]});
  if(url.endsWith('/claim')){run={...run,status:'running',revision:6,attempt:3,leaseUntilMicros:Date.now()*1000+120_000_000};return response(run);}
  const action=JSON.parse(options.body);actions.push(action.tool);assert.equal(action.attempt,3);
  run={...run,status:'completed',revision:7};return response(run);
 };
 await runWorker(config,{once:true,fetcher});assert.deepEqual(actions,['complete']);
});

test('enrolled backup resumes only a permitted expired run and sends its own worker ID',async()=>{
 const workerId='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
 const settings={...config,workerId,workerName:'My backup'};
 let run={runId:'run_a',revision:5,attempt:1,status:'running',mode:'work',prompt:'Fixture',steps:[{tool:'create_card',arguments:{title:'Saved'},result:{taskId:'existing_card'}}],workerId:'old_worker',leaseUntilMicros:1,recoveryCount:0,recoveryPolicy:{automatic:true,backupWorkerIds:[workerId],maxRecoveries:1}};
 const endpoints=[];
 const fetcher=async(url,options)=>{
  if(url.startsWith(config.provider))return response({choices:[{message:{content:'{"tool":"complete","arguments":{"reply":"Resumed"}}'}}]});
  endpoints.push(url);
  if(url.endsWith('/workers')){assert.equal(JSON.parse(options.body).workerId,workerId);return response({});}
  if(url.endsWith('/runs'))return response({runs:[run],serverNowMicros:Date.now()*1000});
  const body=JSON.parse(options.body);assert.equal(body.workerId,workerId);
  if(url.endsWith('/claim')){assert.equal(body.expectedRevision,5);run={...run,workerId,attempt:2,revision:6,leaseUntilMicros:Date.now()*1000+120_000_000};return response(run);}
  assert.equal(body.tool,'complete');run={...run,status:'completed',revision:7};return response(run);
 };
 const done=await runWorker(settings,{once:true,fetcher});assert.equal(done.status,'completed');assert(endpoints[0].endsWith('/workers'));
});

test('no automatic consent or an uncertain pending action makes no claim or provider call',async()=>{
 const settings={...config,workerId:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',workerName:'Backup'};
 for(const [automatic,pending] of [[false,null],[true,{tool:'create_card'}]]){
  let unexpected=0;
  const fetcher=async url=>{
   if(url.endsWith('/workers'))return response({});
   if(url.endsWith('/runs'))return response({runs:[{status:'running',leaseUntilMicros:1,pending,workerId:'old_worker',recoveryCount:0,recoveryPolicy:{automatic,backupWorkerIds:[settings.workerId],maxRecoveries:1}}]});
   unexpected++;throw new Error('Must not claim or call a model');
  };
  await runWorker(settings,{once:true,fetcher});assert.equal(unexpected,0);
 }
});

test('registered worker stops before a model call when the addon is disabled',async()=>{
 const settings={...config,workerId:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',workerName:'Computer'};
 let providerCalls=0;
 const fetcher=async url=>{
  if(url.endsWith('/workers'))return response({});
  if(url.endsWith('/runs'))return response({workersEnabled:false,runs:[]});
  providerCalls++;throw new Error('Must not call provider');
 };
 await assert.rejects(runWorker(settings,{once:true,fetcher}),/addon is disabled/);assert.equal(providerCalls,0);
});
