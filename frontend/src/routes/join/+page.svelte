<script lang="ts">
	import { onMount } from 'svelte';
	import { parseInvitation, type JoinInvitation } from '$lib/hostInvites';
	import { openCommunity, useCommunityAccount, type HostAccount } from '$lib/desktopHosting';
	import { checkCommunityForJoin } from '$lib/desktopHostFlow';
	import { initializeTheme } from '$lib/theme/initTheme';
	import '../../styles/components/desktop-hosting.css';
	let invitation = $state<JoinInvitation | null>(null);
	let error = $state('');
	let username = $state('');
	let password = $state('');
	let repeated = $state('');
	let busy = $state(false);
	onMount(() => {
		void initializeTheme(false);
		try {
			const fragment = new URLSearchParams(location.hash.slice(1));
			invitation = parseInvitation(fragment.get('ticket') || location.href);
		} catch (e) { error = String(e).replace(/^Error: /, ''); }
		// Admission secrets belong in memory, never browser history or request URLs.
		history.replaceState(history.state, '', location.pathname + location.search);
	});
	async function accept() {
		if (!invitation || busy) return;
		if (password.length < 8 || password !== repeated) { error = 'Use at least eight characters and repeat the same password.'; return; }
		const target = invitation; busy = true; error = '';
		try {
			await checkCommunityForJoin(target.server);
			const response = await fetch(`${target.server}/api/auth/register`, {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ username: username.trim(), password, inviteToken: target.token }),
				redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(15000)
			});
			const result = await response.json();
			if (!response.ok) throw new Error(result.error || 'The invitation was refused. It may be expired, revoked or already used. Ask the host for a new invitation.');
			useCommunityAccount(target.server, result as HostAccount);
			password = ''; repeated = ''; invitation = null;
			openCommunity(target.server);
		} catch (e) { error = String(e).replace(/^Error: /, ''); }
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
<main class="desktop-communities">
	<header><p class="eyebrow">Wabi · Invitation</p><h1>Join this community</h1></header>
	{#if error}<p class="notice error" role="alert">{error}</p>{/if}
	{#if invitation}
		<section class="community-card" aria-labelledby="join-title"><h2 id="join-title">Create your member account</h2>
			<p>Your account will belong to <strong>{invitation.server}</strong>. Continue only if this is the community you intended to join. No server will start on this computer.</p>
			{#if invitation.server.startsWith('http:')}<p class="notice warning" role="note">This local-network connection uses unencrypted HTTP. Use a trusted network and a unique password.</p>{/if}
			<form onsubmit={(event) => { event.preventDefault(); void accept(); }}>
				<label for="new-name">Username</label><input id="new-name" bind:value={username} required minlength="2" maxlength="64" autocomplete="username" autocapitalize="none" />
				<label for="new-password">Password</label><input id="new-password" type="password" bind:value={password} required minlength="8" autocomplete="new-password" />
				<label for="repeat-password">Repeat password</label><input id="repeat-password" type="password" bind:value={repeated} required minlength="8" autocomplete="new-password" />
				<div class="actions"><button disabled={busy}>{busy ? 'Joining…' : 'Accept invitation & create account'}</button></div>
			</form>
			<p class="small">This invitation admits one new member. Reloading clears it from this page; reopen the original link to try again.</p>
			<button class="secondary" disabled={busy} onclick={signIn}>Already a member? Sign in</button>
		</section>
	{/if}
	<footer><a href="/host">My communities · Join another community</a></footer>
</main>
