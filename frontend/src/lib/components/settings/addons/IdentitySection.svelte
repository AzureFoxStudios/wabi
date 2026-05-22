<script lang="ts">
	import {
		displayEnhancementSettingsStore,
		setCustomStatusPresetsEnabled, setLastMessageDateEnabled, setShowConnectionsEnabled,
		setUserNotesEnabled, setRemoveNicknamesEnabled, setLocalNicknamesEnabled,
		setStaffTagEnabled, setTopRoleEverywhereEnabled
	} from '$lib/displayEnhancements';
	import { clearAllLocalNicknames, localNicknamesStore } from '$lib/localNicknames';
	import {
		MAX_CUSTOM_STATUS_PRESETS, addCustomStatusPreset, customStatusPresetsStore,
		removeCustomStatusPreset, resetCustomStatusPresetsToDefaults, setActiveCustomStatusPreset,
		type CustomStatusPresetPresence
	} from '$lib/customStatusPresets';
	import { ADDON_SECTION_LABELS } from '../addonSettingsRegistry';
	import type { AddonSectionId } from '../addonSettingsRegistry';

	export let localAddonControlMatches: (controlId: string) => boolean;
	export let isAddonSectionOpen: (section: AddonSectionId) => boolean;
	export let toggleAddonSection: (section: AddonSectionId) => void;
	export let addonSectionMatchCount: (section: AddonSectionId) => number;

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

{#if localAddonControlMatches('custom_status_presets') || localAddonControlMatches('last_message_date') || localAddonControlMatches('show_connections') || localAddonControlMatches('user_notes') || localAddonControlMatches('remove_nicknames') || localAddonControlMatches('local_nicknames') || localAddonControlMatches('staff_tag') || localAddonControlMatches('top_role_everywhere')}
<section class="addon-accordion-section">
	<button
		type="button"
		class="addon-accordion-trigger"
		aria-expanded={isAddonSectionOpen('identity')}
		aria-controls="addon-section-identity"
		on:click={() => toggleAddonSection('identity')}
	>
		<span class="addon-accordion-trigger-main">
			<span class="addon-section-chevron" aria-hidden="true">
				<svg viewBox="0 0 24 24">
					<path d="M9 6l6 6-6 6"></path>
				</svg>
			</span>
			<span class="addon-accordion-label">{ADDON_SECTION_LABELS.identity}</span>
		</span>
		<span class="addon-accordion-count">{addonSectionMatchCount('identity')}</span>
	</button>
	{#if isAddonSectionOpen('identity')}
	<div class="addon-accordion-body" id="addon-section-identity">
		{#if localAddonControlMatches('custom_status_presets')}
			<div class="setting-item-full">
				<div class="setting-info">
					<span class="setting-label">CustomStatusPresets (Wabi translation)</span>
					<span class="setting-description">Save reusable presence presets and apply them directly from the sidebar status menu.</span>
				</div>
				<div class="settings-row-actions">
					<button class="toggle-btn" class:active={customStatusPresetsEnabled} on:click={toggleCustomStatusPresetsAddon}>
						{customStatusPresetsEnabled ? 'ON' : 'OFF'}
					</button>
					<div class="runtime-note">
						Presets: {$customStatusPresetsStore.presets.length}/{MAX_CUSTOM_STATUS_PRESETS}
					</div>
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
			</div>
		{/if}

		{#if localAddonControlMatches('last_message_date')}
			<div class="setting-item-full">
				<div class="setting-info">
					<span class="setting-label">LastMessageDate</span>
					<span class="setting-description">Show each user's most recent message timestamp in the active channel inside popouts.</span>
				</div>
				<div class="settings-row-actions">
					<button class="toggle-btn" class:active={lastMessageDateEnabled} on:click={toggleLastMessageDateAddon}>
						{lastMessageDateEnabled ? 'ON' : 'OFF'}
					</button>
				</div>
			</div>
		{/if}

		{#if localAddonControlMatches('show_connections')}
			<div class="setting-item-full">
				<div class="setting-info">
					<span class="setting-label">ShowConnections</span>
					<span class="setting-description">Show profile connections metadata (handle + linked URLs) in user popouts.</span>
				</div>
				<div class="settings-row-actions">
					<button class="toggle-btn" class:active={showConnectionsEnabled} on:click={toggleShowConnectionsAddon}>
						{showConnectionsEnabled ? 'ON' : 'OFF'}
					</button>
				</div>
			</div>
		{/if}

		{#if localAddonControlMatches('user_notes')}
			<div class="setting-item-full">
				<div class="setting-info">
					<span class="setting-label">UserNotes</span>
					<span class="setting-description">Enable local private notes for each user directly from their popout profile.</span>
				</div>
				<div class="settings-row-actions">
					<button class="toggle-btn" class:active={userNotesEnabled} on:click={toggleUserNotesAddon}>
						{userNotesEnabled ? 'ON' : 'OFF'}
					</button>
				</div>
			</div>
		{/if}

		{#if localAddonControlMatches('remove_nicknames')}
			<div class="setting-item-full">
				<div class="setting-info">
					<span class="setting-label">RemoveNicknames</span>
					<span class="setting-description">Prefer stable account names in chat headers when incoming messages include alias-style display names.</span>
				</div>
				<div class="settings-row-actions">
					<button class="toggle-btn" class:active={removeNicknamesEnabled} on:click={toggleRemoveNicknamesAddon}>
						{removeNicknamesEnabled ? 'ON' : 'OFF'}
					</button>
				</div>
			</div>
		{/if}

		{#if localAddonControlMatches('local_nicknames')}
			<div class="setting-item-full">
				<div class="setting-info">
					<span class="setting-label">LocalNicknames (Wabi translation)</span>
					<span class="setting-description">Set private per-user nicknames that only appear on this device in chat headers, popouts, and the user list.</span>
				</div>
				<div class="runtime-note">Local nicknames saved: {localNicknameCount}</div>
				<div class="settings-row-actions">
					<button class="toggle-btn" class:active={localNicknamesEnabled} on:click={toggleLocalNicknamesAddon}>
						{localNicknamesEnabled ? 'ON' : 'OFF'}
					</button>
					<button class="action-btn secondary" on:click={clearAllLocalNicknamesAddon} disabled={localNicknameCount === 0}>
						Clear Local Nicknames
					</button>
				</div>
			</div>
		{/if}

		{#if localAddonControlMatches('staff_tag')}
			<div class="setting-item-full">
				<div class="setting-info">
					<span class="setting-label">StaffTag</span>
					<span class="setting-description">Show a staff marker for owner/admin/mod users in message and profile surfaces.</span>
				</div>
				<div class="settings-row-actions">
					<button class="toggle-btn" class:active={staffTagEnabled} on:click={toggleStaffTagAddon}>
						{staffTagEnabled ? 'ON' : 'OFF'}
					</button>
				</div>
			</div>
		{/if}

		{#if localAddonControlMatches('top_role_everywhere')}
			<div class="setting-item-full">
				<div class="setting-info">
					<span class="setting-label">TopRoleEverywhere</span>
					<span class="setting-description">Show each user's top role badge beside usernames in chat and user popouts.</span>
				</div>
				<div class="settings-row-actions">
					<button class="toggle-btn" class:active={topRoleEverywhereEnabled} on:click={toggleTopRoleEverywhereAddon}>
						{topRoleEverywhereEnabled ? 'ON' : 'OFF'}
					</button>
				</div>
			</div>
		{/if}
	</div>
	{/if}
</section>
{/if}
