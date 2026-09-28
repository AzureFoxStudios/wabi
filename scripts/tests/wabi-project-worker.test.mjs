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
 let run={runId:'run_a',revision:1,attempt:0,status:'queued',mode:'chat',prompt:'Hello',steps:[]}; let providers=0;
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
 let run={runId:'run_a',revision:1,attempt:0,status:'queued',mode:'work',prompt:'Create a card',steps:[]};let edits=0,providerCalls=0;
 const fetcher=async(url,options)=>{
  if(url.startsWith(config.provider)) {providerCalls++;run={...run,status:'taken_over',attempt:2,revision:3};return response({choices:[{message:{content:'{"tool":"create_card","arguments":{"title":"No","status":"todo","priority":"medium"}}'}}]});}
  if(url.endsWith('/runs'))return response({runs:[run]});
  if(url.endsWith('/claim')){run={...run,status:'running',revision:2,attempt:1};return response(run);}
  edits++;return new Response('{}',{status:409});
 };
 await assert.rejects(runWorker(config,{once:true,fetcher}));assert.equal(edits,1);assert.equal(providerCalls,1);assert.equal(run.status,'taken_over');
});
test('empty reasoning-only response records failure without retry or Project edits',async()=>{
 let run={runId:'run_a',revision:1,attempt:0,status:'queued',mode:'work',prompt:'Disposable test',steps:[]};let providerCalls=0,actions=[];
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
 let run={runId:'run_a',revision:1,attempt:0,status:'queued',mode:'work',prompt:'Disposable test',steps:[]}; let calls=0;
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
