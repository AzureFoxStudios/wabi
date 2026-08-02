<script lang="ts">
	import { tick } from 'svelte';
	import type { CreateableChannelType } from '$lib/channelStore';

	export let showCreateInput: boolean;
	export let newChannelName: string;
	export let newChannelDescription: string;
	export let newChannelType: CreateableChannelType;
	export let forceSpoiler = false;
	export let createError = '';
	export let creatingChannel = false;
	/** A6: Asset Storage option only when lore addon is enabled on this server. */
	export let loreAvailable = false;

	export let onNameChange: (value: string) => void;
	export let onDescriptionChange: (value: string) => void;
	export let onTypeChange: (value: CreateableChannelType) => void;
	export let onForceSpoilerChange: (value: boolean) => void = () => {};
	export let onSubmit: () => void | Promise<void>;
	export let canCreate = false;

	let inputEl: HTMLInputElement | null = null;

	$: if (showCreateInput) {
		void tick().then(() => inputEl?.focus());
	}

	// If lore drops while form is open on lore, fall back to text.
	$: if (!loreAvailable && newChannelType === 'lore') {
		onTypeChange('text');
	}

	function getChannelTypeLabel(type: string): string {
		if (type === 'voice') return 'Voice';
		if (type === 'forum') return 'Forum';
		if (type === 'gallery') return 'Gallery';
		if (type === 'wiki') return 'Wiki';
		if (type === 'stage') return 'Stage';
		if (type === 'lore') return 'Asset Storage';
		return 'Text';
	}
</script>

{#if showCreateInput && canCreate}
	<div class="create-channel">
		<input
			bind:this={inputEl}
			type="text"
			value={newChannelName}
			on:input={(e) => onNameChange((e.currentTarget as HTMLInputElement).value)}
			placeholder={newChannelType === 'voice'
				? 'voice-room'
				: newChannelType === 'lore'
					? 'asset-storage'
					: newChannelType === 'forum'
						? 'forum-board'
						: newChannelType === 'wiki'
							? 'wiki-pages'
							: newChannelType === 'gallery'
								? 'gallery'
								: 'channel-name'}
			on:keydown={(e) => e.key === 'Enter' && !creatingChannel && onSubmit()}
		/>
		<input
			type="text"
			value={newChannelDescription}
			on:input={(e) => onDescriptionChange((e.currentTarget as HTMLInputElement).value)}
			placeholder="Description (optional)"
			on:keydown={(e) => e.key === 'Enter' && !creatingChannel && onSubmit()}
		/>
		<select
			value={newChannelType}
			on:change={(e) =>
				onTypeChange((e.currentTarget as HTMLSelectElement).value as CreateableChannelType)}
		>
			<option value="text">Text Channel</option>
			<option value="voice">Voice Channel</option>
			<option value="gallery">Gallery Channel</option>
			<option value="forum">Forum Channel</option>
			<option value="wiki">Wiki Channel</option>
			{#if loreAvailable}
				<option value="lore">Asset Storage</option>
			{/if}
		</select>
		{#if loreAvailable && newChannelType === 'lore'}
			<p class="create-channel-hint">
				Asset Storage uses the Lore add-on for versioned binary assets (CAD, 3D, large files).
			</p>
		{:else if newChannelType === 'forum'}
			<p class="create-channel-hint">Forum channels host threads and posts (not a chat stream).</p>
		{:else if newChannelType === 'wiki'}
			<p class="create-channel-hint">Wiki channels host pages and revisions.</p>
		{:else if newChannelType === 'gallery'}
			<p class="create-channel-hint">Gallery channels host media albums.</p>
		{/if}
		<label class="create-channel-spoiler">
			<input
				type="checkbox"
				checked={forceSpoiler}
				on:change={(e) => onForceSpoilerChange((e.currentTarget as HTMLInputElement).checked)}
			/>
			<span>🔒 Spoiler channel — automatically hide all messages</span>
		</label>
		{#if createError}
			<p class="create-channel-error" role="alert">{createError}</p>
		{/if}
		<button on:click={onSubmit} disabled={creatingChannel}>
			{creatingChannel ? 'Creating…' : `Create ${getChannelTypeLabel(newChannelType)} Channel`}
		</button>
	</div>
{/if}
