<script lang="ts">
	import LineDm from '../../plugins/LineDm.svelte';
	import { clearPinnedDms, pinnedDmIdsStore } from '$lib/pinDms';
	import { ADDON_SECTION_LABELS } from '../addonSettingsRegistry';
	import type { AddonSectionId } from '../addonSettingsRegistry';

	export let localAddonControlMatches: (controlId: string) => boolean;
	export let isAddonSectionOpen: (section: AddonSectionId) => boolean;
	export let toggleAddonSection: (section: AddonSectionId) => void;
	export let addonSectionMatchCount: (section: AddonSectionId) => number;

	let pinnedDmConversationCount = 0;
	$: pinnedDmConversationCount = $pinnedDmIdsStore.length;

	function clearAllPinnedDmConversations(): void {
		if (pinnedDmConversationCount === 0) return;
		const confirmed = window.confirm('Clear all pinned DM conversations?');
		if (!confirmed) return;
		clearPinnedDms();
	}
</script>

{#if localAddonControlMatches('line_dm') || localAddonControlMatches('pin_dms')}
<section class="addon-accordion-section">
	<button
		type="button"
		class="addon-accordion-trigger"
		aria-expanded={isAddonSectionOpen('dms')}
		aria-controls="addon-section-dms"
		on:click={() => toggleAddonSection('dms')}
	>
		<span class="addon-accordion-trigger-main">
			<span class="addon-section-chevron" aria-hidden="true">
				<svg viewBox="0 0 24 24">
					<path d="M9 6l6 6-6 6"></path>
				</svg>
			</span>
			<span class="addon-accordion-label">{ADDON_SECTION_LABELS.dms}</span>
		</span>
		<span class="addon-accordion-count">{addonSectionMatchCount('dms')}</span>
	</button>
	{#if isAddonSectionOpen('dms')}
	<div class="addon-accordion-body" id="addon-section-dms">
		{#if localAddonControlMatches('line_dm')}
			<LineDm />
		{/if}

		{#if localAddonControlMatches('pin_dms')}
			<div class="setting-item-full">
				<div class="setting-info">
					<span class="setting-label">PinDMs (MVP)</span>
					<span class="setting-description">Pin conversations from the DM context menu to keep them at the top.</span>
				</div>
				<div class="runtime-note">Pinned conversations: {pinnedDmConversationCount}</div>
				<div class="settings-row-actions">
					<button class="action-btn secondary" on:click={clearAllPinnedDmConversations} disabled={pinnedDmConversationCount === 0}>
						Clear All Pins
					</button>
				</div>
			</div>
		{/if}
	</div>
	{/if}
</section>
{/if}
