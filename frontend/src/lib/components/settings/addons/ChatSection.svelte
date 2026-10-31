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
			title: 'Clear your personal pins?',
			body: `All ${personalPinCount} pins saved on this device go. Shared channel pins stay.`,
			confirm: 'Clear pins',
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
		label="Spell check"
		description="Underline misspelled words while you write messages."
		enabled={spellCheckEnabled}
		badge={SECTION}
		onToggle={toggleSpellCheckAddon}
	/>
{/if}

{#if localAddonControlMatches('char_counter')}
	<AddonRow
		id="char_counter"
		label="Character counter"
		description="Show how many characters a message has while you write it."
		enabled={charCounterEnabled}
		badge={SECTION}
		onToggle={toggleCharCounterAddon}
	/>
{/if}

{#if localAddonControlMatches('split_large_messages')}
	<AddonRow
		id="split_large_messages"
		label="Split long messages"
		description="Send very long text as several messages instead of one."
		enabled={splitLargeMessagesEnabled}
		badge={SECTION}
		onToggle={toggleSplitLargeMessagesAddon}
	>
		{#snippet preferences()}
			<label class="addon-option">
				<span class="addon-option__label">Characters per message</span>
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
				Messages can be up to {splitLargeMessagesInputMaxLength.toLocaleString()} characters.
				{splitLargeMessagesEnabled
					? ` Longer text goes out in parts of up to ${splitLargeMessagesChunkSize.toLocaleString()} characters.`
					: ' Long posts stay as one message and open in Reader after 2,000 characters.'}
			</div>
		{/snippet}
	</AddonRow>
{/if}

{#if localAddonControlMatches('write_upper_case')}
	<AddonRow
		id="write_upper_case"
		label="Capitalize sentences"
		description="Start each sentence you send with a capital letter."
		enabled={writeUpperCaseEnabled}
		badge={SECTION}
		onToggle={toggleWriteUpperCaseAddon}
	/>
{/if}

{#if localAddonControlMatches('clickable_mentions')}
	<AddonRow
		id="clickable_mentions"
		label="Clickable names and mentions"
		description="Click a name or @mention in a message to open that person's profile."
		enabled={clickableMentionsEnabled}
		badge={SECTION}
		onToggle={toggleClickableMentionsAddon}
	/>
{/if}

{#if localAddonControlMatches('complete_timestamps')}
	<AddonRow
		id="complete_timestamps"
		label="Full timestamps"
		description="How much of the date and time each message shows."
		enabled={timestampDisplayMode !== 'compact'}
		badge={SECTION}
		onToggle={() => updateTimestampDisplayMode(timestampDisplayMode === 'compact' ? 'complete' : 'compact')}
	>
		{#snippet preferences()}
			<div class="addon-field">
				<span class="w-label">Show</span>
				<Select ariaLabel="Timestamp detail" options={[{ value: 'compact', label: 'Time only' }, { value: 'complete', label: 'Date and time' }, { value: 'detailed', label: 'Full date and time' }]} value={timestampDisplayMode} onchange={(value) => updateTimestampDisplayMode(value)} />
			</div>
		{/snippet}
	</AddonRow>
{/if}

{#if localAddonControlMatches('message_utilities')}
	<AddonRow
		id="message_utilities"
		label="Extra message tools"
		description="Adds mention, pin and edit to the tools that appear over a message."
		enabled={messageUtilitiesEnabled}
		badge={SECTION}
		onToggle={toggleMessageUtilitiesAddon}
	/>
{/if}

{#if localAddonControlMatches('quick_mention')}
	<AddonRow
		id="quick_mention"
		label="Quick mention"
		description="Adds Mention to the message menu."
		enabled={quickMentionEnabled}
		badge={SECTION}
		onToggle={toggleQuickMentionAddon}
	/>
{/if}

{#if localAddonControlMatches('personal_pins')}
	<AddonRow
		id="personal_pins"
		label="Personal pins"
		description="Pin messages locally on this device without affecting shared channel pins."
		enabled={personalPinsEnabled}
		badge={SECTION}
		onToggle={togglePersonalPinsAddon}
	>
		{#snippet preferences()}
			<div class="addon-note">{personalPinCount === 1 ? '1 pin' : `${personalPinCount} pins`} on this device.</div>
			<div class="addon-actions">
				<button
					class="w-btn w-btn--sm"
					on:click={clearPersonalPinsAddon}
					disabled={personalPinCount === 0}
				>
					Clear local pins
				</button>
			</div>
		{/snippet}
	</AddonRow>
{/if}

{#if localAddonControlMatches('unicode_emojis')}
	<AddonRow
		id="unicode_emojis"
		label="Shortcodes to emoji"
		description="Turn shortcodes such as :smile: into emoji when you send. Custom emoji stay as they are."
		enabled={unicodeEmojisEnabled}
		badge={SECTION}
		onToggle={toggleUnicodeEmojisAddon}
	>
		{#snippet preferences()}
<div class="addon-option">
				<span class="addon-option__label" id="addon-opt-unicode-default">Built-in emoji shortcodes</span>
				<Switch labelledby="addon-opt-unicode-default" checked={unicodeConvertDefaultEnabled} onchange={toggleUnicodeDefaultSource} />
			</div>
			<div class="addon-option">
				<span class="addon-option__label" id="addon-opt-unicode-openmoji">OpenMoji shortcodes</span>
				<Switch labelledby="addon-opt-unicode-openmoji" checked={unicodeConvertOpenmojiEnabled} onchange={toggleUnicodeOpenmojiSource} />
			</div>
			<div class="addon-note">Applies to channel messages, DMs and GIF captions.</div>
		{/snippet}
	</AddonRow>
{/if}
