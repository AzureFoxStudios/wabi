<script lang="ts">
	import { get } from 'svelte/store';
	import { emojis } from '$lib/socket';
	import type { Emoji } from '$lib/socket';
	import {
		composerEnhancementSettingsStore, setCharCounterEnabled, setSpellCheckEnabled,
		setSplitLargeMessagesEnabled, setSplitLargeMessagesChunkSize, setWriteUpperCaseEnabled
	} from '$lib/composerEnhancements';
	import {
		displayEnhancementSettingsStore, setClickableMentionsEnabled, setMessageUtilitiesEnabled,
		setPersonalPinsEnabled, setQuickMentionEnabled, setRevealAllSpoilersEnabled,
		setRevealAllSpoilersMinRole, setTimestampDisplayMode,
		type RevealAllSpoilersMinRole, type TimestampDisplayMode
	} from '$lib/displayEnhancements';
	import { clearAllPersonalPins, personalPinsStore } from '$lib/personalPins';
	import {
		exportUnicodeEmojiPreferences, importUnicodeEmojiPreferences, resetUnicodeEmojiTelemetry,
		setUnicodeEmojiConversionEnabled, setUnicodeEmojiDefaultSourceEnabled,
		setUnicodeEmojiOpenmojiSourceEnabled, unicodeEmojiTelemetryStore, unicodeEmojiSettingsStore
	} from '$lib/unicodeEmojis';
	import type { AddonSectionId } from '../addonSettingsRegistry';
	import { ADDON_SECTION_LABELS } from '../addonSettingsRegistry';

	export let localAddonControlMatches: (controlId: string) => boolean;
	export let isAddonSectionOpen: (section: AddonSectionId) => boolean;
	export let toggleAddonSection: (section: AddonSectionId) => void;
	export let addonSectionMatchCount: (section: AddonSectionId) => number;

	let spellCheckEnabled = true;
	let charCounterEnabled = true;
	let splitLargeMessagesEnabled = false;
	let splitLargeMessagesChunkSize = 2000;
	let splitLargeMessagesInputMaxLength = 20000;
	let writeUpperCaseEnabled = false;
	let clickableMentionsEnabled = true;
	let timestampDisplayMode: TimestampDisplayMode = 'compact';
	let revealAllSpoilersEnabled = true;
	let revealAllSpoilersMinRole: RevealAllSpoilersMinRole = 'member';
	let messageUtilitiesEnabled = true;
	let quickMentionEnabled = true;
	let personalPinsEnabled = true;
	let unicodeEmojisEnabled = false;
	let unicodeConvertDefaultEnabled = true;
	let unicodeConvertOpenmojiEnabled = true;
	let unicodeEmojisPrefsStatus = '';
	let personalPinCount = 0;

	$: spellCheckEnabled = $composerEnhancementSettingsStore.spellcheckEnabled;
	$: charCounterEnabled = $composerEnhancementSettingsStore.charCounterEnabled;
	$: splitLargeMessagesEnabled = $composerEnhancementSettingsStore.splitLargeMessagesEnabled;
	$: splitLargeMessagesChunkSize = $composerEnhancementSettingsStore.splitLargeMessagesChunkSize;
	$: splitLargeMessagesInputMaxLength = $composerEnhancementSettingsStore.splitLargeMessagesInputMaxLength;
	$: writeUpperCaseEnabled = $composerEnhancementSettingsStore.writeUpperCaseEnabled;
	$: clickableMentionsEnabled = $displayEnhancementSettingsStore.clickableMentionsEnabled;
	$: timestampDisplayMode = $displayEnhancementSettingsStore.timestampDisplayMode;
	$: revealAllSpoilersEnabled = $displayEnhancementSettingsStore.revealAllSpoilersEnabled;
	$: revealAllSpoilersMinRole = $displayEnhancementSettingsStore.revealAllSpoilersMinRole;
	$: messageUtilitiesEnabled = $displayEnhancementSettingsStore.messageUtilitiesEnabled;
	$: quickMentionEnabled = $displayEnhancementSettingsStore.quickMentionEnabled;
	$: personalPinsEnabled = $displayEnhancementSettingsStore.personalPinsEnabled;
	$: personalPinCount = Object.values($personalPinsStore).reduce(
		(total, ids) => total + (Array.isArray(ids) ? ids.length : 0),
		0
	);
	$: unicodeEmojisEnabled = $unicodeEmojiSettingsStore.enabled;
	$: unicodeConvertDefaultEnabled = $unicodeEmojiSettingsStore.convertDefault;
	$: unicodeConvertOpenmojiEnabled = $unicodeEmojiSettingsStore.convertOpenmoji;

	function toggleSpellCheckAddon(): void {
		setSpellCheckEnabled(!spellCheckEnabled);
	}

	function toggleCharCounterAddon(): void {
		setCharCounterEnabled(!charCounterEnabled);
	}

	function toggleSplitLargeMessagesAddon(): void {
		setSplitLargeMessagesEnabled(!splitLargeMessagesEnabled);
	}

	function updateSplitLargeMessagesChunkSize(rawValue: string): void {
		const parsed = Number.parseInt(rawValue, 10);
		if (!Number.isFinite(parsed)) return;
		setSplitLargeMessagesChunkSize(parsed);
	}

	function toggleWriteUpperCaseAddon(): void {
		setWriteUpperCaseEnabled(!writeUpperCaseEnabled);
	}

	function toggleClickableMentionsAddon(): void {
		setClickableMentionsEnabled(!clickableMentionsEnabled);
	}

	function updateTimestampDisplayMode(mode: string): void {
		if (mode === 'compact' || mode === 'complete' || mode === 'detailed') {
			setTimestampDisplayMode(mode as TimestampDisplayMode);
		}
	}

	function toggleRevealAllSpoilersAddon(): void {
		setRevealAllSpoilersEnabled(!revealAllSpoilersEnabled);
	}

	function updateRevealAllSpoilersRole(role: string): void {
		if (role === 'guest' || role === 'member' || role === 'mod' || role === 'admin' || role === 'owner') {
			setRevealAllSpoilersMinRole(role as RevealAllSpoilersMinRole);
		}
	}

	function toggleMessageUtilitiesAddon(): void {
		setMessageUtilitiesEnabled(!messageUtilitiesEnabled);
	}

	function toggleQuickMentionAddon(): void {
		setQuickMentionEnabled(!quickMentionEnabled);
	}

	function togglePersonalPinsAddon(): void {
		setPersonalPinsEnabled(!personalPinsEnabled);
	}

	function clearPersonalPinsAddon(): void {
		if (!window.confirm('Clear all local personal pins?')) return;
		clearAllPersonalPins();
	}

	function toggleUnicodeEmojisAddon(): void {
		setUnicodeEmojiConversionEnabled(!unicodeEmojisEnabled);
		unicodeEmojisPrefsStatus = '';
	}

	function toggleUnicodeDefaultSource(): void {
		setUnicodeEmojiDefaultSourceEnabled(!unicodeConvertDefaultEnabled);
		unicodeEmojisPrefsStatus = '';
	}

	function toggleUnicodeOpenmojiSource(): void {
		setUnicodeEmojiOpenmojiSourceEnabled(!unicodeConvertOpenmojiEnabled);
		unicodeEmojisPrefsStatus = '';
	}

	function resetUnicodeEmojisTelemetry(): void {
		const telemetryTotal =
			$unicodeEmojiTelemetryStore.convertedTokens +
			$unicodeEmojiTelemetryStore.unknownTokens +
			$unicodeEmojiTelemetryStore.shortcodeCollisions;
		if (telemetryTotal === 0) return;
		const confirmed = window.confirm('Reset UnicodeEmojis conversion counters?');
		if (!confirmed) return;
		resetUnicodeEmojiTelemetry();
	}

	async function exportUnicodeEmojisPrefs(): Promise<void> {
		try {
			const payload = exportUnicodeEmojiPreferences(false);
			if (navigator?.clipboard?.writeText) {
				await navigator.clipboard.writeText(payload);
				unicodeEmojisPrefsStatus = 'UnicodeEmojis preferences copied to clipboard.';
				return;
			}
			window.prompt('Copy UnicodeEmojis preferences JSON:', payload);
			unicodeEmojisPrefsStatus = 'UnicodeEmojis preferences ready to copy.';
		} catch (error) {
			unicodeEmojisPrefsStatus =
				error instanceof Error ? error.message : 'Failed to export UnicodeEmojis preferences.';
		}
	}

	function importUnicodeEmojisPrefs(): void {
		const raw = window.prompt('Paste UnicodeEmojis preferences JSON:');
		if (!raw || !raw.trim()) return;
		try {
			const result = importUnicodeEmojiPreferences(raw);
			unicodeEmojisPrefsStatus = result.telemetryImported
				? 'UnicodeEmojis settings and local counters imported.'
				: 'UnicodeEmojis settings imported.';
		} catch (error) {
			unicodeEmojisPrefsStatus =
				error instanceof Error ? error.message : 'Invalid UnicodeEmojis preferences JSON.';
		}
	}
</script>

{#if localAddonControlMatches('spellcheck') || localAddonControlMatches('char_counter') || localAddonControlMatches('split_large_messages') || localAddonControlMatches('write_upper_case') || localAddonControlMatches('clickable_mentions') || localAddonControlMatches('complete_timestamps') || localAddonControlMatches('message_utilities') || localAddonControlMatches('quick_mention') || localAddonControlMatches('personal_pins') || localAddonControlMatches('unicode_emojis')}
<section class="addon-accordion-section">
	<button
		type="button"
		class="addon-accordion-trigger"
		aria-expanded={isAddonSectionOpen('chat')}
		aria-controls="addon-section-chat"
		on:click={() => toggleAddonSection('chat')}
	>
		<span class="addon-accordion-trigger-main">
			<span class="addon-section-chevron" aria-hidden="true">
				<svg viewBox="0 0 24 24">
					<path d="M9 6l6 6-6 6"></path>
				</svg>
			</span>
			<span class="addon-accordion-label">{ADDON_SECTION_LABELS.chat}</span>
		</span>
		<span class="addon-accordion-count">{addonSectionMatchCount('chat')}</span>
	</button>
	{#if isAddonSectionOpen('chat')}
	<div class="addon-accordion-body" id="addon-section-chat">
		{#if localAddonControlMatches('spellcheck')}
			<div class="setting-item-full">
				<div class="setting-info">
					<span class="setting-label">SpellCheck (MVP)</span>
					<span class="setting-description">Use browser spellcheck in the main chat and DM composers.</span>
				</div>
				<div class="settings-row-actions">
					<button class="toggle-btn" class:active={spellCheckEnabled} on:click={toggleSpellCheckAddon}>
						{spellCheckEnabled ? 'ON' : 'OFF'}
					</button>
				</div>
			</div>
		{/if}

		{#if localAddonControlMatches('char_counter')}
			<div class="setting-item-full">
				<div class="setting-info">
					<span class="setting-label">CharCounter (MVP)</span>
					<span class="setting-description">Show live character counters in the main chat and DM composers.</span>
				</div>
				<div class="settings-row-actions">
					<button class="toggle-btn" class:active={charCounterEnabled} on:click={toggleCharCounterAddon}>
						{charCounterEnabled ? 'ON' : 'OFF'}
					</button>
				</div>
			</div>
		{/if}

		{#if localAddonControlMatches('split_large_messages')}
			<div class="setting-item-full">
				<div class="setting-info">
					<span class="setting-label">SplitLargeMessages (MVP)</span>
					<span class="setting-description">Automatically split long outgoing text into multiple messages.</span>
				</div>
				<div class="settings-row-actions">
					<button class="toggle-btn" class:active={splitLargeMessagesEnabled} on:click={toggleSplitLargeMessagesAddon}>
						{splitLargeMessagesEnabled ? 'ON' : 'OFF'}
					</button>
					<label class="upload-limit-row split-chunk-size-row">
						<span>Chunk size</span>
						<input
							type="number"
							min="250"
							max="4000"
							step="50"
							value={splitLargeMessagesChunkSize}
							on:change={(event) => updateSplitLargeMessagesChunkSize(event.currentTarget.value)}
							disabled={!splitLargeMessagesEnabled}
						/>
					</label>
				</div>
				<div class="runtime-note">
					Composer max length: {splitLargeMessagesEnabled ? splitLargeMessagesInputMaxLength : splitLargeMessagesChunkSize} characters.
				</div>
			</div>
		{/if}

		{#if localAddonControlMatches('write_upper_case')}
			<div class="setting-item-full">
				<div class="setting-info">
					<span class="setting-label">WriteUpperCase</span>
					<span class="setting-description">Auto-capitalize sentence starts for outgoing text (main chat, DM, and GIF captions).</span>
				</div>
				<div class="settings-row-actions">
					<button class="toggle-btn" class:active={writeUpperCaseEnabled} on:click={toggleWriteUpperCaseAddon}>
						{writeUpperCaseEnabled ? 'ON' : 'OFF'}
					</button>
				</div>
			</div>
		{/if}

		{#if localAddonControlMatches('clickable_mentions')}
			<div class="setting-item-full">
				<div class="setting-info">
					<span class="setting-label">ClickableMentions</span>
					<span class="setting-description">Open user popouts by clicking usernames and @mentions in message content.</span>
				</div>
				<div class="settings-row-actions">
					<button class="toggle-btn" class:active={clickableMentionsEnabled} on:click={toggleClickableMentionsAddon}>
						{clickableMentionsEnabled ? 'ON' : 'OFF'}
					</button>
				</div>
			</div>
		{/if}

		{#if localAddonControlMatches('complete_timestamps')}
			<div class="setting-item-full">
				<div class="setting-info">
					<span class="setting-label">CompleteTimestamps</span>
					<span class="setting-description">Choose the timestamp detail level shown in message rows.</span>
				</div>
				<label class="upload-limit-row">
					<span>Timestamp mode</span>
					<select
						class="theme-select"
						value={timestampDisplayMode}
						on:change={(event) => updateTimestampDisplayMode(event.currentTarget.value)}
					>
						<option value="compact">Compact (time only)</option>
						<option value="complete">Complete (date + time)</option>
						<option value="detailed">Detailed (full locale)</option>
					</select>
				</label>
			</div>
		{/if}

		{#if localAddonControlMatches('message_utilities')}
			<div class="setting-item-full">
				<div class="setting-info">
					<span class="setting-label">MessageUtilities</span>
					<span class="setting-description">Show extra quick message tools in hover actions (quick mention, pin, edit).</span>
				</div>
				<div class="settings-row-actions">
					<button class="toggle-btn" class:active={messageUtilitiesEnabled} on:click={toggleMessageUtilitiesAddon}>
						{messageUtilitiesEnabled ? 'ON' : 'OFF'}
					</button>
				</div>
			</div>
		{/if}

		{#if localAddonControlMatches('quick_mention')}
			<div class="setting-item-full">
				<div class="setting-info">
					<span class="setting-label">QuickMention</span>
					<span class="setting-description">Adds a fast mention action in message context/utility actions.</span>
				</div>
				<div class="settings-row-actions">
					<button class="toggle-btn" class:active={quickMentionEnabled} on:click={toggleQuickMentionAddon}>
						{quickMentionEnabled ? 'ON' : 'OFF'}
					</button>
				</div>
			</div>
		{/if}

		{#if localAddonControlMatches('personal_pins')}
			<div class="setting-item-full">
				<div class="setting-info">
					<span class="setting-label">PersonalPins</span>
					<span class="setting-description">Pin messages locally on this device without affecting shared channel pins.</span>
				</div>
				<div class="runtime-note">Local personal pins: {personalPinCount}</div>
				<div class="settings-row-actions">
					<button class="toggle-btn" class:active={personalPinsEnabled} on:click={togglePersonalPinsAddon}>
						{personalPinsEnabled ? 'ON' : 'OFF'}
					</button>
					<button class="action-btn secondary" on:click={clearPersonalPinsAddon} disabled={personalPinCount === 0}>
						Clear Local Pins
					</button>
				</div>
			</div>
		{/if}

		{#if localAddonControlMatches('unicode_emojis')}
			<div class="setting-item-full">
				<div class="setting-info">
					<span class="setting-label">UnicodeEmojis</span>
					<span class="setting-description">Convert outgoing default/OpenMoji shortcodes (for example <code>:smile:</code>) into native Unicode emoji. Custom emoji shortcodes stay unchanged.</span>
				</div>
				<div class="settings-row-actions">
					<button class="toggle-btn" class:active={unicodeEmojisEnabled} on:click={toggleUnicodeEmojisAddon}>
						{unicodeEmojisEnabled ? 'ON' : 'OFF'}
					</button>
				</div>
				{#if unicodeEmojisEnabled}
					<div class="settings-row-actions">
						<button class="toggle-btn" class:active={unicodeConvertDefaultEnabled} on:click={toggleUnicodeDefaultSource}>
							Default source: {unicodeConvertDefaultEnabled ? 'ON' : 'OFF'}
						</button>
						<button class="toggle-btn" class:active={unicodeConvertOpenmojiEnabled} on:click={toggleUnicodeOpenmojiSource}>
							OpenMoji source: {unicodeConvertOpenmojiEnabled ? 'ON' : 'OFF'}
						</button>
					</div>
				{/if}
				<div class="runtime-note">Applies to main chat, DM sends, and GIF captions.</div>
				{#if unicodeEmojisEnabled}
					<div class="runtime-note">
						Local counters (device-only):
						converted {$unicodeEmojiTelemetryStore.convertedTokens},
						unknown {$unicodeEmojiTelemetryStore.unknownTokens},
						shortcode collisions {$unicodeEmojiTelemetryStore.shortcodeCollisions}.
					</div>
					<div class="settings-row-actions">
						<button
							class="action-btn secondary"
							on:click={resetUnicodeEmojisTelemetry}
							disabled={
								$unicodeEmojiTelemetryStore.convertedTokens +
								$unicodeEmojiTelemetryStore.unknownTokens +
								$unicodeEmojiTelemetryStore.shortcodeCollisions === 0
							}
						>
							Reset Unicode Counters
						</button>
						<button class="action-btn secondary" on:click={() => void exportUnicodeEmojisPrefs()}>
							Export Unicode Prefs
						</button>
						<button class="action-btn secondary" on:click={importUnicodeEmojisPrefs}>
							Import Unicode Prefs
						</button>
					</div>
					{#if unicodeEmojisPrefsStatus}
						<div class="runtime-note">{unicodeEmojisPrefsStatus}</div>
					{/if}
				{/if}
			</div>
		{/if}
	</div>
	{/if}
</section>
{/if}
