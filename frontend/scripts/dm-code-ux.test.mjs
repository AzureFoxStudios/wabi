import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LatestIntent } from '../src/lib/latestIntent.ts';
import { dmPersonName, dmHandle, dmPreview, dmActivityTime, dmTimeLabel, sortDmConversations } from '../src/lib/dmPresentation.ts';
import { editorStatus } from '../src/lib/lore/editorPresentation.ts';

const channel = (id, name = id) => ({ id, name, type: 'dm' });
const message = (id, timestamp = 100, text = '') => ({ id, timestamp, text, type: 'text' });
const label = value => value.name;
const component = name => readFileSync(new URL(`../src/lib/components/${name}.svelte`, import.meta.url), 'utf8');

test('display name is not replaced by or duplicated as a handle', () => {
  assert.equal(dmPersonName({ username: 'Alice', handle: 'alice' }), 'Alice');
  assert.equal(dmHandle({ handle: '@@alice' }), '@alice');
  assert.equal(dmHandle({ handle: '' }), '');
});
test('missing identities are explicit, not invented people', () => {
  assert.equal(dmPersonName(null), 'Recipient unavailable');
  assert.equal(dmPersonName({ username: ' ', handle: '@alice' }), 'alice');
});
test('an unloaded message cache is not labeled an empty history', () => {
  assert.equal(dmPreview(undefined), 'Open to load messages');
  assert.equal(dmPreview([]), 'Open to load messages');
});
test('previews identify files and GIFs without rendering their contents as markup', () => {
  assert.equal(dmPreview([{ type: 'file', fileName: 'example.ts' }]), 'File: example.ts');
  assert.equal(dmPreview([{ type: 'gif' }]), 'GIF');
  assert.equal(dmPreview([message('1', 1, '<script>test</script>')]), '<script>test</script>');
});
test('timestamps reject invalid values', () => {
  assert.equal(dmActivityTime([message('1', NaN)]), null);
  assert.equal(dmActivityTime([]), null);
  assert.equal(dmTimeLabel(null), '');
  assert.equal(dmTimeLabel(Infinity), '');
});
test('personal pins take precedence without honoring another member pin', () => {
  const a = { ...channel('a'), pinnedBy: ['someone-else'] }, b = channel('b');
  assert.deepEqual(sortDmConversations([a,b], { a: [message('msg_1',200)], b:[message('msg_2',100)] }, new Set(['b']), label).map(c=>c.id), ['b','a']);
});
test('recency comes before the message sequence tiebreak', () => {
  assert.deepEqual(sortDmConversations([channel('a'),channel('b')], {a:[message('msg_ff',10)],b:[message('msg_1',20)]}, new Set(), label).map(c=>c.id), ['b','a']);
});
test('large hexadecimal sequences retain exact ordering above Number precision', () => {
  assert.deepEqual(sortDmConversations([channel('a'),channel('b')], {a:[message('msg_20000000000000')],b:[message('msg_20000000000001')]}, new Set(), label).map(c=>c.id), ['b','a']);
});
test('sorting is stable, deterministic, and does not mutate source stores', () => {
  const input = [channel('b','Same'),channel('a','Same')];
  assert.deepEqual(sortDmConversations(input, {}, new Set(), label).map(c=>c.id), ['a','b']);
  assert.deepEqual(input.map(c=>c.id), ['b','a']);
});
test('a newer intent invalidates a slow earlier response', () => {
  const intent = new LatestIntent(), a = intent.begin(), b = intent.begin();
  assert.equal(intent.current(a), false); assert.equal(intent.current(b), true);
});
test('cancel and component disposal invalidate pending results', () => {
  const intent = new LatestIntent(), a = intent.begin(); intent.cancel(); assert.equal(intent.current(a), false);
  const b = intent.begin(); intent.dispose(); assert.equal(intent.current(b), false); assert.equal(intent.current(intent.begin()), false);
});
test('out-of-order promises cannot repaint another selection', async () => {
  const intent = new LatestIntent(); let resolveA; let shown = '';
  const a = intent.begin(); const pending = new Promise(resolve => resolveA = resolve).then(value => { if (intent.current(a)) shown = value; });
  const b = intent.begin(); if (intent.current(b)) shown = 'file B'; resolveA('file A'); await pending;
  assert.equal(shown, 'file B');
});
test('draft labels distinguish published, local, unsaved and review states', () => {
  const base = {editing:false, dirty:false, busy:false, submitted:false};
  assert.equal(editorStatus(base), 'Published file');
  assert.match(editorStatus({...base,editing:true,dirty:true}), /Private draft.*Unsaved/);
  assert.match(editorStatus({...base,editing:true,submitted:true}), /Submitted for review.*Not published/);
  assert.match(editorStatus({...base,busy:true}), /Opening editor/);
});
// Source-wiring checks below supplement the behavioral helper tests; they are
// not substitutes for a full app or a two-account permission test.
test('both DM placements use the same inbox/header instead of divergent menus', () => {
  assert.match(component('DMTab'), /<DmHub surface="right"/);
  for (const file of ['DMTab','DmConversationView']) assert.match(component(file), /<DmConversationHeader/);
});
test('redesigned screens do not advertise fake encryption modes or shared DM deletion', () => {
  for (const file of ['DMTab','DmHub','DmConversationHeader']) assert.doesNotMatch(component(file), /setDMPrivacyMode|deleteDM\(|Sealed|Open \(Public\)/);
  assert.match(component('DmConversationHeader'), /not end-to-end encrypted/);
});
test('picker cancellation and scope validation guard DM results', () => {
  const hub = component('DmHub');
  assert.match(hub, /intents\.current\(request\)/); assert.match(hub, /authSessionGeneration\(base\) !== session/);
  assert.match(hub, /resolveDmEntry/); assert.doesNotMatch(hub, /buildDmPlaceholderChannel/);
});
test('compact code panel uses scoped results and real dirty-state callbacks', () => {
  const panel = component('lore/LoreCodePanel');
  assert.match(panel, /onDirtyChange=/); assert.match(panel, /onStateChange=/);
  assert.match(panel, /active\(captured\).*previews\.current\(request\)/);
  assert.match(panel, /if \(fileDirty && !discard\)/);
  assert.doesNotMatch(panel, /canEdit=\{true\}|from '\$lib\/loreStore'/);
});
test('code viewer preserves version checks and exposes compare/export before replacement', () => {
  const viewer = component('lore/LoreFileViewer');
  assert.match(viewer, /baselineEtag/); assert.match(viewer, /LoreConflictError/);
  assert.match(viewer, /Compare versions/); assert.match(viewer, /Download my draft/);
  assert.match(viewer, /Submit for review/); assert.match(viewer, /Publish revision/);
  assert.match(viewer, /not a live shared session/); assert.doesNotMatch(viewer, /oneDark|viewer-save-state\s*\{\s*display:\s*none/);
});
