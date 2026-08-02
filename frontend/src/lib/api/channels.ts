import { getAuthToken } from '../authSession';
import { fetchWithTimeout, getApiBase } from './utils';
import type { CreateChannelResponse } from './types';

export async function createChannelApi(
	name: string,
	channelType: string = 'text',
	description?: string,
	forceSpoiler?: boolean,
	/** When true, server auto-provisions a Lore repo (requires wabi-lore feature). */
	assetStorage?: boolean
): Promise<CreateChannelResponse> {
	const token = getAuthToken();
	// Lore / Asset Storage: UI type is "lore"; server stores ChannelKind::Text + asset_storage.
	const wantsAssetStorage = assetStorage === true || channelType === 'lore';
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
			asset_storage: wantsAssetStorage
		})
	});
	if (!res.ok) {
		const error = await res.json().catch(() => ({}));
		throw new Error(error.error || `Failed to create channel: ${res.status}`);
	}
	return (await res.json()) as CreateChannelResponse;
}

export async function deleteChannelApi(channelId: string): Promise<void> {
	const token = getAuthToken();
	const res = await fetchWithTimeout(`${getApiBase()}/api/channels/${encodeURIComponent(channelId)}`, {
		method: 'DELETE',
		headers: token ? { Authorization: `Bearer ${token}` } : undefined
	});
	if (!res.ok) {
		const error = await res.json().catch(() => ({}));
		throw new Error(error.error || `Failed to delete channel: ${res.status}`);
	}
}
