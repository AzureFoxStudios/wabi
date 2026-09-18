<script lang="ts">
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

	export let localAddonControlMatches: (controlId: string) => boolean;
	// Kept for call-site compatibility. Translator Assist is a bundled client addon,
	// so discoverability no longer depends on an archived/runtime backend package.
	export let translatorAddonDetected: boolean;

	const SECTION = ADDON_SECTION_LABELS.utilities;

	const TRANSLATOR_MODEL_OPTIONS: Array<{ id: TranslatorModelId; label: string }> = [
		{ id: 'libretranslate-local', label: 'LibreTranslate on this device' },
		{ id: 'libretranslate-self-hosted', label: 'Self-hosted LibreTranslate' }
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
		translatorProbeMessage = 'Checking translator…';
		const result = await probeTranslatorProvider(getTranslatorSettings());
		translatorProbeState = result.ok ? 'ok' : 'error';
		translatorProbeMessage = result.message;
	}

	async function copyLocalTranslatorCommand(): Promise<void> {
		try {
			await navigator.clipboard.writeText(LOCAL_TRANSLATOR_DOCKER_COMMAND);
			translatorProbeState = 'ok';
			translatorProbeMessage = 'Local translator command copied.';
		} catch {
			window.prompt('Copy this command:', LOCAL_TRANSLATOR_DOCKER_COMMAND);
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

	function editChatAlias(alias: ChatAliasEntry): void {
		const nextReplacement = window.prompt(`Edit replacement for ${alias.trigger}`, alias.replacement);
		if (nextReplacement === null) return;
		if (!nextReplacement.trim()) return;
		updateChatAlias(alias.id, { replacement: nextReplacement.trim() });
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

	function editChatFilterTerms(): void {
		const current = $chatFilterStore.terms.join(', ');
		const raw = window.prompt('Blocked terms (comma-separated)', current);
		if (raw === null) return;
		const terms = raw
			.split(',')
			.map((term) => term.trim())
			.filter(Boolean);
		setChatFilterSettings({ terms });
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
		label="Translator Assist"
		description="Optional, local-first message translation. Wabi does not proxy message text through the server."
		enabled={translatorMode !== 'off'}
		badge={SECTION}
		onToggle={toggleTranslatorAddon}
	>
		{#snippet preferences()}
			<div class="upload-limit-grid">
				<label class="upload-limit-row">
					<span>Mode</span>
					<select bind:value={translatorMode} class="theme-select" on:change={saveTranslatorAddonSettings}>
						<option value="off">Off</option>
						<option value="on-demand">Translate when asked</option>
						<option value="auto">Automatic — translate languages I don't understand</option>
					</select>
				</label>
				<label class="upload-limit-row">
					<span>Provider</span>
					<select bind:value={translatorModel} class="theme-select" on:change={handleTranslatorModelChange}>
						{#each TRANSLATOR_MODEL_OPTIONS as modelOption}
							<option value={modelOption.id}>{modelOption.label}</option>
						{/each}
					</select>
				</label>
				{#if translatorModel === 'libretranslate-self-hosted'}
					<label class="upload-limit-row">
						<span>Translator endpoint</span>
						<input
							type="url"
							bind:value={translatorProviderUrl}
							placeholder="https://translate.example.com/translate"
							on:blur={saveTranslatorAddonSettings}
						/>
					</label>
				{/if}
				<label class="upload-limit-row">
					<span>Translate into</span>
					<input type="text" maxlength="16" bind:value={translatorTargetLang} placeholder="en" on:blur={saveTranslatorAddonSettings} />
				</label>
				<label class="upload-limit-row">
					<span>Languages I understand</span>
					<input type="text" maxlength="96" bind:value={translatorUnderstoodLanguages} placeholder="en, th" on:blur={saveTranslatorAddonSettings} />
				</label>
			</div>

			{#if translatorModel === 'libretranslate-local'}
				<div class="runtime-note">
					Local mode connects only to <code>127.0.0.1:5000</code>. Wabi does not bundle the translation service or its language models.
				</div>
				<div class="runtime-note">
					One-command Docker setup: <code>{LOCAL_TRANSLATOR_DOCKER_COMMAND}</code>
				</div>
				<div class="settings-row-actions">
					<button class="action-btn secondary" type="button" on:click={copyLocalTranslatorCommand}>Copy setup command</button>
					<button class="action-btn secondary" type="button" on:click={checkTranslatorProvider} disabled={translatorProbeState === 'checking'}>
						{translatorProbeState === 'checking' ? 'Checking…' : 'Check translator'}
					</button>
				</div>
			{:else}
				<div class="runtime-note">
					Self-hosted mode connects directly from your client to an HTTPS LibreTranslate endpoint you chose. The Wabi Authority never relays the message text.
				</div>
				<div class="settings-row-actions">
					<button class="action-btn secondary" type="button" on:click={checkTranslatorProvider} disabled={translatorProbeState === 'checking'}>
						{translatorProbeState === 'checking' ? 'Checking…' : 'Check translator'}
					</button>
				</div>
			{/if}

			{#if translatorMode === 'auto'}
				<div class="runtime-note">
					Automatic mode considers incoming text only when it enters or approaches your viewport. It skips your own messages, commands, code-only/URL-only posts, and languages listed above. A remote self-hosted provider receives the visible message text needed for detection and translation.
				</div>
			{:else if translatorMode === 'off'}
				<div class="runtime-note">Translator Assist is off. Translation controls stay out of chat and no translation requests are made.</div>
			{/if}
			{#if translatorProbeMessage}
				<div class="runtime-note" role="status">
					{translatorProbeState === 'ok' ? '✓' : translatorProbeState === 'error' ? '!' : ''} {translatorProbeMessage}
				</div>
			{/if}
			{#if translatorSettingsSavedAt}
				<div class="runtime-note">Saved at {translatorSettingsSavedAt}</div>
			{/if}
		{/snippet}
	</AddonRow>
{/if}

{#if localAddonControlMatches('chat_aliases')}
	<AddonRow
		id="chat_aliases"
		label="ChatAliases (MVP)"
		description={'Create slash aliases. Use {args} in replacement to inject trailing arguments.'}
		enabled={true}
		locked={true}
		badge={SECTION}
	>
		{#snippet preferences()}
			<div class="settings-row-actions">
				<input
					type="text"
					class="theme-select alias-input"
					placeholder="/shrug"
					bind:value={chatAliasTriggerDraft}
				/>
				<input
					type="text"
					class="theme-select alias-input"
					placeholder="Replacement text or /command"
					bind:value={chatAliasReplacementDraft}
				/>
				<button
					class="action-btn"
					on:click={addChatAliasFromDraft}
					disabled={!chatAliasTriggerDraft.trim() || !chatAliasReplacementDraft.trim()}
				>
					Add Alias
				</button>
			</div>
			{#if $chatAliasesStore.length === 0}
				<div class="runtime-note">No aliases configured yet.</div>
			{:else}
				<div class="addons-list">
					{#each $chatAliasesStore as alias (alias.id)}
						<div class="addon-row">
							<div class="addon-name">{alias.trigger} -> {alias.replacement}</div>
							<div class="settings-row-actions">
								<button class="action-btn secondary" on:click={() => toggleChatAliasEnabled(alias)}>
									{alias.enabled ? 'Disable' : 'Enable'}
								</button>
								<button class="action-btn secondary" on:click={() => editChatAlias(alias)}>Edit</button>
								<button class="action-btn danger" on:click={() => removeChatAlias(alias.id)}>Delete</button>
							</div>
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
		label="ChatFilter (MVP)"
		description="Censor or hide messages containing blocked terms."
		enabled={$chatFilterStore.enabled}
		badge={SECTION}
		onToggle={toggleChatFilterEnabled}
	>
		{#snippet preferences()}
			<label class="addon-pref-field">
				<span>Filter mode</span>
				<select
					class="theme-select"
					value={$chatFilterStore.mode}
					on:change={(event) => updateChatFilterMode(event.currentTarget.value as ChatFilterMode)}
					disabled={!$chatFilterStore.enabled}
				>
					<option value="censor">Censor text</option>
					<option value="hide">Hide full message</option>
				</select>
			</label>
			<div class="settings-row-actions">
				<button class="action-btn secondary" on:click={editChatFilterTerms}>
					Edit Terms ({$chatFilterStore.terms.length})
				</button>
			</div>
			<label class="addon-pref-check">
				<input
					type="checkbox"
					checked={$chatFilterStore.applyToIncoming}
					on:change={toggleChatFilterIncoming}
					disabled={!$chatFilterStore.enabled}
				/>
				<span>Apply to incoming messages</span>
			</label>
			<label class="addon-pref-check">
				<input
					type="checkbox"
					checked={$chatFilterStore.applyToOutgoing}
					on:change={toggleChatFilterOutgoing}
					disabled={!$chatFilterStore.enabled}
				/>
				<span>Apply to outgoing messages</span>
			</label>
			{#if $chatFilterStore.mode === 'censor'}
				<label class="addon-pref-field">
					<span>Replacement token</span>
					<input
						type="text"
						maxlength="24"
						value={$chatFilterStore.replacement}
						on:input={(event) => updateChatFilterReplacement(event.currentTarget.value)}
					/>
				</label>
			{/if}
			<div class="runtime-note">
				Current blocked terms: {$chatFilterStore.terms.length > 0 ? $chatFilterStore.terms.join(', ') : '(none)'}
			</div>
		{/snippet}
	</AddonRow>
{/if}

{#if localAddonControlMatches('custom_quoter')}
	<AddonRow
		id="custom_quoter"
		label="CustomQuoter (MVP)"
		description="Template used by message action Copy Quote."
		enabled={true}
		locked={true}
		badge={SECTION}
	>
		{#snippet preferences()}
			<textarea
				class="addon-template-input"
				rows="3"
				bind:value={quoteTemplateDraft}
				placeholder={'> {text}\\n- {user} ({timestamp})'}
			></textarea>
			<div class="runtime-note">Placeholders: <code>{'{user}'}</code> <code>{'{text}'}</code> <code>{'{timestamp}'}</code> <code>{'{channel}'}</code> <code>{'{message_id}'}</code></div>
			<div class="settings-row-actions">
				<button class="action-btn" on:click={saveQuoteTemplate}>Save Template</button>
				<button class="action-btn secondary" on:click={resetQuoteTemplateFromSettings}>Reset Default</button>
			</div>
		{/snippet}
	</AddonRow>
{/if}
