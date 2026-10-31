<!--
	Following (design contract §8.11, §7.16): the channels you follow, kept on this device.
	A page header (kicker, serif title, one truthful line, mono counts), then the followed channels
	on this server as 56px rows (glyph stamp, name, kind, unread count, alert level, Unfollow), then
	the latest previews from every saved server as quiet rows. Everything is on --w-* roles.
-->
<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { channels, channelMessages, channelUnreadCounts, currentChannel, switchChannel, type Channel } from '$lib/socket';
	import {
		FOLLOW_ALERT_LEVEL_LABELS,
		allServerFollowedChannels,
		currentServerFollowedChannels,
		cycleChannelFollowAlertLevel,
		getCurrentFollowServerUrl,
		unfollowChannel
	} from '$lib/following';
	import { followedChannelSnapshots } from '$lib/followingSnapshots';
	import { currentSavedServer, switchToSavedServerChannel } from '$lib/savedServers';
	import { resolveServerUrl } from '$lib/serverUrl';
	import { getChannelTypeLabel } from '$lib/channelTypes';
	import Icon from '$lib/components/ui/Icon.svelte';

	const MAX_FEED_ITEMS = 64;
	const dispatch = createEventDispatcher<{
		openChannel: { channelId: string };
	}>();

	$: followedChannels = $currentServerFollowedChannels
		.map((preference) => {
			const channel = $channels.find((candidate) => candidate.id === preference.channelId);
			if (!channel) return null;
			return {
				channel,
				preference,
				unreadCount: $channelUnreadCounts[channel.id] || 0,
				previewCount: ($channelMessages[channel.id] || []).length
			};
		})
		.filter(Boolean) as Array<{
			channel: Channel;
			preference: (typeof $currentServerFollowedChannels)[number];
			unreadCount: number;
			previewCount: number;
		}>;

	$: snapshotFeedItems = $followedChannelSnapshots.slice(0, MAX_FEED_ITEMS);
	$: currentServerUrl = getCurrentFollowServerUrl();
	$: currentServerName = $currentSavedServer?.effectiveName || resolveServerUrl().url;
	$: followedUnreadCount = followedChannels.reduce((sum, entry) => sum + entry.unreadCount, 0);
	$: totalFollowCount = $allServerFollowedChannels.length;

	function openChannel(channelId: string): void {
		switchChannel(channelId);
		dispatch('openChannel', { channelId });
	}

	function openSnapshot(serverUrl: string, channelId: string): void {
		if (serverUrl === currentServerUrl) {
			openChannel(channelId);
			return;
		}
		switchToSavedServerChannel(serverUrl, channelId);
	}

	function cycleAlert(channelId: string): void {
		cycleChannelFollowAlertLevel(channelId);
	}

	/** Today: the time; another day: the date (mono in the row). */
	function formatTimestamp(timestamp: number): string {
		try {
			const date = new Date(timestamp);
			const today = date.toDateString() === new Date().toDateString();
			return new Intl.DateTimeFormat(undefined, today ? { hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric' }).format(date);
		} catch {
			return '';
		}
	}

	function summarizeChannel(channel: Channel): string {
		return getChannelTypeLabel(channel.type);
	}

	function summarizeSnapshotChannel(channelType: Channel['type'] | undefined): string {
		return getChannelTypeLabel(channelType);
	}
</script>

<section class="following" aria-labelledby="following-title">
	<header class="following__head">
		<p class="w-kicker">Following</p>
		<h1 class="following__title" id="following-title">Followed channels</h1>
		<p class="following__truth">Kept on this device. Channels on other servers show light previews and stay quiet until you raise their alert level.</p>
		<p class="following__counts"><span>{totalFollowCount} followed</span><span aria-hidden="true">·</span><span>{followedUnreadCount} unread here</span></p>
	</header>

	{#if totalFollowCount === 0}
		<div class="following__empty">
			<Icon name="star" size={28} class="following__empty-glyph" />
			<h2 class="following__empty-title">Nothing followed yet</h2>
			<p class="following__empty-text">Use the star in the channel list to follow a channel. Alt-click a channel there to glimpse it without switching.</p>
		</div>
	{:else}
		<section class="following__section" aria-labelledby="following-here">
			<h2 class="w-kicker following__kicker" id="following-here">On {currentServerName}</h2>
			{#if followedChannels.length === 0}
				<p class="following__note">No follows on this server yet. Your other saved servers still appear below.</p>
			{:else}
				<ul class="following__list">
					{#each followedChannels as entry (entry.channel.id)}
						<li class="follow-row" class:follow-row--current={$currentChannel === entry.channel.id} class:follow-row--unread={entry.unreadCount > 0}>
							<span class="follow-row__stamp" aria-hidden="true"><Icon name="hash" size={14} /></span>
							<span class="follow-row__text">
								<span class="follow-row__name">{entry.channel.name}</span>
								<span class="follow-row__meta">{summarizeChannel(entry.channel)}{#if entry.previewCount} · {entry.previewCount} recent{/if}</span>
							</span>
							{#if entry.unreadCount > 0}<span class="w-badge w-badge--sm follow-row__count" aria-label={`${entry.unreadCount} unread`}>{entry.unreadCount}</span>{/if}
							<span class="follow-row__actions">
								<button type="button" class="w-btn w-btn--quiet w-btn--sm" aria-label={`Alert level for ${entry.channel.name}: ${FOLLOW_ALERT_LEVEL_LABELS[entry.preference.alertLevel]}. Change`} title="Change the alert level" on:click={() => cycleAlert(entry.channel.id)}><Icon name="bell" size={14} />{FOLLOW_ALERT_LEVEL_LABELS[entry.preference.alertLevel]}</button>
								<button type="button" class="w-btn w-btn--quiet w-btn--sm" aria-label={`Unfollow ${entry.channel.name}`} on:click={() => unfollowChannel(entry.channel.id)}>Unfollow</button>
							</span>
							<button type="button" class="follow-row__hit" aria-label={`Open ${entry.channel.name}`} on:click={() => openChannel(entry.channel.id)}></button>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<section class="following__section" aria-labelledby="following-recent">
			<h2 class="w-kicker following__kicker" id="following-recent">Recent from followed servers</h2>
			<p class="following__note">Previews of the latest messages, held in memory while Wabi is open.</p>
			{#if snapshotFeedItems.length === 0}
				<p class="following__note following__note--empty">No recent posts yet. They appear as followed channels get new messages.</p>
			{:else}
				<ul class="following__list">
					{#each snapshotFeedItems as item (`${item.serverUrl}:${item.channelId}:${item.previewMessages[0]?.id || item.updatedAt}`)}
						{@const last = item.previewMessages[item.previewMessages.length - 1]}
						<li class="follow-row follow-row--post" class:follow-row--unread={item.unreadCount > 0}>
							<span class="follow-row__stamp" aria-hidden="true"><Icon name="hash" size={14} /></span>
							<span class="follow-row__text">
								<span class="follow-row__name">{item.channelName}<span class="follow-row__server"> · {item.serverName || item.serverUrl}</span></span>
								<span class="follow-row__body">{#if last}<strong>{last.user}</strong> {last.text}{:else}No preview yet · {summarizeSnapshotChannel(item.channelType)}{/if}</span>
							</span>
							{#if item.unreadCount > 0}<span class="w-badge w-badge--sm follow-row__count" aria-label={`${item.unreadCount} unread`}>{item.unreadCount}</span>{/if}
							<time class="follow-row__time" datetime={new Date(item.lastActivityAt).toISOString()}>{formatTimestamp(item.lastActivityAt)}</time>
							<button type="button" class="follow-row__hit" aria-label={`Open ${item.channelName} on ${item.serverName || item.serverUrl}`} on:click={() => openSnapshot(item.serverUrl, item.channelId)}></button>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/if}
</section>

<style>
	.following { flex: 1; min-height: 0; box-sizing: border-box; overflow-y: auto; padding: 40px var(--w-gutter, 32px) 56px; background: var(--w-bg); color: var(--w-text); }
	.following > * { width: min(760px, 100%); margin-inline: auto; }
	.following__head { margin-bottom: 28px; }
	.following__title { margin: 6px 0 6px; font: var(--w-t-display); color: var(--w-text); text-wrap: balance; }
	.following__truth { margin: 0; max-width: 64ch; font: var(--w-t-ui); color: var(--w-mute); }
	.following__counts { display: flex; gap: 8px; margin: 10px 0 0; font: var(--w-t-mono); font-variant-numeric: tabular-nums; color: var(--w-faint); }
	.following__section + .following__section { margin-top: 32px; }
	.following__kicker { margin: 0 0 6px; }
	.following__note { margin: 0 0 8px; font: var(--w-t-small); color: var(--w-mute); }
	.following__note--empty { color: var(--w-faint); }
	.following__list { margin: 0; padding: 0; list-style: none; border-top: var(--w-bw) solid var(--w-line); }

	.follow-row { position: relative; display: grid; grid-template-columns: 28px minmax(0, 1fr) auto auto; align-items: center; column-gap: 14px; min-height: 56px; padding: 8px 10px; border-bottom: var(--w-bw) solid var(--w-line); }
	.follow-row--post { grid-template-columns: 28px minmax(0, 1fr) auto auto; }
	.follow-row:hover { background: color-mix(in srgb, var(--w-raise) 60%, transparent); }
	.follow-row--current .follow-row__name { color: var(--w-accent); }
	.follow-row__hit { position: absolute; inset: 0; z-index: 0; min-height: 0; margin: 0; padding: 0; border: 0; background: transparent; cursor: pointer; }
	.follow-row__hit:focus-visible { outline: 2px solid var(--w-accent); outline-offset: -2px; }
	.follow-row__actions { position: relative; z-index: 1; display: inline-flex; gap: 2px; }
	.follow-row__stamp { display: grid; place-items: center; width: 28px; height: 28px; border-radius: var(--radius-inner); background: var(--w-raise); color: var(--w-mute); }
	.follow-row__text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
	.follow-row__name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: var(--w-t-label); color: var(--w-text); }
	.follow-row--unread .follow-row__name { font-weight: 700; }
	.follow-row__server { font-weight: 400; color: var(--w-faint); }
	.follow-row__meta { font: var(--w-t-small); color: var(--w-faint); }
	.follow-row__body { overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; font: var(--w-t-small); color: var(--w-mute); }
	.follow-row__body strong { font-weight: 500; color: var(--w-text); }
	.follow-row__count { position: relative; z-index: 1; }
	.follow-row__time { font: var(--w-t-mono); font-variant-numeric: tabular-nums; color: var(--w-faint); white-space: nowrap; }

	.following__empty { max-width: 460px; padding-top: 12px; }
	.following__empty :global(.following__empty-glyph) { color: var(--w-faint); }
	.following__empty-title { margin: 12px 0 6px; font: 600 calc(20px * var(--w-fs)) / calc(26px * var(--w-fs)) var(--w-serif); color: var(--w-text); }
	.following__empty-text { margin: 0; font: var(--w-t-ui); color: var(--w-mute); }

	:global(:root[data-char='contrast']) .follow-row:hover { background: transparent; box-shadow: inset 0 0 0 var(--w-bw) var(--w-text); }

	@media (max-width: 768px) {
		.following { padding: 20px 16px 40px; }
		.follow-row { grid-template-columns: 28px minmax(0, 1fr) auto; row-gap: 4px; padding: 10px 4px; }
		.follow-row__actions { grid-column: 2 / -1; grid-row: 2; }
	}
</style>
