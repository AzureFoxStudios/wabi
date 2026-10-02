import { expect, mock, test } from 'bun:test';
import { writable } from 'svelte/store';
const channels = writable<any[]>([]);
const opened: unknown[] = [];
let server = 'https://wabi.test';
mock.module('$app/environment', () => ({ browser: true }));
mock.module('$lib/channelStore', () => ({ channels }));
mock.module('$lib/serverUrl', () => ({ getServerUrl: () => server }));
mock.module('$lib/navigateToRef', () => ({ navigateToRef: async (target: unknown) => { opened.push(target); } }));
mock.module('$lib/layoutStore', () => ({ layoutStore: {} }));
mock.module('$lib/socket', () => ({ currentChannel: writable(null), joinChannel: async () => {} }));
const { applyWabiNavTarget, parseWabiNavFromSearch } = await import('./deepLink');
test('a fresh Lore file link waits for the authenticated project snapshot and opens once', async () => {
 const target = {kind:'lore_file' as const, channelId:'project', filePath:'proof/file.txt'};
 applyWabiNavTarget(target);
 expect(opened).toEqual([]);
 channels.set([{id:'other',type:'lore'}]);
 expect(opened).toEqual([]);
 channels.set([{id:'project',type:'lore'}]);
 await Promise.resolve();
 expect(opened).toEqual([target]);
 channels.set([{id:'project',type:'lore'}]);
 await Promise.resolve();
 expect(opened).toHaveLength(1);
});
test('a pending Lore link cannot cross into another server', async () => {
 channels.set([]);
 applyWabiNavTarget({kind:'lore_file',channelId:'project',filePath:'file'});
 server='https://another.test';
 channels.set([{id:'project',type:'lore'}]);
 await Promise.resolve();
 expect(opened).toHaveLength(1);
});
test('Lore search links reject missing identity and parent traversal', () => {
 expect(parseWabiNavFromSearch('?wabiNav=lore_file&channelId=project&path=proof%2Ffile.txt')).toEqual({kind:'lore_file',channelId:'project',filePath:'proof/file.txt'});
 expect(parseWabiNavFromSearch('?wabiNav=lore_file&channelId=project&path=..%2Ffile')).toBeNull();
});
