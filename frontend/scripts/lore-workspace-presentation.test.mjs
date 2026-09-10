import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PROJECT_TABS, revisionTime, newestFirst, revisionSummary, formatRevisionTime,
  formatBytes, isMirror, previewKind, uploadPath, sameRoleDraft, SelectionEpoch
} from '../src/lib/lore/workspacePresentation.ts';

const revision = (hash, timestamp, message = hash) => ({ hash, timestamp, message, authorId: 7 });
const text = path => readFileSync(new URL(`../src/lib/${path}`, import.meta.url), 'utf8');

test('one everyday navigation model: Files, Changes, History, Review, Settings', () => {
  assert.deepEqual(PROJECT_TABS, ['files', 'changes', 'history', 'review', 'settings']);
});
for (const [unit, timestamp] of [['seconds', 1789000000], ['milliseconds', 1789000000000], ['microseconds', 1789000000000000]]) {
  test(`history accepts ${unit} without changing chronology`, () => assert.equal(revisionTime(timestamp), 1789000000000));
}
for (const value of [0, -1, NaN, Infinity, -Infinity, 1e30]) {
  test(`invalid timestamp ${value} is not converted into a current date`, () => assert.equal(revisionTime(value), null));
}
test('newest-first sort retains original input and is stable for ties', () => {
  const input = [revision('old', 1788000000000), revision('new', 1789000000), revision('tied', 1789000000000000), revision('unknown', 0)];
  assert.deepEqual(newestFirst(input).map(item => item.hash), ['new', 'tied', 'old', 'unknown']);
  assert.deepEqual(input.map(item => item.hash), ['old', 'new', 'tied', 'unknown']);
});
test('invalid history dates have an explicit label', () => assert.equal(formatRevisionTime(0), 'Date unavailable'));
test('revision summary keeps a title and multiline description separate', () => {
  assert.deepEqual(revisionSummary('  Improve models\r\n\r\nPreserve material slots.\r\nSecond detail.  '), { title: 'Improve models', detail: 'Preserve material slots.\nSecond detail.' });
});
test('missing summary is not fabricated', () => assert.deepEqual(revisionSummary('\n  '), { title: 'Revision without a summary', detail: '' }));
for (const [size, label] of [[0, '0 B'], [1024, '1.0 KiB'], [1048576, '1.0 MiB'], [1073741824, '1.0 GiB'], [-1, 'Size unavailable'], [NaN, 'Size unavailable']]) {
  test(`file size ${size}`, () => assert.equal(formatBytes(size), label));
}
test('both supported read-only mirror encodings are recognized', () => {
  assert.equal(isMirror({ class: 'mirror' }), true);
  assert.equal(isMirror({ class: { mirror: { upstream_url: 'https://example.invalid' } } }), true);
  for (const repo of [null, {}, { class: 'native' }, { class: 'imported' }]) assert.equal(isMirror(repo), false);
});
for (const [path, kind] of [['Art/RYNAR.PNG','image'],['audio/battle.flac','audio'],['clip.webm','video'],['README.md','text'],['LICENSE','text'],['src/game.rs','text'],['icon.svg','text'],['scene.blend','download'],['drawing.kra','download'],['blob','download']]) {
  test(`preview classification: ${path}`, () => assert.equal(previewKind(path), kind));
}
test('directory upload preserves folders below the chosen root', () => assert.equal(uploadPath('hero.png', 'Project/art/hero.png'), 'uploads/art/hero.png'));
test('single file upload honors the selected destination', () => assert.equal(uploadPath('hero.png', '', 'art/characters/'), 'art/characters/hero.png'));
test('new files can be created at the repository root', () => assert.equal(uploadPath('README.md', '', ''), 'README.md'));
for (const [name, rel, dest] of [ ['../x','','uploads'], ['x','','/etc'], ['x','','a//b'], ['x','','C:\\secret'], ['a\u0000b','',''], ['x','Project/../x',''], ['x','Project/',''], ['x','Project',''], ['x','/Project/x',''] ]) {
  test(`unsafe upload rejected: ${JSON.stringify([name, rel, dest])}`, () => assert.throws(() => uploadPath(name, rel, dest)));
}
test('role drafts compare capabilities as a set and preserve unknown capabilities', () => {
  const base = { name: 'Artist', description: 'Artwork', capabilities: ['lore.view','future.cap','lore.stage'] };
  assert.equal(sameRoleDraft(base, {...base, capabilities: ['future.cap','lore.stage','lore.view','lore.view']}), true);
  assert.equal(sameRoleDraft(base, {...base, capabilities: ['lore.stage','lore.view']}), false);
  assert.equal(sameRoleDraft(base, {...base, name: 'Animator'}), false);
});
test('only the latest request may paint a preview', () => {
  const gate = new SelectionEpoch(), first = gate.begin(), second = gate.begin();
  assert.equal(gate.current(first), false); assert.equal(gate.current(second), true);
});
test('late requests cannot repaint an unmounted workspace', () => {
  const gate = new SelectionEpoch(), request = gate.begin(); gate.dispose();
  assert.equal(gate.current(request), false); assert.equal(gate.current(gate.begin()), false);
});

// Source-contract checks are supplementary. They are NOT a Svelte compile/browser test.
test('both Project wrappers delegate to the same channel shell', () => {
  for (const file of ['components/LoreWorkspace.svelte', 'components/LoreRepositoryWorkspace.svelte']) {
    const source = text(file); assert.match(source, /<LoreChannelShell projectPicker/);
    assert.doesNotMatch(source, /Overview|Local changes/);
  }
  assert.match(text('components/lore/LoreChannelShell.svelte'), /<LoreProjectWorkspace/);
});
test('local observer remains mounted behind Changes, with the correct string channel key', () => {
  const source = text('components/lore/LoreProjectWorkspace.svelte');
  assert.match(source, /\{#if localOpened\}/);
  assert.match(source, /hidden=\{tab !== 'changes'\}/);
  assert.match(source, /<LoreLocalChanges channelId=\{channelKey\}/);
  assert.doesNotMatch(source, /<LoreLocalChanges \{channelId\}/);
});
test('renderer is isolated from chat and permits structural tables but not active content', () => {
  const source = text('lore/documentMarkdown.ts');
  assert.match(source, /new Marked/); assert.doesNotMatch(source, /parseMessage|markdown\.ts/);
  assert.match(source, /DOMPurify\.sanitize/);
  for (const tag of ['table','thead','tbody','tr','th','td']) assert.ok(source.includes(`'${tag}'`));
  assert.match(source, /FORBID_TAGS:.*'script'.*'iframe'.*'form'.*'svg'/);
  assert.match(source, /renderer: \{ image/);
});
test('role edits and default access use explicit saves', () => {
  const source = text('components/lore/LoreRolesAdmin.svelte');
  assert.match(source, /Server-wide roles/); assert.match(source, /System role/);
  assert.match(source, /Save changes/); assert.match(source, /sameRoleDraft/);
  assert.doesNotMatch(source, /onchange=.*setLoreDefaultPolicy/);
});
test('writes retain conditional requests and confirmations; metadata reads cannot publish', () => {
  const source = text('components/lore/LoreProjectWorkspace.svelte');
  assert.match(source, /uploadLoreFile\(auth, channelId, item.path, item.file, summary, previous\?\.etag \?\? null\)/);
  assert.match(source, /deleteLoreFile\(auth, channelId, action.path,.*action.etag\)/);
  assert.match(source, /confirmationText !== action.expected/);
  assert.doesNotMatch(source, /stageOnly|commit_staged|lore_local_publish|lore_local_pull/);
  const readSection = source.slice(source.indexOf('async function reload()'), source.indexOf('async function run('));
  assert.doesNotMatch(readSection, /uploadLoreFile\(|deleteLoreFile\(|reviewLoreBranch\(/);
});
test('changing comparison path clears old file versions', () => {
  const source = text('components/lore/LoreHistoryBrowser.svelte');
  assert.match(source, /function pathChanged\(\).*pathHistory = \[\]; from = ''; to = ''/);
  assert.match(source, /oninput=\{pathChanged\}/);
});
test('theme CSS is scoped, hides mounted panels, and supports small workspaces', () => {
  const source = text('components/lore/loreWorkspace.css');
  assert.match(source, /\.lore-workbench \[hidden\].*display: none !important/);
  assert.match(source, /@container \(max-width: 560px\)/);
  assert.match(source, /prefers-reduced-motion/);
});
