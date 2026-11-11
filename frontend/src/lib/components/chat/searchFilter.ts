// The pure half of chat search. It imports types only, so tests can load it
// without the socket stores.
import type { Message } from '$lib/socket';

export function parseSearchQuery(query: string): { text: string; byUser?: string; hasTypes: string[] } {
	const byUserMatch = query.match(/by:(\S+)/);
	const hasMatches = query.match(/has:(\S+)/g) || [];
	const byUser = byUserMatch ? byUserMatch[1] : undefined;
	const hasTypes = hasMatches.map((match) => match.replace('has:', '').toLowerCase());
	const text = query.replace(/by:\S+/g, '').replace(/has:\S+/g, '').trim().toLowerCase();

	return { text, byUser, hasTypes };
}

export function filterMessages(msgs: Message[], query: string, workingSetLimit: number): Message[] {
	const workingSet = msgs.length > workingSetLimit ? msgs.slice(-workingSetLimit) : msgs;
	if (!query.trim()) return workingSet;

	const { text, byUser, hasTypes } = parseSearchQuery(query);

	return workingSet.filter((msg) => {
		if (byUser && msg.user.toLowerCase() !== byUser.toLowerCase()) {
			return false;
		}

		if (hasTypes.length > 0) {
			const hasMatch = hasTypes.some((type) => {
				if (type === 'image' && msg.type === 'file' && msg.fileUrl?.match(/\.(jpg|jpeg|png|gif|webp)$/i)) return true;
				if (type === 'video' && msg.type === 'file' && msg.fileUrl?.match(/\.(mp4|webm|mov)$/i)) return true;
				if (type === 'file' && msg.type === 'file') return true;
				if (type === 'link' && msg.text.match(/https?:\/\//i)) return true;
				if (type === 'gif' && msg.type === 'gif') return true;
				return false;
			});
			if (!hasMatch) return false;
		}

		// The text of a message this device cannot show is a placeholder Wabi
		// wrote, not what anyone said, so a text search never matches it.
		if (text && (msg.e2eeUnreadable || !msg.text.toLowerCase().includes(text))) {
			return false;
		}

		return true;
	});
}
