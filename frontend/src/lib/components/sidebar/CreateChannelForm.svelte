<script lang="ts">
	import { tick } from 'svelte';

	export let showCreateInput: boolean;
	export let newChannelName: string;
	export let newChannelDescription: string;
	export let newChannelType: 'text' | 'voice' | 'forum' | 'gallery' | 'wiki' | 'stage';
	export let createError = '';
	export let creatingChannel = false;

	export let onNameChange: (value: string) => void;
	export let onDescriptionChange: (value: string) => void;
	export let onTypeChange: (value: 'text' | 'voice' | 'forum' | 'gallery' | 'wiki' | 'stage') => void;
	export let onSubmit: () => void | Promise<void>;

	let inputEl: HTMLInputElement | null = null;

	$: if (showCreateInput) {
		void tick().then(() => inputEl?.focus());
	}

	function getChannelTypeLabel(type: string): string {
		if (type === 'voice') return 'Voice';
		if (type === 'forum') return 'Forum';
		if (type === 'gallery') return 'Gallery';
		if (type === 'wiki') return 'Wiki';
		if (type === 'stage') return 'Stage';
		return 'Text';
	}
</script>

{#if showCreateInput}
	<div class="create-channel">
		<input
			bind:this={inputEl}
			type="text"
			value={newChannelName}
			on:input={(e) => onNameChange((e.currentTarget as HTMLInputElement).value)}
			placeholder={newChannelType === 'voice' ? 'voice-room' : 'channel-name'}
			on:keydown={(e) => e.key === 'Enter' && !creatingChannel && onSubmit()}
		/>
		<input
			type="text"
			value={newChannelDescription}
			on:input={(e) => onDescriptionChange((e.currentTarget as HTMLInputElement).value)}
			placeholder="Description (optional)"
			on:keydown={(e) => e.key === 'Enter' && !creatingChannel && onSubmit()}
		/>
		<select value={newChannelType} on:change={(e) => onTypeChange((e.currentTarget as HTMLSelectElement).value as 'text' | 'voice' | 'forum' | 'gallery' | 'wiki' | 'stage')}>
			<option value="text">Text Channel</option>
			<option value="voice">Voice Channel</option>
			<option value="gallery">Gallery Channel</option>
			<option value="forum" disabled>Forum Channel (coming soon)</option>
		</select>
		<p class="create-channel-hint">Forum channels are planned but not supported yet.</p>
		{#if createError}
			<p class="create-channel-error" role="alert">{createError}</p>
		{/if}
		<button on:click={onSubmit} disabled={creatingChannel}>
			{creatingChannel ? 'Creating…' : `Create ${getChannelTypeLabel(newChannelType)} Channel`}
		</button>
	</div>
{/if}
