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

	async function resetCustomStatusPresetsAddon(): Promise<void> {
		const confirmed = await confirmAction({ title: 'Reset your status presets?', body: 'Your own presets go and the defaults come back.', confirm: 'Reset presets', danger: true });
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

	async function clearAllLocalNicknamesAddon(): Promise<void> {
		if (!(await confirmAction({ title: 'Clear your nicknames?', body: 'Every nickname you gave people on this device goes. They keep their own names.', confirm: 'Clear nicknames', danger: true }))) return;
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
		label="Status presets"
		description="Saved statuses you can pick from your status menu in the sidebar."
		enabled={customStatusPresetsEnabled}
		badge={SECTION}
		onToggle={toggleCustomStatusPresetsAddon}
	>
		{#snippet preferences()}
			<div class="addon-note">
				Presets: {$customStatusPresetsStore.presets.length}/{MAX_CUSTOM_STATUS_PRESETS}
			</div>
			<div class="addon-actions">
				<input
					type="text"
					class="w-field"
					placeholder="Preset label"
					bind:value={customStatusPresetLabelDraft}
					maxlength="36"
					disabled={!customStatusPresetsEnabled}
				/>
				<Select
					ariaLabel="Presence for this preset"
					options={[{ value: 'active', label: 'Online' }, { value: 'away', label: 'Away' }, { value: 'busy', label: 'Busy' }]}
					value={customStatusPresetPresenceDraft}
					onchange={(value) => (customStatusPresetPresenceDraft = value as CustomStatusPresetPresence)}
					disabled={!customStatusPresetsEnabled}
				/>
				<button
					class="w-btn w-btn--sm"
					on:click={addCustomStatusPresetFromSettings}
					disabled={!customStatusPresetsEnabled || !customStatusPresetLabelDraft.trim()}
				>
					Add preset
				</button>
			</div>
			<div class="addon-actions">
				<input
					type="text"
					class="w-field"
					placeholder="Optional note shown below your username"
					bind:value={customStatusPresetNoteDraft}
					maxlength="120"
					disabled={!customStatusPresetsEnabled}
				/>
				<button
					class="w-btn w-btn--sm"
					on:click={resetCustomStatusPresetsAddon}
					disabled={!customStatusPresetsEnabled}
				>
					Reset presets
				</button>
			</div>
			{#if $customStatusPresetsStore.presets.length === 0}
				<div class="addon-note">No saved statuses yet.</div>
			{:else}
				<div class="addon-list">
					{#each $customStatusPresetsStore.presets as preset (preset.id)}
						<div class="addon-item">
							<div class="addon-item__main">
								<div class="addon-item__name">{preset.label}</div>
								<div class="addon-item__meta">
									{preset.status === 'active' ? 'Online' : preset.status === 'away' ? 'Away' : 'Busy'}{preset.note ? ` · ${preset.note}` : ''}
								</div>
							</div>
							<div class="addon-actions">
								<button
									class="w-btn w-btn--sm"
									on:click={() => activateCustomStatusPresetFromSettings(preset.id, preset.status)}
									disabled={!customStatusPresetsEnabled}
								>
									Apply
								</button>
								<button
									class="w-btn w-btn--sm w-btn--danger"
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
				<div class="addon-note">{customStatusPresetsStatus}</div>
			{/if}
		{/snippet}
	</AddonRow>
{/if}

{#if localAddonControlMatches('last_message_date')}
	<AddonRow
		id="last_message_date"
		label="Last message date"
		description="Profiles show when the person last wrote in this channel."
		enabled={lastMessageDateEnabled}
		badge={SECTION}
		onToggle={toggleLastMessageDateAddon}
	/>
{/if}

{#if localAddonControlMatches('show_connections')}
	<AddonRow
		id="show_connections"
		label="Show connections"
		description="Profiles show the person's handle and linked sites."
		enabled={showConnectionsEnabled}
		badge={SECTION}
		onToggle={toggleShowConnectionsAddon}
	/>
{/if}

{#if localAddonControlMatches('user_notes')}
	<AddonRow
		id="user_notes"
		label="Private notes on people"
		description="Keep a private note about someone on their profile. Only you see it, on this device."
		enabled={userNotesEnabled}
		badge={SECTION}
		onToggle={toggleUserNotesAddon}
	/>
{/if}

{#if localAddonControlMatches('remove_nicknames')}
	<AddonRow
		id="remove_nicknames"
		label="Hide nicknames"
		description="Show account names instead of the display names some messages carry."
		enabled={removeNicknamesEnabled}
		badge={SECTION}
		onToggle={toggleRemoveNicknamesAddon}
	/>
{/if}

{#if localAddonControlMatches('local_nicknames')}
	<AddonRow
		id="local_nicknames"
		label="Nicknames only you see"
		description="Give people nicknames that only you see, on this device, in chat, profiles and People."
		enabled={localNicknamesEnabled}
		badge={SECTION}
		onToggle={toggleLocalNicknamesAddon}
	>
		{#snippet preferences()}
			<div class="addon-note">{localNicknameCount === 1 ? '1 nickname' : `${localNicknameCount} nicknames`} saved on this device.</div>
			<div class="addon-actions">
				<button
					class="w-btn w-btn--sm"
					on:click={clearAllLocalNicknamesAddon}
					disabled={localNicknameCount === 0}
				>
					Clear local nicknames
				</button>
			</div>
		{/snippet}
	</AddonRow>
{/if}

{#if localAddonControlMatches('staff_tag')}
	<AddonRow
		id="staff_tag"
		label="Staff tag"
		description="Marks owners, admins and moderators beside their names."
		enabled={staffTagEnabled}
		badge={SECTION}
		onToggle={toggleStaffTagAddon}
	/>
{/if}

{#if localAddonControlMatches('top_role_everywhere')}
	<AddonRow
		id="top_role_everywhere"
		label="Top role everywhere"
		description="Shows each person's highest role beside their name."
		enabled={topRoleEverywhereEnabled}
		badge={SECTION}
		onToggle={toggleTopRoleEverywhereAddon}
	/>
{/if}
