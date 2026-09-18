<script lang="ts">
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
	import AddonRow from './AddonRow.svelte';

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
			customStatusPresetsStatus = 'Preset label is required.';
			return;
		}
		const added = addCustomStatusPreset(
			label,
			customStatusPresetPresenceDraft,
			customStatusPresetNoteDraft
		);
		if (!added) {
			customStatusPresetsStatus = `Could not add preset. Limit: ${MAX_CUSTOM_STATUS_PRESETS} presets.`;
			return;
		}
		customStatusPresetLabelDraft = '';
		customStatusPresetNoteDraft = '';
		customStatusPresetPresenceDraft = 'active';
		customStatusPresetsStatus = 'Status preset added.';
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
		customStatusPresetsStatus = 'Status preset applied.';
	}

	function resetCustomStatusPresetsAddon(): void {
		const confirmed = window.confirm('Reset status presets to defaults?');
		if (!confirmed) return;
		resetCustomStatusPresetsToDefaults();
		customStatusPresetsStatus = 'Status presets reset.';
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

	function clearAllLocalNicknamesAddon(): void {
		if (!window.confirm('Clear all local nicknames on this device?')) return;
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
		label={`CustomStatusPresets (${brandName} translation)`}
		description="Save reusable presence presets and apply them directly from the sidebar status menu."
		enabled={customStatusPresetsEnabled}
		badge={SECTION}
		onToggle={toggleCustomStatusPresetsAddon}
	>
		{#snippet preferences()}
			<div class="runtime-note">
				Presets: {$customStatusPresetsStore.presets.length}/{MAX_CUSTOM_STATUS_PRESETS}
			</div>
			<div class="settings-row-actions">
				<input
					type="text"
					class="theme-select"
					placeholder="Preset label"
					bind:value={customStatusPresetLabelDraft}
					maxlength="36"
					disabled={!customStatusPresetsEnabled}
				/>
				<select
					class="theme-select"
					bind:value={customStatusPresetPresenceDraft}
					disabled={!customStatusPresetsEnabled}
				>
					<option value="active">Active</option>
					<option value="away">Away</option>
					<option value="busy">Busy</option>
				</select>
				<button
					class="action-btn"
					on:click={addCustomStatusPresetFromSettings}
					disabled={!customStatusPresetsEnabled || !customStatusPresetLabelDraft.trim()}
				>
					Add Preset
				</button>
			</div>
			<div class="settings-row-actions">
				<input
					type="text"
					class="theme-select"
					placeholder="Optional note shown below your username"
					bind:value={customStatusPresetNoteDraft}
					maxlength="120"
					disabled={!customStatusPresetsEnabled}
				/>
				<button
					class="action-btn secondary"
					on:click={resetCustomStatusPresetsAddon}
					disabled={!customStatusPresetsEnabled}
				>
					Reset Presets
				</button>
			</div>
			{#if $customStatusPresetsStore.presets.length === 0}
				<div class="runtime-note">No presets configured.</div>
			{:else}
				<div class="custom-status-preset-list">
					{#each $customStatusPresetsStore.presets as preset (preset.id)}
						<div class="custom-status-preset-row">
							<div class="custom-status-preset-main">
								<div class="custom-status-preset-label">{preset.label}</div>
								<div class="custom-status-preset-meta">
									{preset.status}{preset.note ? ` | ${preset.note}` : ''}
								</div>
							</div>
							<div class="settings-row-actions">
								<button
									class="action-btn secondary"
									on:click={() => activateCustomStatusPresetFromSettings(preset.id, preset.status)}
									disabled={!customStatusPresetsEnabled}
								>
									Apply
								</button>
								<button
									class="action-btn danger"
									on:click={() => removeCustomStatusPresetFromSettings(preset.id)}
									disabled={!customStatusPresetsEnabled}
								>
									Remove
								</button>
							</div>
						</div>
					{/each}
				</div>
			{/if}
			{#if customStatusPresetsStatus}
				<div class="runtime-note">{customStatusPresetsStatus}</div>
			{/if}
		{/snippet}
	</AddonRow>
{/if}

{#if localAddonControlMatches('last_message_date')}
	<AddonRow
		id="last_message_date"
		label="LastMessageDate"
		description="Show each user's most recent message timestamp in the active channel inside popouts."
		enabled={lastMessageDateEnabled}
		badge={SECTION}
		onToggle={toggleLastMessageDateAddon}
	/>
{/if}

{#if localAddonControlMatches('show_connections')}
	<AddonRow
		id="show_connections"
		label="ShowConnections"
		description="Show profile connections metadata (handle + linked URLs) in user popouts."
		enabled={showConnectionsEnabled}
		badge={SECTION}
		onToggle={toggleShowConnectionsAddon}
	/>
{/if}

{#if localAddonControlMatches('user_notes')}
	<AddonRow
		id="user_notes"
		label="UserNotes"
		description="Enable local private notes for each user directly from their popout profile."
		enabled={userNotesEnabled}
		badge={SECTION}
		onToggle={toggleUserNotesAddon}
	/>
{/if}

{#if localAddonControlMatches('remove_nicknames')}
	<AddonRow
		id="remove_nicknames"
		label="RemoveNicknames"
		description="Prefer stable account names in chat headers when incoming messages include alias-style display names."
		enabled={removeNicknamesEnabled}
		badge={SECTION}
		onToggle={toggleRemoveNicknamesAddon}
	/>
{/if}

{#if localAddonControlMatches('local_nicknames')}
	<AddonRow
		id="local_nicknames"
		label={`LocalNicknames (${brandName} translation)`}
		description="Set private per-user nicknames that only appear on this device in chat headers, popouts, and the user list."
		enabled={localNicknamesEnabled}
		badge={SECTION}
		onToggle={toggleLocalNicknamesAddon}
	>
		{#snippet preferences()}
			<div class="runtime-note">Local nicknames saved: {localNicknameCount}</div>
			<div class="settings-row-actions">
				<button
					class="action-btn secondary"
					on:click={clearAllLocalNicknamesAddon}
					disabled={localNicknameCount === 0}
				>
					Clear Local Nicknames
				</button>
			</div>
		{/snippet}
	</AddonRow>
{/if}

{#if localAddonControlMatches('staff_tag')}
	<AddonRow
		id="staff_tag"
		label="StaffTag"
		description="Show a staff marker for owner/admin/mod users in message and profile surfaces."
		enabled={staffTagEnabled}
		badge={SECTION}
		onToggle={toggleStaffTagAddon}
	/>
{/if}

{#if localAddonControlMatches('top_role_everywhere')}
	<AddonRow
		id="top_role_everywhere"
		label="TopRoleEverywhere"
		description="Show each user's top role badge beside usernames in chat and user popouts."
		enabled={topRoleEverywhereEnabled}
		badge={SECTION}
		onToggle={toggleTopRoleEverywhereAddon}
	/>
{/if}
