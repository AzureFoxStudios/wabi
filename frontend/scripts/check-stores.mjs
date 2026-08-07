import { pathToFileURL } from 'url';

// Runtime check: import modules Chat uses and verify store-ness of $ candidates
const checks = [
	['$lib/socket', ['channelMessages', 'channels', 'currentChannel', 'typingUsers', 'currentUser', 'users', 'serverMembers', 'userLookup', 'lastReadMessageId', 'channelHasMoreHistory', 'channelHistoryLoading', 'channelLoadingOlder', 'dmPanelSignal', 'socket']],
	['$lib/business/store', ['todos', 'projects', 'calendarEvents', 'diaryEntries']],
	['$lib/layoutStore', ['layoutStore']],
	['$lib/calling', ['callMode', 'isInCall', 'outgoingCall']],
	['$lib/i18n', ['_', 'currentLocale']],
	['$lib/animationPass', ['animationPassStore']],
	['$lib/payments/paymentAccessStore', ['paymentAccessStore']],
	['$lib/displayEnhancements', ['displayEnhancementSettingsStore']],
	['$lib/mapWorkspace', ['focusedMapPlace']],
	['$lib/modelViewportTab', ['modelViewportSelection']],
	['$lib/readerWorkspace', ['readerSelection']],
	['$lib/mobileTabQueue', ['mobileTabQueue']],
	['$lib/whiteboard/whiteboardSurface', ['currentChatSurface']],
	['$lib/composerEnhancements', ['composerEnhancementSettingsStore']],
	['$lib/gifCaptionerSettings', ['gifCaptionerSettingsStore']],
	['$lib/unicodeEmojis', ['unicodeEmojiSettingsStore']],
	['$lib/placeRegistry', ['placeRegistry']],
	['$lib/emoji-store', ['emojis']]
];

// Use vite-node / dynamic import via relative paths
const root = new URL('file:///var/home/Ronin/wabi/frontend/src/lib/');

async function load(rel) {
	const p = rel.replace('$lib/', '/var/home/Ronin/wabi/frontend/src/lib/') + (rel.endsWith('.ts') ? '' : '.ts');
	// bun can import ts
	return import(pathToFileURL(p).href);
}

const bad = [];
for (const [mod, names] of checks) {
	try {
		const m = await load(mod);
		for (const name of names) {
			const v = m[name];
			if (v == null) {
				bad.push(`${mod}.${name} = ${v}`);
				continue;
			}
			if (name === 'mobileTabQueue') {
				if (typeof v.activeTabId?.subscribe !== 'function') bad.push(`${mod}.mobileTabQueue.activeTabId not store`);
				continue;
			}
			if (name === 'layoutStore') {
				if (typeof v.subscribe !== 'function') bad.push(`${mod}.layoutStore missing subscribe`);
				continue;
			}
			if (name === 'socket') {
				// may be null store or object
				continue;
			}
			if (typeof v.subscribe !== 'function') {
				bad.push(`${mod}.${name} type=${typeof v} keys=${v && typeof v==='object' ? Object.keys(v).slice(0,8).join(',') : ''}`);
			}
		}
		console.log('OK', mod);
	} catch (e) {
		bad.push(`${mod} IMPORT FAIL: ${e.message}`);
		console.log('FAIL', mod, e.message);
	}
}
console.log('\nBAD:');
bad.forEach((b) => console.log(' -', b));
