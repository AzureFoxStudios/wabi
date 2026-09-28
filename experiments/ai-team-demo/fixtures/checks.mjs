import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileEvents } from './candidate.mjs';

test('reconnect replay does not duplicate an existing event', () => {
  assert.deepEqual(reconcileEvents([{ id: 'a', text: 'hello' }], [{ id: 'a', text: 'hello' }]), [{ id: 'a', text: 'hello' }]);
});
test('new data replaces an existing event without moving it', () => {
  assert.deepEqual(reconcileEvents([{ id: 'a', text: 'old' }, { id: 'b', text: 'keep' }], [{ id: 'a', text: 'edited' }, { id: 'c', text: 'new' }]), [{ id: 'a', text: 'edited' }, { id: 'b', text: 'keep' }, { id: 'c', text: 'new' }]);
});
test('duplicates within a replay use the last value', () => {
  assert.deepEqual(reconcileEvents([], [{ id: 'a', text: 'first' }, { id: 'a', text: 'last' }]), [{ id: 'a', text: 'last' }]);
});
test('existing duplicates are repaired too, keeping the latest value', () => {
  assert.deepEqual(reconcileEvents([{ id: 'a', text: 'old' }, { id: 'b', text: 'keep' }, { id: 'a', text: 'edited' }], []), [{ id: 'a', text: 'edited' }, { id: 'b', text: 'keep' }]);
});
test('input arrays are not mutated', () => {
  const current = Object.freeze([Object.freeze({ id: 'a', text: 'old' })]);
  const incoming = Object.freeze([Object.freeze({ id: 'b', text: 'new' })]);
  assert.deepEqual(reconcileEvents(current, incoming), [...current, ...incoming]);
});
test('empty input preserves the existing order', () => {
  assert.deepEqual(reconcileEvents([{ id: 'b' }, { id: 'a' }], []), [{ id: 'b' }, { id: 'a' }]);
});
