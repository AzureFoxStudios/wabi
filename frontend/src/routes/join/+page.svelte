<script lang="ts">
	import { _ } from '$lib/i18n';
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
		if (password.length < 8 || password !== repeated) { error = $_('join_page.password_rule'); return; }
		const target = invitation; busy = true; error = '';
		try {
			await checkCommunityForJoin(target.server);
			const response = await fetch(`${target.server}/api/auth/register`, {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ username: username.trim(), password, inviteToken: target.token }),
				redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(15000)
			});
			const result = await response.json();
			if (!response.ok) throw new Error(result.error || $_('join_page.refused'));
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

<svelte:head><title>{$_('join_page.title')}</title><meta name="referrer" content="no-referrer" /><meta name="robots" content="noindex" /></svelte:head>
<main class="desktop-communities">
	<header><p class="eyebrow">{$_('join_page.eyebrow')}</p><h1>{$_('join_page.heading')}</h1></header>
	{#if error}<p class="notice error" role="alert">{error}</p>{/if}
	{#if invitation}
		<section class="community-card" aria-labelledby="join-title"><h2 id="join-title">{$_('join_page.create_account')}</h2>
			<p>{$_('join_page.belongs_to')} <strong>{invitation.server}</strong>. {$_('join_page.confirm_community')}</p>
			{#if invitation.server.startsWith('http:')}<p class="notice warning" role="note">{$_('join_page.unencrypted')}</p>{/if}
			<form onsubmit={(event) => { event.preventDefault(); void accept(); }}>
				<label for="new-name">{$_('join_page.username')}</label><input id="new-name" bind:value={username} required minlength="2" maxlength="64" autocomplete="username" autocapitalize="none" />
				<label for="new-password">{$_('login.auth.password_placeholder')}</label><input id="new-password" type="password" bind:value={password} required minlength="8" autocomplete="new-password" />
				<label for="repeat-password">{$_('join_page.repeat_password')}</label><input id="repeat-password" type="password" bind:value={repeated} required minlength="8" autocomplete="new-password" />
				<div class="actions"><button disabled={busy}>{busy ? $_('login.guest.joining') : $_('join_page.accept')}</button></div>
			</form>
			<p class="small">{$_('join_page.one_member')}</p>
			<button class="secondary" disabled={busy} onclick={signIn}>{$_('join_page.already_member')}</button>
		</section>
	{/if}
	<footer><a href="/host">{$_('join_page.my_communities')}</a></footer>
</main>
