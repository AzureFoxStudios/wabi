<script lang="ts">
	import type { Channel } from '$lib/socket';

	export let channel: Channel | undefined;
	export let mode: 'forum' | 'wiki' | 'stage';

	const labels = {
		forum: {
			title: 'Forum',
			heading: 'Forum posts are not wired yet',
			copy: 'This channel is ready for a topic-thread renderer once the forum message model lands.'
		},
		wiki: {
			title: 'Wiki',
			heading: 'Wiki pages are not wired yet',
			copy: 'This channel is ready for a markdown page renderer and navigation layer.'
		},
		stage: {
			title: 'Stage',
			heading: 'Stage controls are not wired yet',
			copy: 'This channel is ready for a moderated voice stage surface.'
		}
	};

	$: content = labels[mode];
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
