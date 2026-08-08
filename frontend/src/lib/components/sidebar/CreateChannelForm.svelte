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
	/** Existing category folders for the folder picker. */
	export let categories: { id: string; name: string }[] = [];
	/** Folder placement: none | existing folder id | __new__ */
	export let folderChoice: string = 'none';
	export let newFolderName: string = '';

	export let onNameChange: (value: string) => void;
	export let onDescriptionChange: (value: string) => void;
	export let onTypeChange: (value: CreateableChannelType) => void;
	export let onForceSpoilerChange: (value: boolean) => void = () => {};
	export let onFolderChoiceChange: (value: string) => void = () => {};
	export let onNewFolderNameChange: (value: string) => void = () => {};
	export let onSubmit: () => void | Promise<void>;
	export let onCancel: () => void = () => {};
	export let canCreate = false;

	let inputEl: HTMLInputElement | null = null;

	type TypeOption = {
		id: CreateableChannelType;
		label: string;
		hint: string;
		icon: 'hash' | 'folder' | 'mic' | 'image' | 'forum' | 'book' | 'kanban' | 'box';
	};

	$: typeOptions = (
		[
			{ id: 'text', label: 'Text', hint: 'Chat stream', icon: 'hash' },
			{ id: 'voice', label: 'Voice', hint: 'Live call room', icon: 'mic' },
			{ id: 'forum', label: 'Forum', hint: 'Threads & posts', icon: 'forum' },
			{ id: 'gallery', label: 'Gallery', hint: 'Media albums', icon: 'image' },
			{ id: 'wiki', label: 'Wiki', hint: 'Pages & revisions', icon: 'book' },
			{ id: 'planning', label: 'Planner', hint: 'Board & calendar', icon: 'kanban' },
			{ id: 'category', label: 'Folder', hint: 'Group channels', icon: 'folder' },
						...(loreAvailable
							? ([{ id: 'lore', label: 'Code', hint: 'Versioned code & files', icon: 'box' }] as TypeOption[])
							: [])
		] as TypeOption[]
	);

	$: selectedType = typeOptions.find((t) => t.id === newChannelType) ?? typeOptions[0];
	$: isFolderType = newChannelType === 'category';
	$: namePlaceholder =
		newChannelType === 'voice'
			? 'voice-room'
					: newChannelType === 'lore'
					? 'code-repo'
				: newChannelType === 'forum'
					? 'forum-board'
					: newChannelType === 'wiki'
						? 'wiki-pages'
						: newChannelType === 'gallery'
							? 'gallery'
							: newChannelType === 'planning'
								? 'planning-board'
								: newChannelType === 'category'
									? 'folder-name'
									: 'channel-name';

	$: if (showCreateInput) {
		void tick().then(() => inputEl?.focus());
	}

	// If lore drops while form is open on lore, fall back to text.
	$: if (!loreAvailable && newChannelType === 'lore') {
		onTypeChange('text');
	}

	// Creating a folder itself never nests under another folder in this form.
	$: if (isFolderType && folderChoice !== 'none') {
		onFolderChoiceChange('none');
	}

	function getChannelTypeLabel(type: string): string {
		return typeOptions.find((t) => t.id === type)?.label ?? 'Text';
	}
</script>

{#if showCreateInput && canCreate}
	<div class="create-channel" role="form" aria-label="Create channel">
		<header class="create-channel-header">
			<div class="create-channel-title-wrap">
				<span class="create-channel-kicker">New</span>
				<strong class="create-channel-title">{isFolderType ? 'Folder' : 'Channel'}</strong>
			</div>
			<button type="button" class="create-channel-close" on:click={onCancel} aria-label="Cancel" title="Cancel">
				×
			</button>
		</header>

		<label class="create-field">
			<span class="create-field-label">Name</span>
			<input
				bind:this={inputEl}
				class="create-field-input"
				type="text"
				value={newChannelName}
				on:input={(e) => onNameChange((e.currentTarget as HTMLInputElement).value)}
				placeholder={namePlaceholder}
				autocomplete="off"
				on:keydown={(e) => e.key === 'Enter' && !creatingChannel && onSubmit()}
			/>
		</label>

		<label class="create-field">
			<span class="create-field-label">Description <span class="create-optional">optional</span></span>
			<input
				class="create-field-input"
				type="text"
				value={newChannelDescription}
				on:input={(e) => onDescriptionChange((e.currentTarget as HTMLInputElement).value)}
				placeholder="What is this for?"
				autocomplete="off"
				on:keydown={(e) => e.key === 'Enter' && !creatingChannel && onSubmit()}
			/>
		</label>

		<div class="create-field">
			<span class="create-field-label">Type</span>
			<div class="create-type-grid" role="listbox" aria-label="Channel type">
				{#each typeOptions as opt (opt.id)}
					<button
						type="button"
						class="create-type-chip"
						class:active={newChannelType === opt.id}
						role="option"
						aria-selected={newChannelType === opt.id}
						on:click={() => onTypeChange(opt.id)}
						title={opt.hint}
					>
						<span class="create-type-icon" data-icon={opt.icon} aria-hidden="true"></span>
						<span class="create-type-text">
							<span class="create-type-name">{opt.label}</span>
							<span class="create-type-hint">{opt.hint}</span>
						</span>
					</button>
				{/each}
			</div>
			{#if selectedType}
				<p class="create-channel-hint">{selectedType.hint}{#if selectedType.id === 'category'} — drag channels onto it anytime.{/if}</p>
			{/if}
		</div>

		{#if !isFolderType}
			<div class="create-field">
				<span class="create-field-label">Folder</span>
				<select
					class="create-field-select"
					value={folderChoice}
					on:change={(e) => onFolderChoiceChange((e.currentTarget as HTMLSelectElement).value)}
				>
					<option value="none">No folder (top level)</option>
					{#each categories as cat (cat.id)}
						<option value={cat.id}>{cat.name}</option>
					{/each}
					<option value="__new__">+ New folder…</option>
				</select>
				{#if folderChoice === '__new__'}
					<input
						class="create-field-input create-field-input-nested"
						type="text"
						value={newFolderName}
						on:input={(e) => onNewFolderNameChange((e.currentTarget as HTMLInputElement).value)}
						placeholder="New folder name"
						autocomplete="off"
						on:keydown={(e) => e.key === 'Enter' && !creatingChannel && onSubmit()}
					/>
					<p class="create-channel-hint">Creates the folder first, then puts this channel inside it.</p>
				{:else if folderChoice !== 'none'}
					<p class="create-channel-hint">Channel will appear under this folder after create.</p>
				{/if}
			</div>
		{/if}

		<label class="create-channel-spoiler">
			<input
				type="checkbox"
				checked={forceSpoiler}
				on:change={(e) => onForceSpoilerChange((e.currentTarget as HTMLInputElement).checked)}
			/>
			<span>Spoiler channel — hide all messages by default</span>
		</label>

		{#if createError}
			<p class="create-channel-error" role="alert">{createError}</p>
		{/if}

		<div class="create-channel-actions">
			<button type="button" class="create-btn-ghost" on:click={onCancel} disabled={creatingChannel}>Cancel</button>
			<button type="button" class="create-btn-primary" on:click={onSubmit} disabled={creatingChannel || !newChannelName.trim()}>
				{creatingChannel ? 'Creating…' : `Create ${getChannelTypeLabel(newChannelType)}`}
			</button>
		</div>
	</div>
{/if}
