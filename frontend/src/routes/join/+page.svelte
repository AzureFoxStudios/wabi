<script lang="ts">
	import { onMount } from 'svelte';
	import { parseInvitation, type JoinInvitation } from '$lib/hostInvites';
	import { openCommunity, useCommunityAccount, type HostAccount } from '$lib/desktopHosting';
	import { checkCommunityForJoin } from '$lib/desktopHostFlow';
	import { explainJoinRefusal, explainLinkProblem, SERVER_CLOSED, USED_OR_EXPIRED } from '$lib/joinInvitation';
	import { getAuthToken, getStoredUsername } from '$lib/authSession';
	import { initializeTheme } from '$lib/theme/initTheme';
	import '../../styles/components/desktop-hosting.css';
	let invitation = $state<JoinInvitation | null>(null);
	/** checking: asking the server whether it takes invitations; ready: show the form; spent: the
	 * server refused the invitation itself (used, expired or cancelled), so there is nothing to retry. */
	let phase = $state<'checking' | 'ready' | 'closed' | 'unreachable' | 'spent'>('checking');
	/** A problem with the link or the server, shown at the top. */
	let error = $state('');
	/** A problem with what was typed, shown under the button where the person is looking. */
	let formError = $state('');
	let signedInAs = $state<string | null>(null);
	let username = $state('');
	let password = $state('');
	let repeated = $state('');
	let busy = $state(false);
	onMount(() => {
		void initializeTheme(false);
		const fragment = new URLSearchParams(location.hash.slice(1));
		const source = fragment.get('ticket') || location.href;
		try {
			invitation = parseInvitation(source);
		} catch { error = explainLinkProblem(source); }
		// Admission secrets belong in memory, never browser history or request URLs.
		history.replaceState(history.state, '', location.pathname + location.search);
		if (invitation) {
			if (getAuthToken(invitation.server)) signedInAs = getStoredUsername(invitation.server) || 'an existing account';
			void check(invitation.server);
		}
	});
	/** Tell the friend before they fill in a form whether this server can admit them at all. */
	async function check(server: string) {
		phase = 'checking'; error = '';
		try {
			await checkCommunityForJoin(server);
			const response = await fetch(`${server}/api/public/auth-policy`, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10000) });
			const policy = response.ok ? await response.json() : null;
			phase = policy && (policy.allowRegister === false || policy.mode === 'closed') ? 'closed' : 'ready';
		} catch (e) {
			error = String(e).replace(/^Error: /, '');
			phase = 'unreachable';
		}
	}
	async function accept() {
		if (!invitation || busy) return;
		if (username.trim().length < 2) { formError = 'Choose a username of at least two characters.'; return; }
		if (password.length < 8 || password !== repeated) { formError = 'Use at least eight characters and repeat the same password.'; return; }
		const target = invitation; busy = true; error = ''; formError = '';
		try {
			await checkCommunityForJoin(target.server);
			const response = await fetch(`${target.server}/api/auth/register`, {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ username: username.trim(), password, inviteToken: target.token }),
				redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(15000)
			});
			const result = await response.json().catch(() => ({}));
			if (!response.ok) {
				const explained = explainJoinRefusal(response.status, result.error);
				if (explained === SERVER_CLOSED || explained === USED_OR_EXPIRED) {
					phase = explained === SERVER_CLOSED ? 'closed' : 'spent';
					password = ''; repeated = '';
					error = explained;
				} else formError = explained;
				return;
			}
			useCommunityAccount(target.server, result as HostAccount);
			password = ''; repeated = ''; invitation = null;
			openCommunity(target.server);
		} catch (e) { formError = String(e).replace(/^Error: /, ''); }
		finally { busy = false; }
	}
	async function signIn() {
		if (!invitation || busy) return;
		const server = invitation.server;
		busy = true; error = '';
		try { await checkCommunityForJoin(server); openCommunity(server); }
		catch (e) { error = String(e).replace(/^Error: /, ''); }
		finally { busy = false; }
	}
</script>

<svelte:head><title>Join a community — Wabi</title><meta name="referrer" content="no-referrer" /><meta name="robots" content="noindex" /></svelte:head>
<main class="desktop-communities" data-join-phase={invitation ? phase : 'no-invitation'}>
	<header><p class="eyebrow">Wabi · Invitation</p><h1>Join this community</h1></header>
	{#if error}<p class="notice error" role="alert">{error}</p>{/if}
	{#if invitation}
		{#if phase === 'checking'}
			<p class="notice" role="status">Checking the invitation with {invitation.server}…</p>
		{:else if phase === 'unreachable'}
			<section class="community-card">
				<p>Nothing was created and your invitation has not been used.</p>
				<div class="row"><button onclick={() => invitation && check(invitation.server)}>Try again</button></div>
			</section>
		{:else if phase === 'closed' || phase === 'spent'}
			{#if !error}<p class="notice error" role="alert">{phase === 'closed' ? SERVER_CLOSED : USED_OR_EXPIRED}</p>{/if}
			<p class="small">Nothing was created. If you already have an account here, you can still sign in.</p>
			<button class="secondary" disabled={busy} onclick={signIn}>Sign in to {invitation.server}</button>
		{:else}
			{#if signedInAs}
				<section class="notice warning" role="note" data-signed-in>
					<p>This browser is already signed in to <strong>{invitation.server}</strong> as <strong>{signedInAs}</strong>. This invitation is for someone who doesn't have an account yet, so you don't need it.</p>
					<div class="row"><button class="secondary" disabled={busy} onclick={signIn}>Open Wabi as {signedInAs}</button></div>
					<p class="small">If you are making a second account on purpose, continue below. The invitation is used only when an account is created.</p>
				</section>
			{/if}
			<section class="community-card" aria-labelledby="join-title"><h2 id="join-title">Create your member account</h2>
				<p>Your account will belong to <strong>{invitation.server}</strong>. Continue only if this is the community you intended to join.</p>
				{#if invitation.server.startsWith('http:')}<p class="notice warning" role="note">This local-network connection uses unencrypted HTTP. Use a trusted network and a password you don't use anywhere else.</p>{/if}
				<form onsubmit={(event) => { event.preventDefault(); void accept(); }}>
					<label for="new-name">Username</label><input id="new-name" bind:value={username} required minlength="2" maxlength="64" autocomplete="username" autocapitalize="none" />
					<label for="new-password">Password</label><input id="new-password" type="password" bind:value={password} required minlength="8" autocomplete="new-password" />
					<label for="repeat-password">Repeat password</label><input id="repeat-password" type="password" bind:value={repeated} required minlength="8" autocomplete="new-password" />
					<div class="actions"><button disabled={busy}>{busy ? 'Joining…' : 'Accept invitation & create account'}</button></div>
					{#if formError}<p class="notice error" role="alert" data-form-error>{formError}</p>{/if}
				</form>
				<p class="small">This invitation admits one new member. Reloading clears it from this page; reopen the original link to try again.</p>
				{#if !signedInAs}<button class="secondary" disabled={busy} onclick={signIn}>Already a member? Sign in</button>{/if}
			</section>
		{/if}
	{/if}
	<footer><a href="/host">My communities · Join another community</a></footer>
</main>
