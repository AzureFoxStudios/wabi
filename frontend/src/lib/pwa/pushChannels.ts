/**
 * pushChannels.ts
 *
 * The channel list behind Settings → Notifications → "Push: Channels".
 *
 * Message push for server channels is opt-in per channel: every channel
 * (text, voice, forum, group …) starts OFF and the user switches on exactly
 * the ones they want. DMs are not part of this list — they follow the
 * account-level "Push: Direct messages" switch — and categories are absent
 * because they hold channels rather than messages. This module keeps the row
 * building pure and testable so the settings component only handles state,
 * joining and saving.
 */
import type { Channel } from '$lib/socket-types';

export type PushChannelRow = {
	id: string;
	label: string;
	/** The channel type, shown as the row's chip: text, voice, group, forum… */
	type: string;
};

/**
 * Channels that can push — everything except DMs (their own account switch)
 * and categories (no messages) — sorted for scanning. Every row starts OFF;
 * a toggle without a working dispatcher would be a lie, and channel message
 * dispatch is wired server-side via PushKind::ChannelMessage.
 */
export function buildPushChannelRows(list: Channel[]): PushChannelRow[] {
	return list
		.filter((channel) => channel.type !== 'dm' && channel.type !== 'category')
		.map((channel) => ({
			id: channel.id,
			label: String(channel.name || '').trim() || channel.id,
			type: String(channel.type || 'channel')
		}))
		.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}
