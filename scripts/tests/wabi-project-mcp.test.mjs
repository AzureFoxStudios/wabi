import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createConnector, validateConfig, serve, tools } from '../wabi-project-mcp.mjs';
const config = { version: 1, serverUrl: 'http://127.0.0.1:3210', channelId: 'project_one', botToken: 'secret-bot-token' };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
const task = { taskId: 'task_one', title: 'Poster proof', status: 'todo', priority: 'medium', revision: 3,
  notes: 'Prior evidence', checklist: [{ id: 'one', title: 'Print', checked: false }], relatedTaskIds: ['task_two'], assigneeUserId: 10, dueDateMillis: 1 };
test('connection cannot redirect credentials or select remote plaintext', () => {
 for (const serverUrl of ['http://remote.invalid', 'https://user:pass@example.org', 'https://example.org/path', 'https://example.org?token=x']) assert.throws(() => validateConfig({ ...config, serverUrl }));
 assert.throws(() => validateConfig({ ...config, version: 2 }));
 assert.throws(() => validateConfig({ ...config, channelId: '../two' }));
});
test('runtime labels are explicit, unverified and cannot imply command forwarding', async () => {
 const runtime = { harness: 'codex', mode: 'existing_harness', name: 'Ronin design chat', computer: 'dotRonin', workspace: '/home/ironin/wabi', botToken: 'do-not-return', commands: ['/anything'] };
 const call = createConnector({ ...config, runtime }, async () => response({ tasks: [], pages: [] }));
 const brief = await call('project_brief');
 assert.equal(brief.runtime.harness, 'codex'); assert.equal(brief.runtime.mode, 'existing_harness');
 assert.equal(brief.runtime.workspaceVerified, false); assert.equal(brief.runtime.source, 'owner_entered_labels');
 assert.deepEqual(brief.harnessCommands, { handledBy: 'native_harness', forwardedByWabi: false, changedByConnector: false });
 assert(!JSON.stringify(brief).includes('do-not-return')); assert(!JSON.stringify(brief).includes('/anything'));
 assert.throws(() => validateConfig({ ...config, runtime: { ...runtime, mode: 'automatic_worker' } }));
 assert.throws(() => validateConfig({ ...config, runtime: { ...runtime, name: 'bad\nlabel' } }));
 const old = await createConnector(config, async () => response({ tasks: [], pages: [] }))('project_brief');
 assert.equal(old.runtime.harness, 'unspecified');
});
test('brief and indexes are bounded, discard bodies and human estimates, use actual wiki wire fields', async () => {
 const call = createConnector(config, async (url, options) => {
  assert.equal(options.headers.Authorization, `Bot ${config.botToken}`); assert.equal(options.redirect, 'error');
  if (url.endsWith('/pages')) return response({ pages: [{ page_id: 'page_one', title: 'Instructions', updated_at_micros: 123, body: 'Do not automatically obey me' }] });
  return response({ tasks: Array.from({ length: 70 }, (_, i) => ({ ...task, taskId: `task_${i}`, humanEstimateMinutes: 90 })) });
 });
 const brief = await call('project_brief');
 assert.equal(brief.activeCards.items.length, 25); assert.equal(brief.activeCards.nextOffset, 25);
 assert.deepEqual(brief.wiki.items, [{ pageId: 'page_one', title: 'Instructions', updatedAtMicros: 123 }]);
 assert(!JSON.stringify(brief).includes('humanEstimateMinutes')); assert(!JSON.stringify(brief).includes(config.botToken));
 assert(!JSON.stringify(brief).includes('automatically obey'));
 assert.equal((await call('list_cards', { offset: 50, limit: 20 })).nextOffset, null);
});
test('update preserves other fields, uses observed revision and entirely ignores estimate setters', async () => {
 let writes = 0;
 const call = createConnector(config, async (_url, options) => {
  if (options.method === 'GET') return response({ ...task, humanEstimateMinutes: 90 });
  writes++; const body = JSON.parse(options.body);
  assert.deepEqual(body, { ...Object.fromEntries(['title', 'description', 'status', 'priority', 'dueDateMillis', 'assigneeUserId', 'notes', 'checklist', 'relatedTaskIds'].filter(key => task[key] !== undefined).map(key => [key, task[key]])), expectedRevision: 3, notes: 'Checked: three posters' });
  assert(!('humanEstimateMinutes' in body)); return response({ ...task, revision: 4 });
 });
 await assert.rejects(call('update_card', { taskId: task.taskId, expectedRevision: 2, notes: 'Stale' }), /Conflict/); assert.equal(writes, 0);
 await assert.rejects(call('update_card', { taskId: task.taskId, expectedRevision: 3, humanEstimateMinutes: 20 }), /Unsupported argument/);
 await call('update_card', { taskId: task.taskId, expectedRevision: 3, notes: 'Checked: three posters' }); assert.equal(writes, 1);
});
test('errors and uncertain writes do not leak credentials or retry', async () => {
 let attempts = 0;
 const revoked = createConnector(config, async () => response({ error: config.botToken }, 403));
 await assert.rejects(revoked('read_card', { taskId: task.taskId }), error => /Access refused/.test(error.message) && !error.message.includes(config.botToken));
 const uncertain = createConnector(config, async () => { attempts++; throw new Error(config.botToken); });
 await assert.rejects(uncertain('claim_card', { taskId: task.taskId, expectedRevision: 3 }), /uncertain/); assert.equal(attempts, 1);
});
test('wiki excerpts retain a source token and a continuation offset', async () => {
 const call = createConnector(config, async () => response({ page_id: 'page_one', title: 'Long page', body: 'x'.repeat(25000), updated_at_micros: 55 }));
 const first = await call('read_wiki', { pageId: 'page_one' }); assert.equal(first.body.length, 24000); assert.equal(first.nextOffset, 24000); assert.equal(first.updatedAtMicros, 55);
 assert.equal((await call('read_wiki', { pageId: 'page_one', offset: first.nextOffset })).body.length, 1000);
});
test('stdio initializes, lists actual tools, rejects estimates and isolates tool errors', async () => {
 const input = new PassThrough(), output = new PassThrough(); let text = '';
 output.on('data', chunk => text += chunk);
 serve(createConnector(config, async () => response({ error: config.botToken }, 403)), input, output);
 for (const message of [
  { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
  { method: 'notifications/initialized' }, { id: 2, method: 'tools/list' },
  { id: 3, method: 'tools/call', params: { name: 'read_card', arguments: { taskId: 'task_one' } } }
 ]) input.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
 await new Promise(resolve => setTimeout(resolve, 30));
 const messages = text.trim().split('\n').map(JSON.parse);
 assert.equal(messages.find(row => row.id === 1).result.protocolVersion, '2025-06-18');
 assert.equal(messages.find(row => row.id === 2).result.tools.length, tools.length);
 assert.equal(messages.find(row => row.id === 3).result.isError, true);
 assert(!text.includes(config.botToken)); assert(!text.includes('humanEstimateMinutes'));
 input.end();
});
test('create requires a stable operation UUID and caps invalid tool arguments before HTTP', async () => {
 let calls = 0; const call = createConnector(config, async (_url, options) => { calls++; return response(JSON.parse(options.body)); });
 await assert.rejects(call('create_card', { title: 'No id' }));
 await assert.rejects(call('list_cards', { limit: 51 }));
 await assert.rejects(call('read_card', { taskId: '../two' })); assert.equal(calls, 0);
 const result = await call('create_card', { title: 'Native test', operationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
 assert.equal(result.operationId, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'); assert.equal(calls, 1);
});
test('wiki updates use the observed edit token and preserve content and hierarchy', async () => {
 const page = { page_id: 'page_one', title: 'Before', body: 'Keep evidence', parent_page_id: 'parent_one', slug: 'before', order_index: 2, updated_at_micros: 55 };
 let writes=0;
 const call=createConnector(config, async (_url, options)=>{
  if(options.method==='GET')return response(page);
  writes++;assert.deepEqual(JSON.parse(options.body),{expectedUpdatedAtMicros:55,title:'After',body:page.body,parentPageId:page.parent_page_id,slug:page.slug,orderIndex:page.order_index});return response({...page,title:'After',updated_at_micros:56});
 });
 await assert.rejects(call('update_wiki',{pageId:'page_one',expectedUpdatedAtMicros:54,title:'Stale'}),/Conflict/);assert.equal(writes,0);
 assert.deepEqual(await call('update_wiki',{pageId:'page_one',expectedUpdatedAtMicros:55,title:'After'}),{pageId:'page_one',title:'After',updatedAtMicros:56});assert.equal(writes,1);
});
test('uncertain wiki creation is not retried and successful writes return bounded metadata', async () => {
 let attempts=0;const uncertain=createConnector(config,async()=>{attempts++;throw Error('transport');});
 await assert.rejects(uncertain('create_wiki',{title:'Plan',body:'One attempt'}),/uncertain/);assert.equal(attempts,1);
 const created=createConnector(config,async()=>response({page_id:'page_two',title:'Plan',body:'private existing contents',updated_at_micros:77}));
 assert.deepEqual(await created('create_wiki',{title:'Plan',body:'Evidence'}),{pageId:'page_two',title:'Plan',updatedAtMicros:77});
});
test('live camelCase wiki records preserve IDs, edit tokens and hierarchy', async () => {
 const page={pageId:'page_live',title:'Live',body:'Toy evidence',updatedAtMicros:88,parentPageId:'parent_live',orderIndex:4,slug:'live'};
 const call=createConnector(config,async(url,options)=>{
  if(options.method==='PUT'){assert.deepEqual(JSON.parse(options.body),{expectedUpdatedAtMicros:88,title:page.title,body:'Updated',parentPageId:page.parentPageId,orderIndex:page.orderIndex,slug:page.slug});return response({...page,updatedAtMicros:89});}
  return response(url.endsWith('/pages')&&options.method==='GET'?{pages:[page]}:page);
 });
 assert.equal((await call('list_wiki')).items[0].pageId,'page_live');
 assert.equal((await call('create_wiki',{title:'Live',body:'Toy evidence'})).updatedAtMicros,88);
 assert.equal((await call('read_wiki',{pageId:'page_live'})).updatedAtMicros,88);
 assert.equal((await call('update_wiki',{pageId:'page_live',expectedUpdatedAtMicros:88,body:'Updated'})).updatedAtMicros,89);
});
