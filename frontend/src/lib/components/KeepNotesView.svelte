<script lang="ts">
	import { currentUser } from '$lib/socket';
	import { getKeepNotesStorageKey } from '$lib/notesStore';
	import NotesWorkspace from './NotesWorkspace.svelte';

	$: storageKey = getKeepNotesStorageKey($currentUser?.id);
</script>

<NotesWorkspace
	title="Notes"
	showHeader={false}
	{storageKey}
	emptyMessage="Keep quick personal notes, links, and reminders."
	placeholder="Drop anything here. This is your private notes space."
/>
