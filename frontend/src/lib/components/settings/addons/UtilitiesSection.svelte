<script lang="ts">
	import { _ } from '$lib/i18n';
	import { get } from 'svelte/store';
	import { emojis } from '$lib/socket';
	import { chatAliasesStore, chatFilterStore, customQuoteSettingsStore, addChatAlias, removeChatAlias, resetCustomQuoteTemplate, setChatFilterSettings, setCustomQuoteTemplate, updateChatAlias, type ChatAliasEntry, type ChatFilterMode } from '$lib/chatEnhancements';
	import {
		getTranslatorSettings,
		probeTranslatorProvider,
		resolveTranslatorProviderUrl,
		saveTranslatorSettings,
		type TranslatorMode,
		type TranslatorModelId
	} from '$lib/components/message/messageTranslator';
	import { ADDON_SECTION_LABELS } from '../addonSettingsRegistry';
	import AddonRow from './AddonRow.svelte';
	import Switch from '../../ui/Switch.svelte';
	import Select from '../../ui/Select.svelte';

	export let localAddonControlMatches: (controlId: string) => boolean;
	// Translator Assist is a bundled client add-on, so its row never depends on what the server lists.

	const SECTION = ADDON_SECTION_LABELS.utilities;

	const TRANSLATOR_MODEL_OPTIONS: Array<{ id: TranslatorModelId; label: string }> = [
		{ id: 'libretranslate-local', label: $_('utilities.libre_local') },
		{ id: 'libretranslate-self-hosted', label: $_('utilities.libre_self') }
	];
	const LOCAL_TRANSLATOR_DOCKER_COMMAND =
		'docker run -d --name wabi-translate --restart unless-stopped -p 127.0.0.1:5000:5000 libretranslate/libretranslate:latest';

	let translatorMode: TranslatorMode = 'off';
	let translatorModel: TranslatorModelId = 'libretranslate-local';
	let translatorProviderUrl = resolveTranslatorProviderUrl('libretranslate-local');
	let translatorTargetLang = 'en';
	let translatorUnderstoodLanguages = 'en';
	let translatorSettingsSavedAt = '';
	let translatorProbeState: 'idle' | 'checking' | 'ok' | 'error' = 'idle';
	let translatorProbeMessage = '';
	let chatAliasTriggerDraft = '';
	let chatAliasReplacementDraft = '';
	let quoteTemplateDraft = '';

	function loadTranslatorAddonSettings(): void {
		const settings = getTranslatorSettings();
		translatorMode = settings.mode;
		translatorModel = settings.model;
		translatorProviderUrl = settings.providerUrl;
		translatorTargetLang = settings.targetLang;
		translatorUnderstoodLanguages = settings.understoodLanguages.join(', ');
	}
	loadTranslatorAddonSettings();

	function saveTranslatorAddonSettings(): void {
		const understoodLanguages = translatorUnderstoodLanguages
			.split(',')
			.map((value) => value.trim())
			.filter(Boolean);
		const providerUrl = translatorModel === 'libretranslate-local'
			? resolveTranslatorProviderUrl('libretranslate-local')
			: translatorProviderUrl.trim();
		saveTranslatorSettings({
			mode: translatorMode,
			model: translatorModel,
			providerUrl,
			sourceLang: 'auto',
			targetLang: translatorTargetLang.trim() || 'en',
			understoodLanguages,
			useProxy: false
		});
		translatorProviderUrl = getTranslatorSettings().providerUrl;
		translatorSettingsSavedAt = new Date().toLocaleTimeString();
		translatorProbeState = 'idle';
		translatorProbeMessage = '';
	}

	function handleTranslatorModelChange(): void {
		if (translatorModel === 'libretranslate-local') {
			translatorProviderUrl = resolveTranslatorProviderUrl('libretranslate-local');
		} else if (translatorProviderUrl === resolveTranslatorProviderUrl('libretranslate-local')) {
			translatorProviderUrl = '';
		}
		saveTranslatorAddonSettings();
	}

	async function checkTranslatorProvider(): Promise<void> {
		saveTranslatorAddonSettings();
		translatorProbeState = 'checking';
		translatorProbeMessage = $_('utilities.checking_translator');
		const result = await probeTranslatorProvider(getTranslatorSettings());
		translatorProbeState = result.ok ? 'ok' : 'error';
		translatorProbeMessage = result.message;
	}

	async function copyLocalTranslatorCommand(): Promise<void> {
		try {
			await navigator.clipboard.writeText(LOCAL_TRANSLATOR_DOCKER_COMMAND);
			translatorProbeState = 'ok';
			translatorProbeMessage = $_('utilities.command_copied');
		} catch {
			translatorProbeState = 'error';
			translatorProbeMessage = $_('utilities.copy_failed');
		}
	}

	function toggleTranslatorAddon(): void {
		translatorMode = translatorMode === 'off' ? 'on-demand' : 'off';
		saveTranslatorAddonSettings();
	}

	function addChatAliasFromDraft(): void {
		const trigger = chatAliasTriggerDraft.trim();
		const replacement = chatAliasReplacementDraft.trim();
		if (!trigger || !replacement) return;
		addChatAlias(trigger, replacement);
		chatAliasTriggerDraft = '';
		chatAliasReplacementDraft = '';
	}

	function toggleChatAliasEnabled(alias: ChatAliasEntry): void {
		updateChatAlias(alias.id, { enabled: !alias.enabled });
	}

	// Editing an alias happens in its row, not in a browser prompt.
	let editingAliasId: string | null = null;
	let editingAliasDraft = '';
	function editChatAlias(alias: ChatAliasEntry): void {
		editingAliasId = alias.id;
		editingAliasDraft = alias.replacement;
	}
	function saveChatAliasEdit(alias: ChatAliasEntry): void {
		const next = editingAliasDraft.trim();
		if (next) updateChatAlias(alias.id, { replacement: next });
		editingAliasId = null;
	}

	function toggleChatFilterEnabled(): void {
		setChatFilterSettings({ enabled: !$chatFilterStore.enabled });
	}

	function updateChatFilterMode(mode: ChatFilterMode): void {
		setChatFilterSettings({ mode });
	}

	function toggleChatFilterIncoming(): void {
		setChatFilterSettings({ applyToIncoming: !$chatFilterStore.applyToIncoming });
	}

	function toggleChatFilterOutgoing(): void {
		setChatFilterSettings({ applyToOutgoing: !$chatFilterStore.applyToOutgoing });
	}

	function updateChatFilterReplacement(value: string): void {
		setChatFilterSettings({ replacement: value });
	}

	let chatFilterTermsDraft = $chatFilterStore.terms.join(', ');
	$: chatFilterTermsSaved = $chatFilterStore.terms.join(', ');
	function saveChatFilterTerms(): void {
		const terms = chatFilterTermsDraft
			.split(',')
			.map((term) => term.trim())
			.filter(Boolean);
		setChatFilterSettings({ terms });
		chatFilterTermsDraft = terms.join(', ');
	}

	function saveQuoteTemplate(): void {
		setCustomQuoteTemplate(quoteTemplateDraft);
		quoteTemplateDraft = get(customQuoteSettingsStore).template;
	}

	function resetQuoteTemplateFromSettings(): void {
		resetCustomQuoteTemplate();
		quoteTemplateDraft = get(customQuoteSettingsStore).template;
	}
</script>

{#if localAddonControlMatches('translator_addon')}
	<AddonRow
		id="translator_addon"
		label={$_('utilities.translator_label')}
		description={$_('utilities.translator_desc')}
		enabled={translatorMode !== 'off'}
		badge={SECTION}
		onToggle={toggleTranslatorAddon}
	>
		{#snippet preferences()}
			<div class="addon-grid">
				<div class="addon-field">
					<span class="w-label">{$_('utilities.mode')}</span>
					<Select ariaLabel={$_('utilities.mode')} options={[{ value: 'off', label: $_('utilities.mode_off') }, { value: 'on-demand', label: $_('utilities.mode_on_demand') }, { value: 'auto', label: $_('utilities.mode_auto') }]} value={translatorMode} onchange={(value) => { translatorMode = value as TranslatorMode; saveTranslatorAddonSettings(); }} />
				</div>
				<div class="addon-field">
					<span class="w-label">{$_('utilities.provider')}</span>
					<Select ariaLabel={$_('utilities.provider')} options={TRANSLATOR_MODEL_OPTIONS.map((modelOption) => ({ value: String(modelOption.id), label: String(modelOption.label) }))} value={translatorModel} onchange={(value) => { translatorModel = value as TranslatorModelId; handleTranslatorModelChange(); }} />
				</div>
				{#if translatorModel === 'libretranslate-self-hosted'}
					<label class="addon-field">
						<span class="w-label">{$_('utilities.endpoint')}</span>
						<input class="w-field"
							type="url"
							bind:value={translatorProviderUrl}
							placeholder="https://translate.example.com/translate"
							on:blur={saveTranslatorAddonSettings}
						/>
					</label>
				{/if}
				<label class="addon-field">
					<span class="w-label">{$_('utilities.translate_into')}</span>
					<input class="w-field" type="text" maxlength="16" bind:value={translatorTargetLang} placeholder="en" on:blur={saveTranslatorAddonSettings} />
				</label>
				<label class="addon-field">
					<span class="w-label">{$_('utilities.understood')}</span>
					<input class="w-field" type="text" maxlength="96" bind:value={translatorUnderstoodLanguages} placeholder="en, th" on:blur={saveTranslatorAddonSettings} />
				</label>
			</div>

			{#if translatorModel === 'libretranslate-local'}
				<div class="addon-note">
					{$_('utilities.local_a')} <code>127.0.0.1:5000</code>{$_('utilities.local_b')}
				</div>
				<div class="addon-note">
					{$_('utilities.docker_setup')} <code>{LOCAL_TRANSLATOR_DOCKER_COMMAND}</code>
				</div>
				<div class="addon-actions">
					<button class="w-btn w-btn--sm" type="button" on:click={copyLocalTranslatorCommand}>{$_('utilities.copy_setup')}</button>
					<button class="w-btn w-btn--sm" type="button" on:click={checkTranslatorProvider} disabled={translatorProbeState === 'checking'}>
						{translatorProbeState === 'checking' ? $_('utilities.checking') : $_('utilities.check_translator')}
					</button>
				</div>
			{:else}
				<div class="addon-note">
					{$_('utilities.self_hosted_note')}
				</div>
				<div class="addon-actions">
					<button class="w-btn w-btn--sm" type="button" on:click={checkTranslatorProvider} disabled={translatorProbeState === 'checking'}>
						{translatorProbeState === 'checking' ? $_('utilities.checking') : $_('utilities.check_translator')}
					</button>
				</div>
			{/if}

			{#if translatorMode === 'auto'}
				<div class="addon-note">
					{$_('utilities.auto_note')}
				</div>
			{:else if translatorMode === 'off'}
				<div class="addon-note">{$_('utilities.translator_off')}</div>
			{/if}
			{#if translatorProbeMessage}
				<div class="addon-note" class:is-error={translatorProbeState === 'error'} role="status">{translatorProbeMessage}</div>
			{/if}
			{#if translatorSettingsSavedAt}
				<div class="addon-note">{$_('utilities.saved_at', { values: { time: translatorSettingsSavedAt } })}</div>
			{/if}
		{/snippet}
	</AddonRow>
{/if}

{#if localAddonControlMatches('chat_aliases')}
	<AddonRow
		id="chat_aliases"
		label={$_('utilities.chat_aliases')}
		description={$_('utilities.aliases_desc')}
		enabled={true}
		locked={true}
		badge={SECTION}
	>
		{#snippet preferences()}
			<div class="addon-actions">
				<input
					type="text"
					class="w-field"
					placeholder="/shrug"
					bind:value={chatAliasTriggerDraft}
				/>
				<input
					type="text"
					class="w-field"
					placeholder={$_('utilities.replacement_ph')}
					bind:value={chatAliasReplacementDraft}
				/>
				<button
					class="w-btn w-btn--sm"
					on:click={addChatAliasFromDraft}
					disabled={!chatAliasTriggerDraft.trim() || !chatAliasReplacementDraft.trim()}
				>
					{$_('utilities.add_alias')}
				</button>
			</div>
			{#if $chatAliasesStore.length === 0}
				<div class="addon-note">{$_('utilities.no_aliases')}</div>
			{:else}
				<div class="addon-list">
					{#each $chatAliasesStore as alias (alias.id)}
						<div class="addon-item">
							{#if editingAliasId === alias.id}
								<label class="addon-item__name" for={`addon-alias-${alias.id}`}>{alias.trigger} {$_('utilities.becomes')}</label>
								<div class="addon-actions addon-actions--field">
									<input id={`addon-alias-${alias.id}`} class="w-field" type="text" bind:value={editingAliasDraft} on:keydown={(event) => { if (event.key === 'Enter') saveChatAliasEdit(alias); if (event.key === 'Escape') { event.stopPropagation(); editingAliasId = null; } }} />
									<button class="w-btn w-btn--sm w-btn--quiet" on:click={() => (editingAliasId = null)}>Cancel</button>
									<button class="w-btn w-btn--sm" on:click={() => saveChatAliasEdit(alias)} disabled={!editingAliasDraft.trim()}>Save</button>
								</div>
							{:else}
								<span class="addon-item__name" class:is-off={!alias.enabled}><code>{alias.trigger}</code> {$_('utilities.becomes')} {alias.replacement}{#if !alias.enabled} {$_('utilities.off_marker')}{/if}</span>
								<div class="addon-actions">
									<button class="w-btn w-btn--sm w-btn--quiet" on:click={() => toggleChatAliasEnabled(alias)}>
										{alias.enabled ? $_('utilities.turn_off') : $_('utilities.turn_on')}
									</button>
									<button class="w-btn w-btn--sm w-btn--quiet" on:click={() => editChatAlias(alias)}>{$_('utilities.edit')}</button>
									<button class="w-btn w-btn--sm w-btn--danger" on:click={() => removeChatAlias(alias.id)}>{$_('utilities.delete')}</button>
								</div>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		{/snippet}
	</AddonRow>
{/if}

{#if localAddonControlMatches('chat_filter')}
	<AddonRow
		id="chat_filter"
		label={$_('utilities.chat_filter')}
		description={$_('utilities.chat_filter_desc')}
		enabled={$chatFilterStore.enabled}
		badge={SECTION}
		onToggle={toggleChatFilterEnabled}
	>
		{#snippet preferences()}
			<div class="addon-field">
				<span class="w-label">{$_('utilities.filter_mode')}</span>
				<Select ariaLabel={$_('utilities.filter_mode')} options={[{ value: 'censor', label: $_('utilities.censor') }, { value: 'hide', label: $_('utilities.hide_message') }]} value={$chatFilterStore.mode} onchange={(value) => updateChatFilterMode(value as ChatFilterMode)} disabled={!$chatFilterStore.enabled} />
			</div>
			<div class="addon-field">
				<label class="w-label" for="addon-chat-filter-terms">{$_('utilities.blocked_words_label')}</label>
				<div class="addon-actions addon-actions--field">
					<input id="addon-chat-filter-terms" class="w-field" type="text" bind:value={chatFilterTermsDraft} disabled={!$chatFilterStore.enabled} placeholder={$_('utilities.blocked_words_ph')} />
					<button class="w-btn w-btn--sm" on:click={saveChatFilterTerms} disabled={!$chatFilterStore.enabled || chatFilterTermsDraft.trim() === chatFilterTermsSaved}>{$_('utilities.save_words')}</button>
				</div>
			</div>
<div class="addon-option">
				<span class="addon-option__label" id="addon-opt-filter-in">{$_('utilities.incoming')}</span>
				<Switch labelledby="addon-opt-filter-in" checked={$chatFilterStore.applyToIncoming} disabled={!$chatFilterStore.enabled} onchange={toggleChatFilterIncoming} />
			</div>
			<div class="addon-option">
				<span class="addon-option__label" id="addon-opt-filter-out">{$_('utilities.outgoing')}</span>
				<Switch labelledby="addon-opt-filter-out" checked={$chatFilterStore.applyToOutgoing} disabled={!$chatFilterStore.enabled} onchange={toggleChatFilterOutgoing} />
			</div>
			{#if $chatFilterStore.mode === 'censor'}
				<label class="addon-field">
					<span class="w-label">{$_('utilities.replace_with')}</span>
					<input class="w-field"
						type="text"
						maxlength="24"
						value={$chatFilterStore.replacement}
						on:input={(event) => updateChatFilterReplacement(event.currentTarget.value)}
					/>
				</label>
			{/if}
			<div class="addon-note">{$chatFilterStore.terms.length === 0 ? $_('utilities.blocked_none') : $_($chatFilterStore.terms.length === 1 ? 'utilities.blocked_one' : 'utilities.blocked_many', { values: { count: $chatFilterStore.terms.length } })}</div>
		{/snippet}
	</AddonRow>
{/if}

{#if localAddonControlMatches('custom_quoter')}
	<AddonRow
		id="custom_quoter"
		label={$_('utilities.custom_quotes')}
		description="{$_('utilities.quotes_desc')}"
		enabled={true}
		locked={true}
		badge={SECTION}
	>
		{#snippet preferences()}
			<textarea
				class="w-field addon-template"
				rows="3"
				bind:value={quoteTemplateDraft}
				placeholder={'> {text}\\n- {user} ({timestamp})'}
			></textarea>
			<div class="addon-note">{$_('utilities.placeholders')} <code>{'{user}'}</code> <code>{'{text}'}</code> <code>{'{timestamp}'}</code> <code>{'{channel}'}</code> <code>{'{message_id}'}</code></div>
			<div class="addon-actions">
				<button class="w-btn w-btn--sm" on:click={saveQuoteTemplate}>{$_('utilities.save_template')}</button>
				<button class="w-btn w-btn--sm" on:click={resetQuoteTemplateFromSettings}>{$_('utilities.use_default')}</button>
			</div>
		{/snippet}
	</AddonRow>
{/if}
