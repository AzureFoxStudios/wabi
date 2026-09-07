import { get } from 'svelte/store';
import { loadWiki, wikiPagesStore, wikiErrorStore } from '../src/lib/wikiStore';
import { loadThreads, forumThreadsStore, forumErrorStore } from '../src/lib/forumStore';
import { listMediaAlbums } from '../src/lib/api/albums';
import { joinChannel } from '../src/lib/channelStore';
import { ensureChannelMembership } from '../src/lib/api/channelAccess';

(window as any).__channelAccess = {
	async join(channel: string) { joinChannel(channel); await ensureChannelMembership(channel); },
	async run() {
		await loadWiki('wiki');
		await loadThreads('denied');
		const albums = await listMediaAlbums('fixture-access-token', 'channel', 'gallery');
		return { wiki: get(wikiPagesStore), wikiError: get(wikiErrorStore),
			forum: get(forumThreadsStore), forumError: get(forumErrorStore), albums };
	}
};
