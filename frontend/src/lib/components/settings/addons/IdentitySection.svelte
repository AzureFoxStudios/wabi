<script lang="ts">
	import { _ } from '$lib/i18n';
	import {
		displayEnhancementSettingsStore,
		setCustomStatusPresetsEnabled, setLastMessageDateEnabled, setShowConnectionsEnabled,
		setUserNotesEnabled, setRemoveNicknamesEnabled, setLocalNicknamesEnabled,
		setStaffTagEnabled, setTopRoleEverywhereEnabled
	} from '$lib/displayEnhancements';
	import { brandName } from '$lib/branding';
	import { clearAllLocalNicknames, localNicknamesStore } from '$lib/localNicknames';
	import {
		MAX_CUSTOM_STATUS_PRESETS, addCustomStatusPreset, customStatusPresetsStore,
		removeCustomStatusPreset, resetCustomStatusPresetsToDefaults, setActiveCustomStatusPreset,
		type CustomStatusPresetPresence
	} from '$lib/customStatusPresets';
	import { ADDON_SECTION_LABELS } from '../addonSettingsRegistry';
	import { confirmAction } from '$lib/confirm';
	import AddonRow from './AddonRow.svelte';
	import Select from '../../ui/Select.svelte';

	export let localAddonControlMatches: (controlId: string) => boolean;

	const SECTION = ADDON_SECTION_LABELS.identity;

	let customStatusPresetsEnabled = true;
	let lastMessageDateEnabled = true;
	let showConnectionsEnabled = true;
	let userNotesEnabled = true;
	let removeNicknamesEnabled = false;
	let localNicknamesEnabled = true;
	let staffTagEnabled = true;
	let topRoleEverywhereEnabled = true;
	let customStatusPresetLabelDraft = '';
	let customStatusPresetNoteDraft = '';
	let customStatusPresetPresenceDraft: CustomStatusPresetPresence = 'active';
	let customStatusPresetsStatus = '';
	let localNicknameCount = 0;

	$: customStatusPresetsEnabled = $displayEnhancementSettingsStore.customStatusPresetsEnabled;
	$: lastMessageDateEnabled = $displayEnhancementSettingsStore.lastMessageDateEnabled;
	$: showConnectionsEnabled = $displayEnhancementSettingsStore.showConnectionsEnabled;
	$: userNotesEnabled = $displayEnhancementSettingsStore.userNotesEnabled;
	$: removeNicknamesEnabled = $displayEnhancementSettingsStore.removeNicknamesEnabled;
	$: localNicknamesEnabled = $displayEnhancementSettingsStore.localNicknamesEnabled;
	$: staffTagEnabled = $displayEnhancementSettingsStore.staffTagEnabled;
	$: topRoleEverywhereEnabled = $displayEnhancementSettingsStore.topRoleEverywhereEnabled;
	$: localNicknameCount = Object.keys($localNicknamesStore).length;

	function toggleCustomStatusPresetsAddon(): void {
		setCustomStatusPresetsEnabled(!customStatusPresetsEnabled);
	}

	function addCustomStatusPresetFromSettings(): void {
		const label = customStatusPresetLabelDraft.trim();
		if (!label) {
			customStatusPresetsStatus = $_('addon_identity.preset_label_required');
			return;
		}
		const added = addCustomStatusPreset(
			label,
			customStatusPresetPresenceDraft,
			customStatusPresetNoteDraft
		);
		if (!added) {
			customStatusPresetsStatus = $_('addon_identity.preset_limit', { values: { max: MAX_CUSTOM_STATUS_PRESETS } });
			return;
		}
		customStatusPresetLabelDraft = '';
		customStatusPresetNoteDraft = '';
		customStatusPresetPresenceDraft = 'active';
		customStatusPresetsStatus = $_('addon_identity.preset_added');
	}

	function removeCustomStatusPresetFromSettings(presetId: string): void {
		removeCustomStatusPreset(presetId);
		customStatusPresetsStatus = '';
	}

	function activateCustomStatusPresetFromSettings(
		presetId: string,
		status: CustomStatusPresetPresence
	): void {
		setActiveCustomStatusPreset(presetId);
		customStatusPresetsStatus = $_('addon_identity.preset_applied');
	}

	async function resetCustomStatusPresetsAddon(): Promise<void> {
		const confirmed = await confirmAction({ title: $_('addon_identity.reset_title'), body: $_('addon_identity.reset_body'), confirm: $_('addon_identity.reset_confirm'), danger: true });
		if (!confirmed) return;
		resetCustomStatusPresetsToDefaults();
		customStatusPresetsStatus = $_('addon_identity.presets_reset');
	}

	function toggleLastMessageDateAddon(): void {
		setLastMessageDateEnabled(!lastMessageDateEnabled);
	}

	function toggleShowConnectionsAddon(): void {
		setShowConnectionsEnabled(!showConnectionsEnabled);
	}

	function toggleUserNotesAddon(): void {
		setUserNotesEnabled(!userNotesEnabled);
	}

	function toggleRemoveNicknamesAddon(): void {
		setRemoveNicknamesEnabled(!removeNicknamesEnabled);
	}

	function toggleLocalNicknamesAddon(): void {
		setLocalNicknamesEnabled(!localNicknamesEnabled);
	}

	async function clearAllLocalNicknamesAddon(): Promise<void> {
		if (!(await confirmAction({ title: $_('addon_identity.clear_nicknames_title'), body: $_('addon_identity.clear_nicknames_body'), confirm: $_('addon_identity.clear_nicknames_confirm'), danger: true }))) return;
		clearAllLocalNicknames();
	}

	function toggleStaffTagAddon(): void {
		setStaffTagEnabled(!staffTagEnabled);
	}

	function toggleTopRoleEverywhereAddon(): void {
		setTopRoleEverywhereEnabled(!topRoleEverywhereEnabled);
	}
</script>

{#if localAddonControlMatches('custom_status_presets')}
	<AddonRow
		id="custom_status_presets"
		label={$_('addon_identity.presets_label')}
		description={$_('addon_identity.presets_desc')}
		enabled={customStatusPresetsEnabled}
		badge={SECTION}
		onToggle={toggleCustomStatusPresetsAddon}
	>
		{#snippet preferences()}
			<div class="addon-note">
				{$_('addon_identity.presets_count', { values: { count: $customStatusPresetsStore.presets.length, max: MAX_CUSTOM_STATUS_PRESETS } })}
			</div>
			<div class="addon-actions">
				<input
					type="text"
					class="w-field"
					placeholder={$_('addon_identity.preset_label_placeholder')}
					bind:value={customStatusPresetLabelDraft}
					maxlength="36"
					disabled={!customStatusPresetsEnabled}
				/>
				<Select
					ariaLabel={$_('addon_identity.presence_label')}
					options={[{ value: 'active', label: $_('user.status.online') }, { value: 'away', label: $_('user.status.away') }, { value: 'busy', label: $_('profile_settings.presence_busy') }]}
					value={customStatusPresetPresenceDraft}
					onchange={(value) => (customStatusPresetPresenceDraft = value as CustomStatusPresetPresence)}
					disabled={!customStatusPresetsEnabled}
				/>
				<button
					class="w-btn w-btn--sm"
					on:click={addCustomStatusPresetFromSettings}
					disabled={!customStatusPresetsEnabled || !customStatusPresetLabelDraft.trim()}
				>
					{$_('addon_identity.add_preset')}
				</button>
			</div>
			<div class="addon-actions">
				<input
					type="text"
					class="w-field"
					placeholder={$_('addon_identity.preset_note_placeholder')}
					bind:value={customStatusPresetNoteDraft}
					maxlength="120"
					disabled={!customStatusPresetsEnabled}
				/>
				<button
					class="w-btn w-btn--sm"
					on:click={resetCustomStatusPresetsAddon}
					disabled={!customStatusPresetsEnabled}
				>
					{$_('addon_identity.reset_presets')}
				</button>
			</div>
			{#if $customStatusPresetsStore.presets.length === 0}
				<div class="addon-note">{$_('addon_identity.no_statuses')}</div>
			{:else}
				<div class="addon-list">
					{#each $customStatusPresetsStore.presets as preset (preset.id)}
						<div class="addon-item">
							<div class="addon-item__main">
								<div class="addon-item__name">{preset.label}</div>
								<div class="addon-item__meta">
									{preset.status === 'active' ? $_('user.status.online') : preset.status === 'away' ? $_('user.status.away') : $_('profile_settings.presence_busy')}{preset.note ? ` · ${preset.note}` : ''}
								</div>
							</div>
							<div class="addon-actions">
								<button
									class="w-btn w-btn--sm"
									on:click={() => activateCustomStatusPresetFromSettings(preset.id, preset.status)}
									disabled={!customStatusPresetsEnabled}
								>
									{$_('reader_doc.apply')}
								</button>
								<button
									class="w-btn w-btn--sm w-btn--danger"
									on:click={() => removeCustomStatusPresetFromSettings(preset.id)}
									disabled={!customStatusPresetsEnabled}
								>
									{$_('profile_settings.remove')}
								</button>
							</div>
						</div>
					{/each}
				</div>
			{/if}
			{#if customStatusPresetsStatus}
				<div class="addon-note">{customStatusPresetsStatus}</div>
			{/if}
		{/snippet}
	</AddonRow>
{/if}

{#if localAddonControlMatches('last_message_date')}
	<AddonRow
		id="last_message_date"
		label={$_('addon_identity.last_message_label')}
		description={$_('addon_identity.last_message_desc')}
		enabled={lastMessageDateEnabled}
		badge={SECTION}
		onToggle={toggleLastMessageDateAddon}
	/>
{/if}

{#if localAddonControlMatches('show_connections')}
	<AddonRow
		id="show_connections"
		label={$_('addon_identity.connections_label')}
		description={$_('addon_identity.connections_desc')}
		enabled={showConnectionsEnabled}
		badge={SECTION}
		onToggle={toggleShowConnectionsAddon}
	/>
{/if}

{#if localAddonControlMatches('user_notes')}
	<AddonRow
		id="user_notes"
		label={$_('addon_identity.notes_label')}
		description={$_('addon_identity.notes_desc')}
		enabled={userNotesEnabled}
		badge={SECTION}
		onToggle={toggleUserNotesAddon}
	/>
{/if}

{#if localAddonControlMatches('remove_nicknames')}
	<AddonRow
		id="remove_nicknames"
		label={$_('addon_identity.hide_nicknames_label')}
		description={$_('addon_identity.hide_nicknames_desc')}
		enabled={removeNicknamesEnabled}
		badge={SECTION}
		onToggle={toggleRemoveNicknamesAddon}
	/>
{/if}

{#if localAddonControlMatches('local_nicknames')}
	<AddonRow
		id="local_nicknames"
		label={$_('addon_identity.local_nicknames_label')}
		description={$_('addon_identity.local_nicknames_desc')}
		enabled={localNicknamesEnabled}
		badge={SECTION}
		onToggle={toggleLocalNicknamesAddon}
	>
		{#snippet preferences()}
			<div class="addon-note">{localNicknameCount === 1 ? $_('addon_identity.nickname_one') : $_('addon_identity.nickname_many', { values: { count: localNicknameCount } })}</div>
			<div class="addon-actions">
				<button
					class="w-btn w-btn--sm"
					on:click={clearAllLocalNicknamesAddon}
					disabled={localNicknameCount === 0}
				>
					{$_('addon_identity.clear_local_nicknames')}
				</button>
			</div>
		{/snippet}
	</AddonRow>
{/if}

{#if localAddonControlMatches('staff_tag')}
	<AddonRow
		id="staff_tag"
		label={$_('addon_identity.staff_tag_label')}
		description={$_('addon_identity.staff_tag_desc')}
		enabled={staffTagEnabled}
		badge={SECTION}
		onToggle={toggleStaffTagAddon}
	/>
{/if}

{#if localAddonControlMatches('top_role_everywhere')}
	<AddonRow
		id="top_role_everywhere"
		label={$_('addon_identity.top_role_label')}
		description={$_('addon_identity.top_role_desc')}
		enabled={topRoleEverywhereEnabled}
		badge={SECTION}
		onToggle={toggleTopRoleEverywhereAddon}
	/>
{/if}
