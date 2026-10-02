import { describe, expect, test } from 'bun:test';
import { fetchVapidKeyResult, pushFailureMessage } from './pushDiagnostics';
const result = (response: Response) => fetchVapidKeyResult('/api/push/vapid-public-key', async () => response);
describe('VAPID endpoint diagnostics', () => {
 test('distinguishes request failure from missing keys', async () => {
  expect(await fetchVapidKeyResult('/key', async () => { throw new Error('offline'); })).toEqual({ ok: false, reason: 'vapid_network_error' });
  expect(await result(new Response('Forbidden', { status: 403 }))).toEqual({ ok: false, reason: 'vapid_http_403' });
 });
 test('rejects successful HTML and malformed response shapes', async () => {
  for (const body of ['<html>login</html>', 'null', '[]', '"key"']) expect(await result(new Response(body))).toEqual({ ok: false, reason: 'vapid_invalid_response' });
 });
 test('reports a genuinely absent key separately', async () => {
  for (const publicKey of [undefined, null, '']) expect(await result(Response.json({ publicKey }))).toEqual({ ok: false, reason: 'no_vapid_key' });
 });
 test('refuses malformed application-server keys', async () => {
  for (const publicKey of [42, 'whitespace key', 'AAAA']) expect(await result(Response.json({ publicKey }))).toEqual({ ok: false, reason: 'vapid_invalid_key' });
 });
 test('accepts a correctly shaped uncompressed public-key response', async () => {
  // Synthetic bytes only; no private key or real subscription is generated.
  const publicKey = btoa(String.fromCharCode(4) + '\0'.repeat(64)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  expect(await result(Response.json({ publicKey }))).toEqual({ ok: true, publicKey });
 });
 test('shows distinct operator and device repair actions without raw response text', () => {
  expect(pushFailureMessage('vapid_http_403')).toContain('HTTP 403');
  expect(pushFailureMessage('vapid_invalid_response')).toContain('unexpected');
  expect(pushFailureMessage('no_vapid_key')).toContain('not provided');
  expect(pushFailureMessage('push_unsupported')).toContain('Home Screen');
  expect(pushFailureMessage('constructor')).toBe(pushFailureMessage('unknown'));
 });
});
