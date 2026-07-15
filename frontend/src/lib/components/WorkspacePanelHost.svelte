<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import type { WorkspacePanelManifest } from '$lib/workspacePanels';
	import { layoutStore } from '$lib/layoutStore';
	import UserListTab from './UserListTab.svelte';
	import MediaAlbumsTab from './MediaAlbumsTab.svelte';
	import NotesWorkspace from './NotesWorkspace.svelte';
	import MapWorkspace from './MapWorkspace.svelte';
	import AddonFallbackPanel from './AddonFallbackPanel.svelte';
	import ModelViewportTab from './ModelViewportTab.svelte';
	import ReaderTab from './ReaderTab.svelte';
	import FfxivReferencePanel from './FfxivReferencePanel.svelte';
	import TransferCenter from './TransferCenter.svelte';
	import DmListPanel from './DmListPanel.svelte';
	import DmConversationView from './DmConversationView.svelte';
	import { selectedDmChannelId } from '$lib/layoutStoreStates';
	import { currentUser } from '$lib/socket';
	import { getKeepNotesStorageKey } from '$lib/notesStore';

	export let panel: WorkspacePanelManifest;

	const dispatch = createEventDispatcher<{
		openSettings: { paymentSurface: 'connections' };
	}>();

	// A.5: Opening the admin right-panel entry must flip straight to the center
	// stage with ZERO stub flash. Trigger the flip as a side-effect and render
	// nothing visible (the stub lived in AdminTab.svelte, kept only as a file).
	$: if (panel.component === 'admin') {
		layoutStore.showAdminCenterStage();
	}
</script>

{#if panel.component === 'users'}
	<UserListTab />
{:else if panel.component === 'dms'}
	{#if $selectedDmChannelId}
		<DmConversationView context="right" />
	{:else}
		<DmListPanel />
	{/if}
{:else if panel.component === 'notes'}
	<NotesWorkspace
		storageKey={getKeepNotesStorageKey($currentUser?.id)}
		title="Notes"
		emptyMessage="No notes yet. Create one to get started."
		placeholder="Write your note..."
		compact={true}
	/>
{:else if panel.component === 'map'}
	<MapWorkspace variant="compact" />
{:else if panel.component === 'media'}
	<MediaAlbumsTab variant="compact" />
{:else if panel.component === 'admin'}
	<!-- Intentionally empty: admin flips to the center stage via the reactive
	     side-effect above, so no visible stub is ever mounted. -->
{:else if panel.component === 'model-viewport'}
	<ModelViewportTab />
{:else if panel.component === 'reader'}
	<ReaderTab />
{:else if panel.component === 'ffxiv-reference'}
	<FfxivReferencePanel />
{:else if panel.component === 'transfers'}
	<TransferCenter />
{:else}
	<AddonFallbackPanel {panel} />
{/if}
