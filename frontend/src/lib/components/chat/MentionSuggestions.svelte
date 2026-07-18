<script lang="ts">
	import { _ } from '$lib/i18n';
	import type { MentionSuggestion } from './types';

	export let suggestions: MentionSuggestion[] = [];
	export let selectedIndex = 0;
	export let container: HTMLElement | null = null;
	export let onApply: (index: number) => void | Promise<void>;
</script>

<div class="mention-suggestions" bind:this={container}>
	{#each suggestions as suggestion, index (suggestion.key)}
		<button
			type="button"
			class="mention-suggestion"
			class:selected={index === selectedIndex}
			on:mousedown|preventDefault={() => void onApply(index)}
		>
			<span class="mention-copy">
				<span class="mention-label">{suggestion.label}</span>
				{#if suggestion.detail}
					<span class="mention-detail">{suggestion.detail}</span>
				{/if}
			</span>
			<span class="mention-kind">
				{#if suggestion.kind === 'special'}
					{$_('chat.mentions.kind_mention')}
				{:else if suggestion.kind === 'place'}
					Place
				{:else if suggestion.kind === 'channel'}
					# Channel
				{:else if suggestion.kind === 'forum_post'}
					? Forum
				{:else if suggestion.kind === 'wiki_page'}
					! Wiki
				{:else if suggestion.kind === 'gallery_work'}
					~ Gallery
				{:else}
					@ User
				{/if}
			</span>
		</button>
	{/each}
</div>
