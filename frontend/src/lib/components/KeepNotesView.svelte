<script lang="ts">
	import { currentUser } from '$lib/socket';
	import { getKeepNotesStorageKey } from '$lib/notesStore';
	import NotesWorkspace from './NotesWorkspace.svelte';

	$: storageKey = getKeepNotesStorageKey($currentUser?.id);
</script>

<NotesWorkspace
	title="Keep Notes"
	{storageKey}
	emptyMessage="Keep quick personal notes, links, and reminders."
	placeholder="Drop anything here. This is your private Keep space."
/>
