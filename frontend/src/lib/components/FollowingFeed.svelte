<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { brandName } from '$lib/branding';
	import { channels, channelMessages, channelUnreadCounts, currentChannel, joinChannel, type Channel } from '$lib/socket';
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
	import { getChannelTypeIcon, getChannelTypeLabel } from '$lib/channelTypes';

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
		joinChannel(channelId);
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

	function formatTimestamp(timestamp: number): string {
		try {
			return new Intl.DateTimeFormat(undefined, {
				month: 'short',
				day: 'numeric',
				hour: 'numeric',
				minute: '2-digit'
			}).format(new Date(timestamp));
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

<section class="following-feed">
	<header class="following-hero">
		<div>
			<div class="following-eyebrow">Following</div>
			<h1>Only the feeds you care about</h1>
			<p>
				Local to this device. One community can stay hot in RAM while followed previews from other saved
				servers stay lightweight and quiet until you raise their alert level.
			</p>
		</div>
		<div class="following-stats">
			<div>
				<strong>{totalFollowCount}</strong>
				<span>feeds</span>
			</div>
			<div>
				<strong>{followedUnreadCount}</strong>
				<span>unread</span>
			</div>
		</div>
	</header>

	{#if totalFollowCount === 0}
		<div class="following-empty">
			<h2>Nothing followed yet</h2>
			<p>Use the star in the channel list to follow a channel. Alt-click a channel there to glimpse it without fully switching.</p>
		</div>
	{:else}
		<section class="following-strip" aria-label="Followed channels">
			{#if followedChannels.length === 0}
				<div class="following-empty following-empty--inline">
					<h2>No follows on this server yet</h2>
					<p>Your other saved servers can still appear below from lightweight follow snapshots.</p>
				</div>
			{/if}
			{#each followedChannels as entry (entry.channel.id)}
				<article class="follow-card" class:active={$currentChannel === entry.channel.id}>
					<button type="button" class="follow-card-main" on:click={() => openChannel(entry.channel.id)}>
						<div class="follow-card-header">
							<span class="follow-channel-pill">{getChannelTypeIcon(entry.channel.type)}</span>
							<strong>{entry.channel.name}</strong>
							{#if entry.unreadCount > 0}
								<span class="follow-unread">{entry.unreadCount}</span>
							{/if}
						</div>
						<div class="follow-card-meta">
							<span>{summarizeChannel(entry.channel)}</span>
							<span>{entry.previewCount} cached</span>
						</div>
					</button>
					<div class="follow-card-actions">
						<button
							type="button"
							class="follow-alert-btn"
							on:click={() => cycleAlert(entry.channel.id)}
							title={`Alert level: ${FOLLOW_ALERT_LEVEL_LABELS[entry.preference.alertLevel]}`}
						>
							{FOLLOW_ALERT_LEVEL_LABELS[entry.preference.alertLevel]}
						</button>
						<button
							type="button"
							class="follow-unfollow-btn"
							on:click={() => unfollowChannel(entry.channel.id)}
							title="Unfollow channel"
						>
							Unfollow
						</button>
					</div>
				</article>
			{/each}
		</section>

		<section class="following-stream" aria-label="Recent posts from followed channels">
			<div class="stream-header">
				<h2>Recent from all followed servers</h2>
				<p>Preview snapshots only. {brandName} is not loading whole extra communities into RAM for this view.</p>
			</div>

			{#if snapshotFeedItems.length === 0}
				<div class="following-empty following-empty--stream">
					<h2>No recent posts loaded</h2>
					<p>Open a followed channel once on any saved server to seed its lightweight preview here.</p>
				</div>
			{:else}
				<div class="stream-list">
					{#each snapshotFeedItems as item (`${item.serverUrl}:${item.channelId}:${item.previewMessages[0]?.id || item.updatedAt}`)}
						<button type="button" class="stream-card" on:click={() => openSnapshot(item.serverUrl, item.channelId)}>
							<div class="stream-card-topline">
								<div class="stream-channel-meta">
									<span class="stream-channel-name">{getChannelTypeIcon(item.channelType)} {item.channelName}</span>
									<span class="stream-server-name">{item.serverName || item.serverUrl}</span>
								</div>
								<time>{formatTimestamp(item.lastActivityAt)}</time>
							</div>
							<div class="stream-card-summary">
								<span class="stream-summary-pill">{summarizeSnapshotChannel(item.channelType)}</span>
								{#if item.unreadCount > 0}
									<span class="stream-summary-pill stream-summary-pill--unread">{item.unreadCount} unread</span>
								{/if}
							</div>
							{#if item.previewMessages.length > 0}
								<div class="stream-author">{item.previewMessages[item.previewMessages.length - 1]?.user}</div>
								<div class="stream-body">{item.previewMessages[item.previewMessages.length - 1]?.text}</div>
							{:else}
								<div class="stream-body">No cached preview yet.</div>
							{/if}
						</button>
					{/each}
				</div>
			{/if}
		</section>
	{/if}
</section>

<style>
	.following-feed {
		height: 100%;
		display: flex;
		flex-direction: column;
		gap: 1rem;
		padding: 1.15rem 1.1rem 1.3rem;
		background:
			radial-gradient(circle at top left, rgba(var(--color-success-rgb, 45, 212, 191), 0.12), transparent 34%),
			radial-gradient(circle at top right, rgba(var(--color-info-rgb, 56, 189, 248), 0.12), transparent 30%),
			linear-gradient(180deg, rgba(var(--surface-app-rgb, 7, 12, 18), 0.98), rgba(var(--surface-app-rgb, 10, 15, 24), 0.96));
		overflow: hidden;
		box-sizing: border-box;
	}

	.following-hero {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 1rem;
		padding: 1.2rem 1.25rem;
		border: 1px solid rgba(var(--accent-primary-rgb, 99, 102, 241), 0.14);
		border-radius: 22px;
		background: linear-gradient(145deg, rgba(var(--surface-app-rgb, 17, 24, 39), 0.92), rgba(var(--surface-app-rgb, 15, 23, 42), 0.82));
		box-shadow: 0 16px 40px var(--shadow-md, var(--shadow-sm, var(--shadow-md, var(--shadow-lg, rgba(0, 0, 0, 0.24)))));
	}

	.following-eyebrow {
		text-transform: uppercase;
		letter-spacing: 0.18em;
		font-size: 0.72rem;
		font-weight: 700;
		color: rgba(var(--color-success-rgb, 94, 234, 212), 0.86);
		margin-bottom: 0.35rem;
	}

	.following-hero h1,
	.following-empty h2,
	.stream-header h2 {
		margin: 0;
		font-size: clamp(1.15rem, 2vw, 1.7rem);
	}

	.following-hero p,
	.following-empty p,
	.stream-header p {
		margin: 0.45rem 0 0;
		color: rgba(var(--text-inverse-rgb, 226, 232, 240), 0.72);
		line-height: 1.45;
	}

	.following-stats {
		display: flex;
		gap: 0.75rem;
		flex-shrink: 0;
	}

	.following-stats > div {
		min-width: 86px;
		padding: 0.85rem 0.9rem;
		border-radius: 18px;
		background: rgba(var(--surface-app-rgb, 15, 23, 42), 0.72);
		border: 1px solid rgba(var(--text-muted-rgb, 148, 163, 184), 0.14);
		text-align: center;
	}

	.following-stats strong {
		display: block;
		font-size: 1.2rem;
	}

	.following-stats span {
		font-size: 0.8rem;
		color: rgba(var(--text-inverse-rgb, 226, 232, 240), 0.6);
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}

	.following-strip {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 0.85rem;
	}

	.follow-card,
	.stream-card,
	.following-empty {
		border-radius: 20px;
		border: 1px solid rgba(var(--text-muted-rgb, 148, 163, 184), 0.12);
		background: rgba(var(--surface-app-rgb, 15, 23, 42), 0.72);
		box-shadow: 0 12px 28px var(--shadow-md, var(--shadow-md, var(--shadow-md, rgba(0, 0, 0, 0.16))));
	}

	.follow-card {
		padding: 0.9rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.follow-card.active {
		border-color: rgba(var(--color-success-rgb, 94, 234, 212), 0.42);
		box-shadow: 0 16px 34px rgba(var(--color-success-rgb, 45, 212, 191), 0.16);
	}

	.follow-card-main,
	.stream-card {
		background: none;
		border: 0;
		color: inherit;
		text-align: left;
		cursor: pointer;
	}

	.follow-card-main {
		padding: 0;
	}

	.follow-card-header {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.follow-channel-pill,
	.follow-unread {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: 999px;
		padding: 0.16rem 0.5rem;
		font-size: 0.73rem;
		font-weight: 700;
		background: rgba(var(--surface-base-rgb, 30, 41, 59), 0.88);
	}

	.follow-channel-pill {
		color: rgba(var(--color-info-rgb, 125, 211, 252), 0.95);
	}

	.follow-unread {
		margin-left: auto;
		color: rgba(254, 242, 242, 0.95);
		background: rgba(var(--color-danger-rgb, 239, 68, 68), 0.85);
	}

	.follow-card-meta,
	.stream-card-topline,
	.stream-channel-meta,
	.follow-card-actions {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.55rem;
	}

	.follow-card-meta,
	.stream-card-topline time,
	.stream-server-name {
		font-size: 0.8rem;
		color: rgba(var(--text-inverse-rgb, 226, 232, 240), 0.58);
	}

	.follow-alert-btn,
	.follow-unfollow-btn {
		padding: 0.45rem 0.65rem;
		border-radius: 999px;
		border: 1px solid rgba(var(--text-muted-rgb, 148, 163, 184), 0.16);
		background: rgba(var(--surface-app-rgb, 15, 23, 42), 0.9);
		color: rgba(var(--text-inverse-rgb, 241, 245, 249), 0.86);
		font: inherit;
		cursor: pointer;
	}

	.follow-alert-btn:hover,
	.follow-unfollow-btn:hover,
	.stream-card:hover,
	.follow-card-main:hover {
		filter: brightness(1.08);
	}

	.following-stream {
		min-height: 0;
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
	}

	.stream-list {
		min-height: 0;
		overflow: auto;
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
		padding-right: 0.2rem;
	}

	.stream-card {
		padding: 0.95rem 1rem;
		transition: transform 140ms ease, border-color 140ms ease, background 140ms ease;
	}

	.stream-card:hover {
		transform: translateY(-1px);
		border-color: rgba(var(--color-success-rgb, 94, 234, 212), 0.28);
		background: rgba(var(--surface-app-rgb, 15, 23, 42), 0.88);
	}

	.stream-channel-name,
	.stream-author {
		font-weight: 700;
	}

	.stream-author {
		margin-top: 0.45rem;
	}

	.stream-body {
		margin-top: 0.32rem;
		color: rgba(var(--text-inverse-rgb, 241, 245, 249), 0.82);
		line-height: 1.45;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.following-empty {
		padding: 1.25rem 1.35rem;
	}

	.following-empty--inline {
		grid-column: 1 / -1;
	}

	.following-empty--stream {
		margin-top: 0.25rem;
	}

	.stream-card-summary {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		margin-top: 0.45rem;
	}

	.stream-summary-pill {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: 999px;
		padding: 0.14rem 0.48rem;
		font-size: 0.7rem;
		font-weight: 700;
		background: rgba(var(--surface-base-rgb, 30, 41, 59), 0.88);
		color: rgba(var(--text-inverse-rgb, 226, 232, 240), 0.9);
	}

	.stream-summary-pill--unread {
		background: rgba(var(--color-danger-rgb, 239, 68, 68), 0.82);
		color: var(--text-inverse, var(--text-inverse, #fff));
	}

	@media (max-width: 900px) {
		.following-feed {
			padding: 0.9rem 0.8rem 1rem;
		}

		.following-hero {
			flex-direction: column;
		}

		.following-stats {
			width: 100%;
		}

		.following-stats > div {
			flex: 1;
		}
	}
</style>
