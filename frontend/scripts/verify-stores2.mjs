import { createServer } from 'vite';

const root = process.cwd();
const server = await createServer({
	root,
	server: { middlewareMode: true },
	appType: 'custom',
	logLevel: 'error'
});

const checks = [
	['/src/lib/layoutStore', ['layoutStore']],
	['/src/lib/mobileTabQueue', ['mobileTabQueue']],
	['/src/lib/placeStore', ['placeRegistry']],
	['/src/lib/callingStateStores', ['isInCall', 'callMode', 'outgoingCall']],
	['/src/lib/whiteboard/whiteboardSurface', ['currentChatSurface']],
	['/src/lib/mapWorkspace', ['focusedMapPlace']],
	['/src/lib/modelViewportTab', ['modelViewportSelection']],
	['/src/lib/readerWorkspace', ['readerSelection']],
	['/src/lib/payments/paymentAccessStore', ['paymentAccessStore']],
	['/src/lib/theme/themeStore', ['themeStore']],
	['/src/lib/i18n/index', ['_', 'currentLocale']],
	['/src/lib/emoji-store', ['emojis']],
	['/src/lib/userLookupStore', ['userLookup']],
	['/src/lib/composerEnhancements', ['composerEnhancementSettingsStore']],
	['/src/lib/gifCaptionerSettings', ['gifCaptionerSettingsStore']],
	['/src/lib/unicodeEmojis', ['unicodeEmojiSettingsStore']],
	['/src/lib/animationPass', ['animationPassStore']],
	['/src/lib/business/store', ['todos', 'projects', 'calendarEvents', 'diaryEntries']],
	['/src/lib/socket', ['socket', 'dmPanelSignal']]
];

for (const [mod, names] of checks) {
	try {
		const m = await server.ssrLoadModule(mod);
		console.log('\n==', mod, '==');
		for (const name of names) {
			const v = m[name];
			if (v === undefined) {
				console.log(`  ${name}: MISSING`);
				continue;
			}
			if (name === 'mobileTabQueue') {
				const ok = typeof v?.activeTabId?.subscribe === 'function';
				console.log(`  mobileTabQueue.activeTabId: ${ok ? 'STORE ok' : 'NOT A STORE type=' + typeof v?.activeTabId?.subscribe}`);
				continue;
			}
			if (name === 'layoutStore') {
				const ok = typeof v?.subscribe === 'function';
				console.log(`  layoutStore: ${ok ? 'STORE ok' : 'NOT A STORE type=' + typeof v?.subscribe}`);
				continue;
			}
			if (name === '_') {
				const ok = v && typeof v === 'object' && typeof v.subscribe === 'function';
				console.log(`  _ : ${ok ? 'STORE ok' : 'NOT A STORE type=' + typeof v + (v && typeof v === 'object' ? ' keys=' + Object.keys(v).slice(0, 6).join(',') : '')}`);
				continue;
			}
			const ok = v && typeof v === 'object' && typeof v.subscribe === 'function';
			if (!ok) {
				console.log(`  ${name}: *** NOT A STORE *** type=${typeof v}` + (v && typeof v === 'object' ? ' keys=' + Object.keys(v).slice(0, 8).join(',') : ''));
			} else {
				console.log(`  ${name}: STORE ok`);
			}
		}
	} catch (e) {
		console.log('\n==', mod, '== LOAD FAILED:', e.message.slice(0, 200));
	}
}

await server.close();
