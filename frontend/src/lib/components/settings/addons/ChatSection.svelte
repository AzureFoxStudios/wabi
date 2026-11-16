<script lang="ts">
	import { _ } from '$lib/i18n';
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
		setUnicodeEmojiConversionEnabled, setUnicodeEmojiDefaultSourceEnabled,
		setUnicodeEmojiOpenmojiSourceEnabled, unicodeEmojiSettingsStore
	} from '$lib/unicodeEmojis';
	import { ADDON_SECTION_LABELS } from '../addonSettingsRegistry';
	import { confirmAction } from '$lib/confirm';
	import AddonRow from './AddonRow.svelte';
	import Switch from '../../ui/Switch.svelte';
	import Select from '../../ui/Select.svelte';

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

	async function clearPersonalPinsAddon(): Promise<void> {
		const confirmed = await confirmAction({
			title: $_('addon_chat.clear_pins_title'),
			body: $_('addon_chat.clear_pins_body', { values: { count: personalPinCount } }),
			confirm: $_('addon_chat.clear_pins_confirm'),
			danger: true
		});
		if (confirmed) clearAllPersonalPins();
	}

	function toggleUnicodeEmojisAddon(): void {
		setUnicodeEmojiConversionEnabled(!unicodeEmojisEnabled);
	}

	function toggleUnicodeDefaultSource(): void {
		setUnicodeEmojiDefaultSourceEnabled(!unicodeConvertDefaultEnabled);
	}

	function toggleUnicodeOpenmojiSource(): void {
		setUnicodeEmojiOpenmojiSourceEnabled(!unicodeConvertOpenmojiEnabled);
	}
</script>

{#if localAddonControlMatches('spellcheck')}
	<AddonRow
		id="spellcheck"
		label={$_('addon_chat.spellcheck_label')}
		description={$_('addon_chat.spellcheck_desc')}
		enabled={spellCheckEnabled}
		badge={SECTION}
		onToggle={toggleSpellCheckAddon}
	/>
{/if}

{#if localAddonControlMatches('char_counter')}
	<AddonRow
		id="char_counter"
		label={$_('addon_chat.counter_label')}
		description={$_('addon_chat.counter_desc')}
		enabled={charCounterEnabled}
		badge={SECTION}
		onToggle={toggleCharCounterAddon}
	/>
{/if}

{#if localAddonControlMatches('split_large_messages')}
	<AddonRow
		id="split_large_messages"
		label={$_('addon_chat.split_label')}
		description={$_('addon_chat.split_desc')}
		enabled={splitLargeMessagesEnabled}
		badge={SECTION}
		onToggle={toggleSplitLargeMessagesAddon}
	>
		{#snippet preferences()}
			<label class="addon-option">
				<span class="addon-option__label">{$_('addon_chat.chars_per_message')}</span>
				<input class="w-field addon-number"
					type="number"
					min="250"
					max="4000"
					step="50"
					value={splitLargeMessagesChunkSize}
					on:change={(event) => updateSplitLargeMessagesChunkSize(event.currentTarget.value)}
					disabled={!splitLargeMessagesEnabled}
				/>
			</label>
			<div class="addon-note">
				{$_('addon_chat.max_chars', { values: { max: splitLargeMessagesInputMaxLength.toLocaleString() } })}
				{splitLargeMessagesEnabled
					? $_('addon_chat.chunk_note', { values: { size: splitLargeMessagesChunkSize.toLocaleString() } })
					: $_('addon_chat.long_note')}
			</div>
		{/snippet}
	</AddonRow>
{/if}

{#if localAddonControlMatches('write_upper_case')}
	<AddonRow
		id="write_upper_case"
		label={$_('addon_chat.capitalize_label')}
		description={$_('addon_chat.capitalize_desc')}
		enabled={writeUpperCaseEnabled}
		badge={SECTION}
		onToggle={toggleWriteUpperCaseAddon}
	/>
{/if}

{#if localAddonControlMatches('clickable_mentions')}
	<AddonRow
		id="clickable_mentions"
		label={$_('addon_chat.clickable_label')}
		description={$_('addon_chat.clickable_desc')}
		enabled={clickableMentionsEnabled}
		badge={SECTION}
		onToggle={toggleClickableMentionsAddon}
	/>
{/if}

{#if localAddonControlMatches('complete_timestamps')}
	<AddonRow
		id="complete_timestamps"
		label={$_('addon_chat.timestamps_label')}
		description={$_('addon_chat.timestamps_desc')}
		enabled={timestampDisplayMode !== 'compact'}
		badge={SECTION}
		onToggle={() => updateTimestampDisplayMode(timestampDisplayMode === 'compact' ? 'complete' : 'compact')}
	>
		{#snippet preferences()}
			<div class="addon-field">
				<span class="w-label">{$_('panels.show')}</span>
				<Select ariaLabel={$_('addon_chat.timestamp_detail')} options={[{ value: 'compact', label: $_('addon_chat.time_only') }, { value: 'complete', label: $_('addon_chat.date_and_time') }, { value: 'detailed', label: $_('addon_chat.full_date_and_time') }]} value={timestampDisplayMode} onchange={(value) => updateTimestampDisplayMode(value)} />
			</div>
		{/snippet}
	</AddonRow>
{/if}

{#if localAddonControlMatches('message_utilities')}
	<AddonRow
		id="message_utilities"
		label={$_('addon_chat.tools_label')}
		description={$_('addon_chat.tools_desc')}
		enabled={messageUtilitiesEnabled}
		badge={SECTION}
		onToggle={toggleMessageUtilitiesAddon}
	/>
{/if}

{#if localAddonControlMatches('quick_mention')}
	<AddonRow
		id="quick_mention"
		label={$_('context_menu.quick_mention')}
		description={$_('addon_chat.quick_mention_desc')}
		enabled={quickMentionEnabled}
		badge={SECTION}
		onToggle={toggleQuickMentionAddon}
	/>
{/if}

{#if localAddonControlMatches('personal_pins')}
	<AddonRow
		id="personal_pins"
		label={$_('addon_chat.pins_label')}
		description={$_('addon_chat.pins_desc')}
		enabled={personalPinsEnabled}
		badge={SECTION}
		onToggle={togglePersonalPinsAddon}
	>
		{#snippet preferences()}
			<div class="addon-note">{personalPinCount === 1 ? $_('addon_chat.pin_one') : $_('addon_chat.pin_many', { values: { count: personalPinCount } })}</div>
			<div class="addon-actions">
				<button
					class="w-btn w-btn--sm"
					on:click={clearPersonalPinsAddon}
					disabled={personalPinCount === 0}
				>
					{$_('addon_chat.clear_local_pins')}
				</button>
			</div>
		{/snippet}
	</AddonRow>
{/if}

{#if localAddonControlMatches('unicode_emojis')}
	<AddonRow
		id="unicode_emojis"
		label={$_('addon_chat.shortcodes_label')}
		description={$_('addon_chat.shortcodes_desc')}
		enabled={unicodeEmojisEnabled}
		badge={SECTION}
		onToggle={toggleUnicodeEmojisAddon}
	>
		{#snippet preferences()}
<div class="addon-option">
				<span class="addon-option__label" id="addon-opt-unicode-default">{$_('addon_chat.builtin_shortcodes')}</span>
				<Switch labelledby="addon-opt-unicode-default" checked={unicodeConvertDefaultEnabled} onchange={toggleUnicodeDefaultSource} />
			</div>
			<div class="addon-option">
				<span class="addon-option__label" id="addon-opt-unicode-openmoji">{$_('addon_chat.openmoji_shortcodes')}</span>
				<Switch labelledby="addon-opt-unicode-openmoji" checked={unicodeConvertOpenmojiEnabled} onchange={toggleUnicodeOpenmojiSource} />
			</div>
			<div class="addon-note">{$_('addon_chat.shortcodes_applies')}</div>
		{/snippet}
	</AddonRow>
{/if}
