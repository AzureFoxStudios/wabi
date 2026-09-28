import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const handlers = new Map();
let responseStatus = 200;
const requests = [];
const deletedCaches = [];
const worker = {
  location: { origin: 'https://wabi.test' },
  clients: { async claim() {} },
  addEventListener(name, handler) { handlers.set(name, handler); },
};
const source = readFileSync(new URL('../../frontend/static/sw.js', import.meta.url), 'utf8');
vm.runInNewContext(source, {
  self: worker,
  URL,
  Request,
  Response,
  Headers,
  fetch: async (request) => {
    requests.push(request);
    if (responseStatus === 0) throw new Error('offline');
    return new Response(responseStatus === 200 ? 'bytes' : 'revoked', {
      status: responseStatus,
    });
  },
  caches: {
    open() { throw new Error('revocable media must not use the service worker cache'); },
    async keys() { return ['media-cache-v3', 'media-cache-v4']; },
    async delete(name) { deletedCaches.push(name); return true; },
  },
});

let activation;
handlers.get('activate')({ waitUntil(promise) { activation = promise; } });
await activation;
assert.deepEqual(deletedCaches, ['media-cache-v3', 'media-cache-v4']);

let clearMessage;
handlers.get('message')({
  data: { type: 'wabi-clear-media-cache' },
  waitUntil(promise) { clearMessage = promise; },
});
await clearMessage;
assert.deepEqual(deletedCaches, [
  'media-cache-v3', 'media-cache-v4', 'media-cache-v3', 'media-cache-v4'
]);

async function fetchThroughWorker(path) {
  let responsePromise;
  handlers.get('fetch')({
    request: new Request(`https://wabi.test${path}`),
    respondWith(promise) { responsePromise = promise; },
  });
  assert.ok(responsePromise, `worker did not handle ${path}`);
  return responsePromise;
}

assert.equal((await fetchThroughWorker('/uploads/art.bin')).status, 200);
responseStatus = 410;
assert.equal((await fetchThroughWorker('/uploads/art.bin')).status, 410);
responseStatus = 0;
const offline = await fetchThroughWorker('/uploads/art.bin');
assert.equal(offline.status, 503);
assert.equal(offline.headers.get('cache-control'), 'no-store');
responseStatus = 200;
assert.equal((await fetchThroughWorker('/api/whiteboard/boards/b/files/f')).status, 200);
assert.equal(requests.length, 4);
assert.ok(requests.every((request) => request.cache === 'no-store'));
