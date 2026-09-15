<script lang="ts">
	import { browser } from '$app/environment';
	import { onDestroy } from 'svelte';
	import ReaderDocumentWorkbench from './ReaderDocumentWorkbench.svelte';
	import { activeServerUrl } from '$lib/serverUrl';
	import { currentUser } from '$lib/presenceIdentity';
	import { accountTokenSubject } from '$lib/apiRequest';
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
		// The JWT subject and stored DB id are both server-scoped. Prefer them
		// over connected presence because that store can briefly still describe
		// the previous server during a server switch.
		const tokenSubject = accountTokenSubject(token);
		const storedUserId = getStoredDbUserId(server);
		const registeredIdentity = token
			? (tokenSubject ? `subject:${tokenSubject}` : storedUserId ? `user:${storedUserId}` : $currentUser?.dbUserId ? `user:${$currentUser.dbUserId}` : null)
			: null;
		const guestSessionId = registeredIdentity ? null : getGuestSessionId(server);
		const identity = registeredIdentity
			?? (guestSessionId ? `guest:${guestSessionId}` : `device:${getReaderAnonymousDeviceId()}`);
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
