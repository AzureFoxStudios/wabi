<script lang="ts">
	import { get } from 'svelte/store';
	import { emojis } from '$lib/socket';
	import { chatAliasesStore, chatFilterStore, customQuoteSettingsStore, addChatAlias, removeChatAlias, resetCustomQuoteTemplate, setChatFilterSettings, setCustomQuoteTemplate, updateChatAlias, type ChatAliasEntry, type ChatFilterMode } from '$lib/chatEnhancements';
	import { ADDON_SECTION_LABELS } from '../addonSettingsRegistry';
	import type { AddonSectionId } from '../addonSettingsRegistry';

	export let localAddonControlMatches: (controlId: string) => boolean;
	export let isAddonSectionOpen: (section: AddonSectionId) => boolean;
	export let toggleAddonSection: (section: AddonSectionId) => void;
	export let addonSectionMatchCount: (section: AddonSectionId) => number;
	export let translatorAddonDetected: boolean;

	const TRANSLATOR_SETTINGS_KEY = 'addon.translator_assist.settings';
	type TranslatorModelId = 'libretranslate-local' | 'libretranslate-public';
	const TRANSLATOR_MODEL_OPTIONS: Array<{ id: TranslatorModelId; label: string; providerUrl: string }> = [
		{ id: 'libretranslate-local', label: 'LibreTranslate (Local)', providerUrl: 'http://127.0.0.1:5000/translate' },
		{ id: 'libretranslate-public', label: 'LibreTranslate (Public)', providerUrl: 'https://libretranslate.com/translate' }
	];

	let translatorModel: TranslatorModelId = 'libretranslate-local';
	let translatorTargetLang = 'en';
	let translatorSettingsSavedAt = '';
	let chatAliasTriggerDraft = '';
	let chatAliasReplacementDraft = '';
	let quoteTemplateDraft = '';

	function loadTranslatorAddonSettings(): void {
		try {
			const raw = localStorage.getItem(TRANSLATOR_SETTINGS_KEY);
			if (!raw) return;
			const parsed = JSON.parse(raw);
			const parsedModel = typeof parsed?.model === 'string' ? parsed.model : '';
			if (parsedModel === 'libretranslate-local' || parsedModel === 'libretranslate-public') {
				translatorModel = parsedModel;
			} else {
				const providerUrl = typeof parsed?.providerUrl === 'string' ? parsed.providerUrl.trim() : '';
				if (providerUrl === 'https://libretranslate.com/translate') {
					translatorModel = 'libretranslate-public';
				} else {
					translatorModel = 'libretranslate-local';
				}
			}
			translatorTargetLang = typeof parsed?.targetLang === 'string' ? parsed.targetLang : 'en';
		} catch {
			// Ignore malformed local settings
		}
	}
	loadTranslatorAddonSettings();

	function saveTranslatorAddonSettings(): void {
		const selectedModel = TRANSLATOR_MODEL_OPTIONS.find((option) => option.id === translatorModel) || TRANSLATOR_MODEL_OPTIONS[0];
		const payload = {
			mode: 'on-demand',
			model: selectedModel.id,
			providerUrl: selectedModel.providerUrl,
			sourceLang: 'auto',
			targetLang: translatorTargetLang.trim() || 'en',
			useProxy: true
		};
		localStorage.setItem(TRANSLATOR_SETTINGS_KEY, JSON.stringify(payload));
		translatorSettingsSavedAt = new Date().toLocaleTimeString();
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

{#if localAddonControlMatches('translator_addon') || localAddonControlMatches('chat_aliases') || localAddonControlMatches('chat_filter') || localAddonControlMatches('custom_quoter')}
<section class="addon-accordion-section">
	<button
		type="button"
		class="addon-accordion-trigger"
		aria-expanded={isAddonSectionOpen('utilities')}
		aria-controls="addon-section-utilities"
		on:click={() => toggleAddonSection('utilities')}
	>
		<span class="addon-accordion-trigger-main">
			<span class="addon-section-chevron" aria-hidden="true">
				<svg viewBox="0 0 24 24">
					<path d="M9 6l6 6-6 6"></path>
				</svg>
			</span>
			<span class="addon-accordion-label">{ADDON_SECTION_LABELS.utilities}</span>
		</span>
		<span class="addon-accordion-count">{addonSectionMatchCount('utilities')}</span>
	</button>
	{#if isAddonSectionOpen('utilities')}
	<div class="addon-accordion-body" id="addon-section-utilities">
		{#if localAddonControlMatches('translator_addon')}
			{#if translatorAddonDetected}
				<div class="setting-item-full">
					<div class="setting-info">
						<span class="setting-label">Translator Assist Settings</span>
						<span class="setting-description">Pick a translator model and target language. Source language is auto-detected.</span>
					</div>
					<div class="upload-limit-grid">
						<label class="upload-limit-row">
							<span>Model</span>
							<select bind:value={translatorModel} class="theme-select" on:change={saveTranslatorAddonSettings}>
								{#each TRANSLATOR_MODEL_OPTIONS as modelOption}
									<option value={modelOption.id}>{modelOption.label}</option>
								{/each}
							</select>
						</label>
						<label class="upload-limit-row">
							<span>Target language</span>
							<input type="text" maxlength="16" bind:value={translatorTargetLang} placeholder="en" on:blur={saveTranslatorAddonSettings} />
						</label>
					</div>
					<div class="runtime-note">Settings save automatically.</div>
					{#if translatorSettingsSavedAt}
						<div class="runtime-note">Saved at {translatorSettingsSavedAt}</div>
					{/if}
				</div>
			{/if}
		{/if}

		{#if localAddonControlMatches('chat_aliases')}
			<div class="setting-item-full">
				<div class="setting-info">
					<span class="setting-label">ChatAliases (MVP)</span>
					<span class="setting-description">Create slash aliases. Use <code>{'{args}'}</code> in replacement to inject trailing arguments.</span>
				</div>
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
			</div>
		{/if}

		{#if localAddonControlMatches('chat_filter')}
			<div class="setting-item-full">
				<div class="setting-info">
					<span class="setting-label">ChatFilter (MVP)</span>
					<span class="setting-description">Censor or hide messages containing blocked terms.</span>
				</div>
				<div class="settings-row-actions">
					<button class="toggle-btn" class:active={$chatFilterStore.enabled} on:click={toggleChatFilterEnabled}>
						{$chatFilterStore.enabled ? 'ON' : 'OFF'}
					</button>
					<select
						class="theme-select"
						value={$chatFilterStore.mode}
						on:change={(event) => updateChatFilterMode(event.currentTarget.value as ChatFilterMode)}
						disabled={!$chatFilterStore.enabled}
					>
						<option value="censor">Censor text</option>
						<option value="hide">Hide full message</option>
					</select>
					<button class="action-btn secondary" on:click={editChatFilterTerms}>
						Edit Terms ({$chatFilterStore.terms.length})
					</button>
				</div>
				<div class="settings-row-actions">
					<button class="toggle-btn" class:active={$chatFilterStore.applyToIncoming} on:click={toggleChatFilterIncoming}>
						Incoming {$chatFilterStore.applyToIncoming ? 'ON' : 'OFF'}
					</button>
					<button class="toggle-btn" class:active={$chatFilterStore.applyToOutgoing} on:click={toggleChatFilterOutgoing}>
						Outgoing {$chatFilterStore.applyToOutgoing ? 'ON' : 'OFF'}
					</button>
				</div>
				{#if $chatFilterStore.mode === 'censor'}
					<label class="upload-limit-row">
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
			</div>
		{/if}

		{#if localAddonControlMatches('custom_quoter')}
			<div class="setting-item-full">
				<div class="setting-info">
					<span class="setting-label">CustomQuoter (MVP)</span>
					<span class="setting-description">Template used by message action <strong>Copy Quote</strong>.</span>
				</div>
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
			</div>
		{/if}
	</div>
	{/if}
</section>
{/if}
