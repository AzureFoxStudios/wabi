import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePack, type Pack } from '@sabi/core';
import { sheetMetalPack } from '../src/index.ts';

test('sheet-metal pack is internally consistent', () => {
  assert.deepEqual(validatePack(sheetMetalPack), []);
});

test('validatePack catches broken configuration', () => {
  const broken: Pack = structuredClone(sheetMetalPack);
  broken.jobTypes[0].workflow.transitions.push({ id: 'x', from: ['nowhere'], to: 'also_nowhere', label: { en: 'x' }, roles: ['ghost'] });
  broken.documentTypes[0].workflow.transitions.push({ id: 'y', from: ['draft'], to: 'draft', label: { en: 'y' }, requires: { settled: true } });
  const errs = validatePack(broken);
  assert.ok(errs.some((e) => e.includes("unknown state 'also_nowhere'")));
  assert.ok(errs.some((e) => e.includes("from unknown state 'nowhere'")));
  assert.ok(errs.some((e) => e.includes("unknown role 'ghost'")));
  assert.ok(errs.some((e) => e.includes("uses 'settled'")));
});

test('every role has a label in both languages; every job type has a pipeline', () => {
  for (const r of sheetMetalPack.roles) assert.ok(r.label.en && r.label.th, r.id);
  for (const j of sheetMetalPack.jobTypes) assert.ok(j.workflow.states.some((s) => s.phase === 'done'), j.id);
});
