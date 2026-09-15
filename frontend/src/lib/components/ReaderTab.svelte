<script lang="ts">
	import { browser } from '$app/environment';
	import { onDestroy } from 'svelte';
	import ReaderDocumentWorkbench from './ReaderDocumentWorkbench.svelte';
	import { activeServerUrl } from '$lib/serverUrl';
	import { currentUser } from '$lib/presenceIdentity';
	import { getAuthToken, getGuestSessionId, getStoredDbUserId, onAuthSessionCleared } from '$lib/authSession';
	import { activateReaderDocumentScope } from '$lib/readerDocuments';
	import { clearReaderSelection } from '$lib/readerWorkspace';
	import { getReaderAnonymousDeviceId, makeReaderDocumentScope } from '$lib/readerDocumentScope';

	let activeScope = '';
	let authBoundary = 0;
	const stopAuthBoundary = onAuthSessionCleared(() => { authBoundary += 1; });
	onDestroy(stopAuthBoundary);

	$: if (browser) {
		// Recompute on server, connected identity, and explicit logout/session boundaries.
		authBoundary;
		const server = $activeServerUrl;
		const token = getAuthToken(server);
		// Stored identity is itself server-scoped. Prefer it while changing servers,
		// because the connected presence store can briefly still describe the old
		// server until the new socket finishes authentication.
		const storedUserId = getStoredDbUserId(server);
		const registeredUserId = token
			? (storedUserId ?? $currentUser?.dbUserId ?? null)
			: null;
		const guestSessionId = registeredUserId ? null : getGuestSessionId(server);
		const identity = registeredUserId
			? `user:${registeredUserId}`
			: guestSessionId
				? `guest:${guestSessionId}`
				: `device:${getReaderAnonymousDeviceId()}`;
		const nextScope = makeReaderDocumentScope(server, identity);
		if (nextScope !== activeScope) {
			const crossingIdentityBoundary = activeScope !== '';
			activeScope = nextScope;
			if (crossingIdentityBoundary) clearReaderSelection();
			void activateReaderDocumentScope(nextScope);
		}
	}
</script>

<ReaderDocumentWorkbench />
