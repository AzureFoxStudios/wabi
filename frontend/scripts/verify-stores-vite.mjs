import { createServer } from 'vite';
import path from 'path';

const root = process.cwd();
const server = await createServer({
	root,
	server: { middlewareMode: true },
	appType: 'custom',
	logLevel: 'error'
});

async function check(mod, bindings, label) {
	try {
		const m = await server.ssrLoadModule(mod);
		console.log('\n==', label, mod, '==');
		for (const name of bindings) {
			const v = m[name];
			if (v === undefined) {
				console.log(`  ${name}: MISSING (undefined)`);
				continue;
			}
			const isStore =
				v !== null &&
				typeof v === 'object' &&
				typeof v.subscribe === 'function';
			if (name === 'mobileTabQueue') {
				const ok = v && typeof v.activeTabId?.subscribe === 'function';
				console.log(`  mobileTabQueue.activeTabId: ${ok ? 'STORE ok' : 'NOT A STORE'}`);
				continue;
			}
			if (name === 'layoutStore') {
				const ok = typeof v?.subscribe === 'function';
				console.log(`  layoutStore.subscribe: ${ok ? 'STORE ok' : 'NOT A STORE'} (type ${typeof v?.subscribe})`);
				continue;
			}
			if (name === 'socket') {
				console.log(`  socket: ${isStore ? 'STORE ok' : 'type=' + typeof v + ' keys=' + (v && typeof v === 'object' ? Object.keys(v).slice(0, 6).join(',') : '')}`);
				continue;
			}
			if (name === '_') {
				const ok = v !== null && typeof v === 'object' && typeof v.subscribe === 'function';
				console.log(`  _ : ${ok ? 'STORE ok' : 'type=' + typeof v + ' keys=' + (v && typeof v === 'object' ? Object.keys(v).slice(0, 6).join(',') : '')}`);
				continue;
			}
			console.log(`  ${name}: ${isStore ? 'STORE ok' : '*** NOT A STORE *** type=' + typeof v + (v && typeof v === 'object' ? ' keys=' + Object.keys(v).slice(0, 8).join(',') : '')}`);
		}
	} catch (e) {
		console.log('\n==', label, mod, '== LOAD FAILED:', e.message);
	}
}

const chatBindings = [
	'channelMessages', 'channels', 'currentChannel', 'typingUsers', 'currentUser', 'users',
	'serverMembers', 'userLookup', 'lastReadMessageId', 'channelHasMoreHistory',
	'channelHistoryLoading', 'channelLoadingOlder', 'socket', 'dmPanelSignal',
	'todos', 'projects', 'calendarEvents', 'diaryEntries', 'layoutStore',
	'callMode', 'isInCall', 'outgoingCall', '_', 'currentLocale',
	'animationPassStore', 'paymentAccessStore', 'displayEnhancementSettingsStore',
	'focusedMapPlace', 'modelViewportSelection', 'readerSelection', 'mobileTabQueue',
	'currentChatSurface'
];

const composerBindings = [
	'channelMessages', 'channels', 'currentChannel', 'currentUser', 'emojis',
	'userLookup', '_', 'isMobile', 'composerEnhancementSettingsStore',
	'gifCaptionerSettingsStore', 'unicodeEmojiSettingsStore', 'placeRegistry',
	'serverMembers'
];

const messageListBindings = [
	'users', 'currentUser', 'currentChannel', 'emojis', 'channels', 'themeStore',
	'roleDefinitions', 'channelAvailableArchives', 'channelLoadedArchives',
	'channelLoadingOlder', 'channelHistoryLoading', 'channelHasMoreHistory',
	'layoutStore', '_', 'chatFilterStore', 'gifCaptionerSettingsStore',
	'quickReactionSettingsStore', 'localNicknamesStore', 'animationPassStore',
	'displayEnhancementSettingsStore', 'personalPinsStore'
];

await check('/src/lib/socket', chatBindings.slice(0, 4), 'socket-basic');
await check('/src/lib/components/Chat.svelte', chatBindings, 'Chat.svelte');
await check('/src/lib/components/chat/ChatComposer.svelte', composerBindings, 'ChatComposer.svelte');
await check('/src/lib/components/MessageList.svelte', messageListBindings, 'MessageList.svelte');

await server.close();
