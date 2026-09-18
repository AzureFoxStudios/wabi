<script lang="ts">
	import {
		composerEnhancementSettingsStore, setCharCounterEnabled, setSpellCheckEnabled,
		setSplitLargeMessagesEnabled, setSplitLargeMessagesChunkSize, setWriteUpperCaseEnabled
	} from '$lib/composerEnhancements';
	import {
		displayEnhancementSettingsStore, setClickableMentionsEnabled, setMessageUtilitiesEnabled,
		setPersonalPinsEnabled, setQuickMentionEnabled, setTimestampDisplayMode,
		type TimestampDisplayMode
	} from '$lib/displayEnhancements';
	import { clearAllPersonalPins, personalPinsStore } from '$lib/personalPins';
	import {
		exportUnicodeEmojiPreferences, importUnicodeEmojiPreferences, resetUnicodeEmojiTelemetry,
		setUnicodeEmojiConversionEnabled, setUnicodeEmojiDefaultSourceEnabled,
		setUnicodeEmojiOpenmojiSourceEnabled, unicodeEmojiTelemetryStore, unicodeEmojiSettingsStore
	} from '$lib/unicodeEmojis';
	import { ADDON_SECTION_LABELS } from '../addonSettingsRegistry';
	import AddonRow from './AddonRow.svelte';

	export let localAddonControlMatches: (controlId: string) => boolean;

	const SECTION = ADDON_SECTION_LABELS.chat;

	let spellCheckEnabled = true;
	let charCounterEnabled = true;
	let splitLargeMessagesEnabled = false;
	let splitLargeMessagesChunkSize = 2000;
	let splitLargeMessagesInputMaxLength = 20000;
	let writeUpperCaseEnabled = false;
	let clickableMentionsEnabled = true;
	let timestampDisplayMode: TimestampDisplayMode = 'compact';
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

{#if localAddonControlMatches('spellcheck')}
	<AddonRow
		id="spellcheck"
		label="SpellCheck (MVP)"
		description="Use browser spellcheck in the main chat and DM composers."
		enabled={spellCheckEnabled}
		badge={SECTION}
		onToggle={toggleSpellCheckAddon}
	/>
{/if}

{#if localAddonControlMatches('char_counter')}
	<AddonRow
		id="char_counter"
		label="CharCounter (MVP)"
		description="Show live character counters in the main chat and DM composers."
		enabled={charCounterEnabled}
		badge={SECTION}
		onToggle={toggleCharCounterAddon}
	/>
{/if}

{#if localAddonControlMatches('split_large_messages')}
	<AddonRow
		id="split_large_messages"
		label="SplitLargeMessages (MVP)"
		description="Automatically split long outgoing text into multiple messages."
		enabled={splitLargeMessagesEnabled}
		badge={SECTION}
		onToggle={toggleSplitLargeMessagesAddon}
	>
		{#snippet preferences()}
			<label class="addon-pref-field">
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
			<div class="runtime-note">
				Composer max length: {splitLargeMessagesInputMaxLength} characters.
				{splitLargeMessagesEnabled
					? ` Messages are split into chunks of up to ${splitLargeMessagesChunkSize} characters.`
					: ' Long posts stay intact and switch to Reader previews after 2,000 characters.'}
			</div>
		{/snippet}
	</AddonRow>
{/if}

{#if localAddonControlMatches('write_upper_case')}
	<AddonRow
		id="write_upper_case"
		label="WriteUpperCase"
		description="Auto-capitalize sentence starts for outgoing text (main chat, DM, and GIF captions)."
		enabled={writeUpperCaseEnabled}
		badge={SECTION}
		onToggle={toggleWriteUpperCaseAddon}
	/>
{/if}

{#if localAddonControlMatches('clickable_mentions')}
	<AddonRow
		id="clickable_mentions"
		label="ClickableMentions"
		description="Open user popouts by clicking usernames and @mentions in message content."
		enabled={clickableMentionsEnabled}
		badge={SECTION}
		onToggle={toggleClickableMentionsAddon}
	/>
{/if}

{#if localAddonControlMatches('complete_timestamps')}
	<AddonRow
		id="complete_timestamps"
		label="CompleteTimestamps"
		description="Choose the timestamp detail level shown in message rows."
		enabled={timestampDisplayMode !== 'compact'}
		badge={SECTION}
		onToggle={() => updateTimestampDisplayMode(timestampDisplayMode === 'compact' ? 'complete' : 'compact')}
	>
		{#snippet preferences()}
			<label class="addon-pref-field">
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
		{/snippet}
	</AddonRow>
{/if}

{#if localAddonControlMatches('message_utilities')}
	<AddonRow
		id="message_utilities"
		label="MessageUtilities"
		description="Show extra quick message tools in hover actions (quick mention, pin, edit)."
		enabled={messageUtilitiesEnabled}
		badge={SECTION}
		onToggle={toggleMessageUtilitiesAddon}
	/>
{/if}

{#if localAddonControlMatches('quick_mention')}
	<AddonRow
		id="quick_mention"
		label="QuickMention"
		description="Adds a fast mention action in message context/utility actions."
		enabled={quickMentionEnabled}
		badge={SECTION}
		onToggle={toggleQuickMentionAddon}
	/>
{/if}

{#if localAddonControlMatches('personal_pins')}
	<AddonRow
		id="personal_pins"
		label="PersonalPins"
		description="Pin messages locally on this device without affecting shared channel pins."
		enabled={personalPinsEnabled}
		badge={SECTION}
		onToggle={togglePersonalPinsAddon}
	>
		{#snippet preferences()}
			<div class="runtime-note">Local personal pins: {personalPinCount}</div>
			<div class="settings-row-actions">
				<button
					class="action-btn secondary"
					on:click={clearPersonalPinsAddon}
					disabled={personalPinCount === 0}
				>
					Clear Local Pins
				</button>
			</div>
		{/snippet}
	</AddonRow>
{/if}

{#if localAddonControlMatches('unicode_emojis')}
	<AddonRow
		id="unicode_emojis"
		label="UnicodeEmojis"
		description="Convert outgoing default/OpenMoji shortcodes (for example :smile:) into native Unicode emoji. Custom emoji shortcodes stay unchanged."
		enabled={unicodeEmojisEnabled}
		badge={SECTION}
		onToggle={toggleUnicodeEmojisAddon}
	>
		{#snippet preferences()}
			<label class="addon-pref-check">
				<input
					type="checkbox"
					checked={unicodeConvertDefaultEnabled}
					on:change={toggleUnicodeDefaultSource}
				/>
				<span>Convert default emoji shortcodes</span>
			</label>
			<label class="addon-pref-check">
				<input
					type="checkbox"
					checked={unicodeConvertOpenmojiEnabled}
					on:change={toggleUnicodeOpenmojiSource}
				/>
				<span>Convert OpenMoji shortcodes</span>
			</label>
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
						disabled={$unicodeEmojiTelemetryStore.convertedTokens +
							$unicodeEmojiTelemetryStore.unknownTokens +
							$unicodeEmojiTelemetryStore.shortcodeCollisions === 0}
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
		{/snippet}
	</AddonRow>
{/if}
