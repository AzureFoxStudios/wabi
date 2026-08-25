<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import type { WorkspacePanelManifest } from '$lib/workspacePanels';
	import UserListTab from './UserListTab.svelte';
	import CallsPanel from './CallsPanel.svelte';
	import MediaAlbumsTab from './MediaAlbumsTab.svelte';
	import KeepNotesView from './KeepNotesView.svelte';
	import MapWorkspace from './MapWorkspace.svelte';
	import AddonFallbackPanel from './AddonFallbackPanel.svelte';
	import ModelViewportTab from './ModelViewportTab.svelte';
	import ReaderTab from './ReaderTab.svelte';
	import FfxivReferencePanel from './FfxivReferencePanel.svelte';
	import TransferCenter from './TransferCenter.svelte';
	import DMTab from './DMTab.svelte';
	import AdminTab from './AdminTab.svelte';
	import LoreCodePanel from './lore/LoreCodePanel.svelte';
	import WhiteboardLayerPanel from './WhiteboardLayerPanel.svelte';
	import TaskPanel from './business/TaskPanel.svelte';

	export let panel: WorkspacePanelManifest;

	const dispatch = createEventDispatcher<{
		openSettings: { paymentSurface: 'connections' };
	}>();
</script>

{#if panel.component === 'users'}
	<UserListTab />
{:else if panel.component === 'calls'}
	<CallsPanel />
{:else if panel.component === 'dms'}
	<DMTab />
{:else if panel.component === 'notes'}
	<!-- N2: real notes panel (not DMTab / NOTES_DM_ID fake conversation) -->
	<KeepNotesView compact />
{:else if panel.component === 'whiteboard-layers'}
	<WhiteboardLayerPanel />
{:else if panel.component === 'map'}
	<MapWorkspace variant="compact" />
{:else if panel.component === 'media'}
	<MediaAlbumsTab variant="compact" />
{:else if panel.component === 'admin'}
	<!-- Design law: right = ambient staff ops. The Admin Ops Rail stays in the
	     right panel; "Open full dashboard" inside it flips the center stage. -->
	<AdminTab />
{:else if panel.component === 'model-viewport'}
	<ModelViewportTab />
{:else if panel.component === 'reader'}
	<ReaderTab />
{:else if panel.component === 'ffxiv-reference'}
	<FfxivReferencePanel />
{:else if panel.component === 'transfers'}
	<TransferCenter />
{:else if panel.component === 'code'}
	<LoreCodePanel />
{:else if panel.component === 'planner-tasks'}
	<!-- Planner Tasks in the right dock: compact TaskPanel, no close button
	     (the dock owns open/close). Shares the same store as the Planner. -->
	<TaskPanel compact />
{:else}
	<AddonFallbackPanel {panel} />
{/if}
