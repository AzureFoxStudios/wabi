/**
 * MessageList's handlers cannot be mounted in bun (2,400 lines, dozens of live stores), so this
 * is a structural check on the component's parsed script (svelte's own parser, not a text grep):
 * every handler that hands content to a server-readable feature calls its guard
 * (message/messageListGuards.ts, tested in privacy/contentEgress.test.ts) before its first
 * network call or await. The render-side gates are tested by rendering the real components in
 * message/keptContent.render.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parse } from 'svelte/compiler';

const source = readFileSync(new URL('./MessageList.svelte', import.meta.url), 'utf8');
const ast: any = parse(source, { modern: true });
const script: any = ast.instance.content;

function functionSource(name: string): string {
	let found: any = null;
	const visit = (node: any) => {
		if (!node || typeof node !== 'object' || found) return;
		if (node.type === 'FunctionDeclaration' && node.id?.name === name) {
			found = node;
			return;
		}
		for (const value of Object.values(node)) {
			if (Array.isArray(value)) value.forEach(visit);
			else if (value && typeof value === 'object' && typeof (value as any).type === 'string') visit(value);
		}
	};
	visit(script);
	expect(found, `function ${name} exists`).not.toBeNull();
	return source.slice(found.start, found.end);
}

/** The guard call appears, and before anything that could reach the network. */
function guardsFirst(name: string, guard: string): void {
	const body = functionSource(name);
	const at = body.indexOf(guard);
	expect(at, `${name} calls ${guard}`).toBeGreaterThan(-1);
	for (const sink of ['await ', 'fetch(', 'addMediaAlbumItem(', 'createMediaAlbum(', 'listMediaAlbums(', 'showForwardDialog = true', 'showPromoteModal = true', 'showBlendImportSettings = true', '.click()']) {
		const sinkAt = body.indexOf(sink);
		if (sinkAt !== -1) expect(at, `${name}: ${guard} before ${sink}`).toBeLessThan(sinkAt);
	}
}

describe('MessageList hands nothing kept to a server-readable feature', () => {
	test('albums', () => {
		guardsFirst('handleAddToAlbum', "blockedForServerReadable('album', targetMessage)");
		guardsFirst('handleAlbumAnnouncementActivate', "blockedForServerReadable('album', message)");
		guardsFirst('triggerAlbumAnnouncementUpload', "blockedForServerReadable('album', message)");
		guardsFirst('uploadFilesToAlbumAnnouncement', "blockedForServerReadable('album', message)");
		expect(functionSource('handleAddToAlbum')).toContain("keepOnDevice: serverReadableActionBlock('album', targetMessage, roomKeep) !== null");
		expect(functionSource('handleAlbumAnnouncementUploadChange')).toContain('uploadFilesToAlbumAnnouncement(targetMeta, files, targetMessage)');
	});

	test('forward, Lore and Blender import', () => {
		guardsFirst('handleForward', "blockedForServerReadable('forward', contextMenuMessage)");
		guardsFirst('handleForwardFromBar', "blockedForServerReadable('forward', message)");
		guardsFirst('handlePromoteToLore', "blockedForServerReadable('lore', contextMenuMessage)");
		guardsFirst('openBlendImportSettings', "blockedForServerReadable('blend', message)");
		expect(functionSource('handleContextMenu')).toContain('shouldFetchPromotes(loreAvailable, message, roomKeep)');
	});

	test('manual translation asks before sending', () => {
		const body = functionSource('handleTranslate');
		const ask = body.indexOf('await mayTranslate(');
		expect(ask).toBeGreaterThan(-1);
		expect(body).toContain('reason: keepReasonFor(targetMessage, roomKeep)');
		expect(body).toContain('if (!allowed) return;');
		expect(ask).toBeLessThan(body.indexOf('requestTranslation('));
	});

	test('the room answer comes from the shared derivation and reaches the menu', () => {
		expect(source).toMatch(/\$: roomKeep = roomContentKeepReason\(activeChannelId, activeMessageChannel\?\.type \?\? null, \$e2eeStatusRevision\);/);
		expect(source).toMatch(/\$: if \(browser && activeChannelIsPrivateConversation && activeChannelId\) ensureE2eeStatus\(activeChannelId\);/);
		expect(source).toContain('{contextMenuKeepReason}');
		expect(functionSource('blockedForServerReadable')).toContain('serverReadableActionBlock(action, message, roomKeep)');
	});
});

describe('the rest of the kept-content plumbing', () => {
	const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

	test('the menu receives the room answer from the overlays', () => {
		const overlays: any = parse(read('./message/MessageListOverlays.svelte'), { modern: true });
		const menu = JSON.stringify(overlays.fragment);
		expect(menu).toContain('"name":"roomKeepReason"');
		expect(read('./message/MessageListOverlays.svelte')).toContain('roomKeepReason={contextMenuKeepReason}');
	});

	test('a kept long message opens in the Reader with remote media off', () => {
		expect(read('./message/MessageContent.svelte')).toMatch(/<LongMessagePreview[\s\S]*?keepOnDevice=\{contentOnDevice\}[\s\S]*?\/>/);
		expect(read('./message/LongMessagePreview.svelte')).toContain("{ remoteMedia: !keepOnDevice }");
		expect(read('./ReaderTabImpl.svelte')).toContain('{ remoteMedia: $readerSelection.remoteMedia !== false }');
	});
});
