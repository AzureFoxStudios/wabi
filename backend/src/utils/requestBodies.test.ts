import assert from 'node:assert/strict';
import test from 'node:test';
import type { IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';

import {
  isInvalidJsonBodyError,
  isRequestBodyTooLargeError,
  parseJsonObjectBuffer,
  parseBooleanRequestValue,
  readJsonObjectBody
} from './requestBodies.js';

function createRequest(body?: string | Buffer): IncomingMessage {
  const stream = new PassThrough();
  queueMicrotask(() => {
    if (body === undefined) {
      stream.end();
      return;
    }
    stream.end(body);
  });
  return stream as unknown as IncomingMessage;
}

test('readJsonObjectBody parses JSON objects and empty bodies', async () => {
  assert.deepEqual(await readJsonObjectBody(createRequest()), {});
  assert.deepEqual(await readJsonObjectBody(createRequest('{"ok":true,"count":2}')), {
    ok: true,
    count: 2
  });
});

test('readJsonObjectBody rejects invalid JSON and non-object payloads', async () => {
  await assert.rejects(
    readJsonObjectBody(createRequest('{"missing":')),
    (error: unknown) => isInvalidJsonBodyError(error)
  );
  await assert.rejects(
    readJsonObjectBody(createRequest('["not","an","object"]')),
    (error: unknown) => isInvalidJsonBodyError(error)
  );
});

test('readJsonObjectBody rejects oversized bodies', async () => {
  await assert.rejects(
    readJsonObjectBody(createRequest('{"payload":"abcdef"}'), 8),
    (error: unknown) => isRequestBodyTooLargeError(error)
  );
});

test('parseJsonObjectBuffer accepts object buffers and rejects invalid payloads', () => {
  assert.deepEqual(parseJsonObjectBuffer(Buffer.from('{"mode":"ok"}', 'utf8')), { mode: 'ok' });
  assert.throws(
    () => parseJsonObjectBuffer(Buffer.from('["not","object"]', 'utf8')),
    (error: unknown) => isInvalidJsonBodyError(error)
  );
});

test('parseBooleanRequestValue normalizes common request variants', () => {
  assert.equal(parseBooleanRequestValue(true), true);
  assert.equal(parseBooleanRequestValue(' YES '), true);
  assert.equal(parseBooleanRequestValue(0), false);
  assert.equal(parseBooleanRequestValue('off'), false);
  assert.equal(parseBooleanRequestValue('maybe'), null);
});
