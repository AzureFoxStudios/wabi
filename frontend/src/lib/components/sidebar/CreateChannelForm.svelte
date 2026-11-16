<!--
	New channel / New folder dialog (spec §7.13, §8.9; critique settings#12), opened from the
	CHANNELS and VOICE menus, a folder's context menu and the `wabi:create-channel` event.
	- One kind radio list: each kind has its own glyph (text channels alone get the typeset '#')
	  and a one-line hint. Project files stays listed when the Lore add-on is off, disabled with the
	  reason, so the option is never silently missing.
	- The name field carries the kind's prefix ('#' for text channels); one primary action,
	  "Create channel" (or "Create folder"); quiet Cancel.
	The parent (ChannelSidebar) owns every value; this component only renders and reports.
-->
<script lang="ts">
	import { tick } from 'svelte';
	import type { CreateableChannelType } from '$lib/channelStore';
	import BaseModal from '$lib/components/BaseModal.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import Select, { type SelectOption } from '$lib/components/ui/Select.svelte';
	import type { IconName } from '$lib/components/ui/icons';
	import { _ } from '$lib/i18n';

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

	type KindOption = {
		id: CreateableChannelType;
		label: string;
		hint: string;
		/** Registry glyph; null = the typeset '#' of a text channel. */
		icon: IconName | null;
		/** Name-field prefix shown before what you type. */
		prefix: string | null;
		placeholder: string;
	};

	const KINDS: KindOption[] = [
		{ id: 'text', label: 'cch.kind_text', hint: 'cch.hint_text', icon: null, prefix: '#', placeholder: 'cch.ph_text' },
		{ id: 'voice', label: 'cch.kind_voice', hint: 'cch.hint_voice', icon: 'voice', prefix: null, placeholder: 'cch.ph_voice' },
		{ id: 'forum', label: 'cch.kind_forum', hint: 'cch.hint_forum', icon: 'forum', prefix: null, placeholder: 'cch.ph_forum' },
		{ id: 'wiki', label: 'cch.kind_wiki', hint: 'cch.hint_wiki', icon: 'book', prefix: null, placeholder: 'cch.ph_wiki' },
		{ id: 'gallery', label: 'cch.kind_gallery', hint: 'cch.hint_gallery', icon: 'image', prefix: null, placeholder: 'cch.ph_gallery' },
		{ id: 'planning', label: 'cch.kind_project', hint: 'cch.hint_project', icon: 'columns', prefix: null, placeholder: 'cch.ph_project' },
		{ id: 'lore', label: 'cch.kind_files', hint: 'cch.hint_files', icon: 'box', prefix: null, placeholder: 'cch.ph_files' },
		// One glyph per kind (§6): '#' is Text's alone, so the arrival page has its own.
		{ id: 'reception', label: 'cch.kind_welcome', hint: 'cch.hint_welcome', icon: 'home', prefix: null, placeholder: 'cch.ph_welcome' },
		{ id: 'category', label: 'cch.folder', hint: 'cch.hint_folder', icon: 'folder', prefix: null, placeholder: 'cch.ph_folder' }
	];
	const LORE_UNAVAILABLE_HINT = 'cch.lore_needed';

	$: selectedKind = KINDS.find((kind) => kind.id === newChannelType) ?? KINDS[0];
	$: isFolderType = newChannelType === 'category';
	// Project files is selectable only when the lore addon capability resolved true.
	// The option stays VISIBLE when unavailable (disabled + reason) so the kind isn't
	// silently missing — a flaky first capability probe no longer hides it.
	$: loreDisabled = newChannelType === 'lore' && !loreAvailable;
	$: open = showCreateInput && canCreate;
	$: title = isFolderType ? $_('sidebar.new_folder') : $_('sidebar.new_channel');
	$: submitLabel = isFolderType ? $_('cch.create_folder') : $_('sidebar.create_channel');
	$: canSubmit = !creatingChannel && Boolean(newChannelName.trim()) && !loreDisabled;

	$: folderOptions = [
		{ value: 'none', label: $_('cch.no_folder') },
		...categories.map((category) => ({ value: category.id, label: category.name, icon: 'folder' as const })),
		{ value: '__new__', label: $_('cch.new_folder'), icon: 'plus' as const }
	] satisfies SelectOption[];

	$: if (open) {
		void tick().then(() => inputEl?.focus());
	}

	// If lore is unavailable, keep the selection (don't silently reset) —
	// the option renders disabled and the submit button is gated instead.
	$: if (isFolderType && folderChoice !== 'none') {
		onFolderChoiceChange('none');
	}

	function submitOnEnter(event: KeyboardEvent) {
		if (event.key === 'Enter' && canSubmit) {
			event.preventDefault();
			void onSubmit();
		}
	}
</script>

<BaseModal isOpen={open} onClose={onCancel} size="md" {title} padded panelClass="create-channel-dialog">
	<form class="new-channel-form" aria-label={title} on:submit|preventDefault={() => { if (canSubmit) void onSubmit(); }}>
		<label class="w-label" for="create-channel-name">{$_('messages.viewer.details_name')}</label>
		<div class="w-field create-name">
			{#if selectedKind.prefix}
				<span class="create-name-prefix" aria-hidden="true">{selectedKind.prefix}</span>
			{:else if selectedKind.icon}
				<Icon name={selectedKind.icon} size={16} />
			{/if}
			<input
				id="create-channel-name"
				bind:this={inputEl}
				type="text"
				value={newChannelName}
				on:input={(e) => onNameChange((e.currentTarget as HTMLInputElement).value)}
				placeholder={$_(selectedKind.placeholder)}
				autocomplete="off"
				spellcheck="false"
				on:keydown={submitOnEnter}
			/>
		</div>

		<label class="w-label create-gap" for="create-channel-description">{$_('donation_config.description')} <span class="create-optional">{$_('cch.optional')}</span></label>
		<input
			id="create-channel-description"
			class="w-field"
			type="text"
			value={newChannelDescription}
			on:input={(e) => onDescriptionChange((e.currentTarget as HTMLInputElement).value)}
			placeholder={$_('cch.description_ph')}
			autocomplete="off"
			on:keydown={submitOnEnter}
		/>

		<fieldset class="create-kinds create-gap">
			<legend class="w-label">{$_('cch.kind')}</legend>
			<div class="create-kind-list">
				{#each KINDS as kind (kind.id)}
					{@const unavailable = kind.id === 'lore' && !loreAvailable}
					<label class="create-kind" class:selected={newChannelType === kind.id} class:unavailable>
						<input
							class="w-radio"
							type="radio"
							name="create-channel-kind"
							value={kind.id}
							checked={newChannelType === kind.id}
							disabled={unavailable}
							on:change={() => { if (!unavailable) onTypeChange(kind.id); }}
						/>
						<span class="create-kind-glyph" aria-hidden="true">
							{#if kind.icon}<Icon name={kind.icon} size={18} />{:else}<span class="create-kind-hash">#</span>{/if}
						</span>
						<span class="create-kind-text">
							<span class="create-kind-name">{$_(kind.label)}</span>
							<span class="create-kind-hint">{$_(unavailable ? LORE_UNAVAILABLE_HINT : kind.hint)}</span>
						</span>
					</label>
				{/each}
			</div>
		</fieldset>

		{#if !isFolderType}
			<div class="create-gap">
				<span class="w-label" id="create-channel-folder-label">{$_('cch.folder')}</span>
				<Select options={folderOptions} value={folderChoice} ariaLabel={$_('cch.folder')} onchange={(value) => onFolderChoiceChange(value)} />
				{#if folderChoice === '__new__'}
					<input
						class="w-field create-nested"
						type="text"
						aria-label={$_('cch.new_folder_name')}
						value={newFolderName}
						on:input={(e) => onNewFolderNameChange((e.currentTarget as HTMLInputElement).value)}
						placeholder={$_('cch.new_folder_name')}
						autocomplete="off"
						on:keydown={submitOnEnter}
					/>
					<p class="w-field-hint create-hint">{$_('cch.folder_hint')}</p>
				{/if}
			</div>
		{/if}

		<label class="w-choice create-gap create-spoiler">
			<input
				class="w-check"
				type="checkbox"
				checked={forceSpoiler}
				on:change={(e) => onForceSpoilerChange((e.currentTarget as HTMLInputElement).checked)}
			/>
			<span>{$_('cch.spoiler')}</span>
		</label>

		{#if createError}
			<p class="create-channel-error" role="alert"><Icon name="alert" size={14} />{createError}</p>
		{/if}
	</form>
	<div slot="footer" class="w-dialog__foot">
		<button type="button" class="w-btn w-btn--quiet" on:click={onCancel} disabled={creatingChannel}>{$_('common.cancel')}</button>
		<button
			type="button"
			class="w-btn w-btn--primary"
			aria-busy={creatingChannel}
			aria-disabled={!canSubmit}
			on:click={() => { if (canSubmit) void onSubmit(); }}
		>
			<span class="w-btn__swap"><span>{submitLabel}</span><span>{$_('cch.creating')}</span></span>
		</button>
	</div>
</BaseModal>
