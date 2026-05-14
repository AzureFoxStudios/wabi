<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import type { WorkspacePanelManifest } from '$lib/workspacePanels';
	import UserListTab from './UserListTab.svelte';
	import DMTab from './DMTab.svelte';
	import AdminTab from './AdminTab.svelte';
	import MediaAlbumsTab from './MediaAlbumsTab.svelte';
	import QuickScratchpad from './QuickScratchpad.svelte';
	import MapWorkspace from './MapWorkspace.svelte';
	import AddonFallbackPanel from './AddonFallbackPanel.svelte';
	import ModelViewportTab from './ModelViewportTab.svelte';
	import ReaderTab from './ReaderTab.svelte';
	import FfxivReferencePanel from './FfxivReferencePanel.svelte';

	export let panel: WorkspacePanelManifest;

	const dispatch = createEventDispatcher<{
		openSettings: { paymentSurface: 'connections' };
	}>();
</script>

{#if panel.component === 'users'}
	<UserListTab />
{:else if panel.component === 'dms'}
	<DMTab on:openSettings={(event) => dispatch('openSettings', event.detail)} />
{:else if panel.component === 'notes'}
	<QuickScratchpad />
{:else if panel.component === 'map'}
	<MapWorkspace variant="compact" />
{:else if panel.component === 'media'}
	<MediaAlbumsTab />
{:else if panel.component === 'admin'}
	<AdminTab />
{:else if panel.component === 'model-viewport'}
	<ModelViewportTab />
{:else if panel.component === 'reader'}
	<ReaderTab />
{:else if panel.component === 'ffxiv-reference'}
	<FfxivReferencePanel />
{:else}
	<AddonFallbackPanel {panel} />
{/if}
