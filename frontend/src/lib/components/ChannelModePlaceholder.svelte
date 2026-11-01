<script lang="ts">
	import type { Channel } from '$lib/socket';

	export let channel: Channel | undefined;
	export let mode: 'forum' | 'wiki' | 'stage';

	const labels = {
		forum: {
			title: 'Forum',
			heading: 'This forum opens in its own view',
			copy: 'Pick it again from the channel list to read and start threads.'
		},
		wiki: {
			title: 'Wiki',
			heading: 'This wiki opens in its own view',
			copy: 'Pick it again from the channel list to read its pages.'
		},
		stage: {
			title: 'Stage',
			heading: 'Stages have no room view in this version',
			copy: 'Speaker and audience controls for stages aren’t available yet in this version of Wabi. Use a voice channel to talk together.'
		}
	};

	/*
	chatref-07: When forum/wiki product UI lands, import openShareModal from '$lib/shareStore'
	and wire object context menus via registerObjectRef (see docs/plans/2026-07-18-chat-object-refs.md).
	*/

	$: content = labels[mode] ?? {
		title: mode.charAt(0).toUpperCase() + mode.slice(1),
		heading: `This ${mode} channel has no view in this version`,
		copy: 'Open another channel from the list to keep going.'
	};
	$: channelName = channel?.name || content.title.toLowerCase();
	$: topic = channel?.topic || channel?.description || '';
</script>

<section class="channel-mode-placeholder" aria-label={`${content.title} channel placeholder`}>
	<div class="channel-mode-placeholder__icon" aria-hidden="true">
		{#if mode === 'forum'}
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/></svg>
		{:else if mode === 'wiki'}
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
		{:else}
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2v20"/><path d="M8 6h8"/><path d="M6 10h12"/><path d="M4 14h16"/><path d="M8 18h8"/></svg>
		{/if}
	</div>
	<div class="channel-mode-placeholder__copy">
		<span class="channel-mode-placeholder__kicker">#{channelName} · {content.title}</span>
		<h2>{content.heading}</h2>
		<p>{topic || content.copy}</p>
	</div>
</section>
