// Smoke-test a running Sabi server: log in as each demo user and fetch every read model.
// Usage: node scripts/smoke-api.mjs [baseUrl]
const base = process.argv[2] ?? 'http://localhost:8080';
const headers = { 'content-type': 'application/json', origin: base };
async function login(username) {
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers, body: JSON.stringify({ username, password: 'demo1234' }) });
  if (!r.ok) throw new Error(`login ${username}: ${r.status} ${await r.text()}`);
  return r.headers.get('set-cookie').split(';')[0];
}
const fails = [];
function need(obj, keys, where) {
  for (const k of keys) if (!(k in (obj ?? {}))) fails.push(`${where}: missing ${k}`);
}
async function get(cookie, path) {
  const r = await fetch(`${base}/api/${path}`, { headers: { cookie } });
  if (!r.ok) {
    fails.push(`GET ${path} → ${r.status} ${(await r.text()).slice(0, 200)}`);
    return null;
  }
  return r.json();
}
const cookie = await login('owner');
const boot = await get(cookie, 'bootstrap');
need(boot, ['user', 'company', 'users', 'pack', 'jurisdiction', 'today'], 'bootstrap');
const att = await get(cookie, 'attention');
need(att, ['approvals', 'tasks', 'nextSteps', 'docsWaiting', 'mentions', 'money', 'stock', 'changes'], 'attention');
const jobs = await get(cookie, 'jobs');
console.log('jobs', jobs.length);
for (const j of jobs) {
  const w = await get(cookie, `jobs/${j.id}`);
  need(w, ['job', 'jobType', 'state', 'party', 'contact', 'contacts', 'pipeline', 'transitions', 'messages', 'docMessages', 'lastRead', 'tasks', 'fulfilment', 'documents', 'approvals', 'creatable', 'money', 'materials', 'materialCost', 'wht', 'payments', 'timeline', 'files'], `job ${j.number}`);
}
const docs = await get(cookie, 'documents');
console.log('documents', docs.length);
for (const d of docs) {
  const v = await get(cookie, `documents/${d.id}`);
  need(v, ['document', 'docType', 'state', 'pipeline', 'party', 'job', 'source', 'children', 'conversions', 'transitions', 'approvals', 'issues', 'payments', 'balance', 'money', 'wht', 'seller', 'buyer', 'sellerIdentity', 'buyerIdentity', 'words', 'promptpay', 'items', 'messages', 'files', 'timeline'], `doc ${d.number}`);
  for (const w of v?.wht ?? []) need(w, ['label', 'amount', 'category'], `doc ${d.number} wht`);
}
const parties = await get(cookie, 'parties');
for (const p of parties) need(await get(cookie, `parties/${p.id}`), ['party', 'contacts', 'jobs', 'documents', 'payments', 'balance', 'messages', 'files', 'tasks', 'timeline'], `party ${p.name}`);
const items = await get(cookie, 'items');
for (const i of items) need(await get(cookie, `items/${i.id}`), ['item', 'stock', 'reservedBy', 'moves', 'timeline'], `item ${i.sku}`);
need(await get(cookie, 'money'), ['receivables', 'payables', 'agingReceivable', 'agingPayable', 'payments', 'inThisMonth', 'outThisMonth', 'vat'], 'money');
const month = boot.today.slice(0, 7);
for (const r of ['vat-sales', 'vat-purchases', 'wht', 'stock', 'trial-balance']) await get(cookie, `reports/${r}?month=${month}`);
await get(cookie, 'activity');
await get(cookie, 'search?q=MS');
await get(cookie, 'users');
for (const u of ['arun', 'nok', 'pim', 'somchai', 'dang']) {
  const c = await login(u);
  await get(c, 'attention');
  await get(c, 'jobs');
}
if (fails.length) {
  console.error(fails.join('\n'));
  process.exit(1);
}
console.log('smoke ok');
