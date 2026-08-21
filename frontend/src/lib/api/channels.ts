import { getAuthToken } from '../authSession';
import { fetchWithTimeout, getApiBase } from './utils';
import type { CreateChannelResponse } from './types';

export async function createChannelApi(
	name: string,
	channelType: string = 'text',
	description?: string,
	forceSpoiler?: boolean,
	/** When true, server auto-provisions a Lore repo (requires wabi-lore feature). */
	assetStorage?: boolean,
	/** Category folder id to nest under (optional). */
	parentId?: string | null
): Promise<CreateChannelResponse> {
	const token = getAuthToken();
	// Lore / Asset Storage: UI type is "lore"; server stores ChannelKind::Text + asset_storage.
	const wantsAssetStorage = assetStorage === true || channelType === 'lore';
	const parent = parentId?.trim() || undefined;
	const res = await fetchWithTimeout(`${getApiBase()}/api/channels`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...(token ? { Authorization: `Bearer ${token}` } : {})
		},
		body: JSON.stringify({
			name,
			channel_type: channelType,
			description,
			force_spoiler: forceSpoiler ?? false,
			asset_storage: wantsAssetStorage,
			// Single key only. Sending BOTH parent_id and parentId made serde
			// reject the body as a duplicate field → bare 422 from axum
			// (folder placement never worked since 573ddee).
			...(parent ? { parent_id: parent } : {})
		})
	});
	if (!res.ok) {
		const error = await res.json().catch(() => ({}));
		throw new Error(error.error || `Failed to create channel: ${res.status}`);
	}
	return (await res.json()) as CreateChannelResponse;
}

export async function deleteChannelApi(channelId: string, options: { preserveChildren?: boolean } = {}): Promise<void> {
	const token = getAuthToken();
	const query = options.preserveChildren ? '?preserve_children=true' : '';
	const res = await fetchWithTimeout(`${getApiBase()}/api/channels/${encodeURIComponent(channelId)}${query}`, {
		method: 'DELETE',
		headers: token ? { Authorization: `Bearer ${token}` } : undefined
	});
	if (!res.ok) {
		const error = await res.json().catch(() => ({}));
		throw new Error(error.error || `Failed to delete channel: ${res.status}`);
	}
}
