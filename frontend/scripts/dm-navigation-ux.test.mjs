import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const component = name => readFileSync(new URL(`../src/lib/components/${name}.svelte`, import.meta.url), 'utf8');

// Source-wiring regression tests supplement, not replace, full-app checks.
test('group side-panel navigation has one explicit channel contract', () => {
  const helper = readFileSync(new URL('../src/lib/dmNavigation.ts', import.meta.url), 'utf8');
  assert.match(helper, /selectedGroupChannel\.set\(channel\)/);
  assert.match(helper, /selectedDmChannelId\.set\(channel\.id\)/);
  assert.match(helper, /openRightPanel\('dms'\)/);
  for (const file of ['DmHub', 'DmConversationHeader']) {
    assert.match(component(file), /openRightGroupDm\(channel\)/);
    assert.doesNotMatch(component(file), /layoutStore\.openGroupDM\(/);
  }
});
test('group leave retains explicit confirmation without unsupported menu metadata', () => {
  const header = component('DmConversationHeader');
  assert.match(header, /window\.confirm\(`Leave/);
  assert.doesNotMatch(header, /danger: true/);
});
