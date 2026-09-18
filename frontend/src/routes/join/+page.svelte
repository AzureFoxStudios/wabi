<script lang="ts">
    import { onMount } from 'svelte';
    import { parseInvitation, type JoinInvitation } from '$lib/hostInvites';
    import { useAccount, type HostAccount } from '$lib/desktopHosting';
    let invitation = $state<JoinInvitation | null>(null); let error = $state('');
    let username = $state(''); let password = $state(''); let repeated = $state(''); let busy = $state(false);
    onMount(() => {
        try {
            const fragment = new URLSearchParams(location.hash.slice(1));
            invitation = parseInvitation(fragment.get('ticket') || location.href);
        } catch (e) { error = String(e); }
        // Do not retain a bearer admission grant in browser history/referrers.
        history.replaceState(history.state, '', location.pathname + location.search);
    });
    async function accept() {
        if (!invitation || busy) return;
        if (password.length < 8 || password !== repeated) { error = 'Use at least eight characters and repeat the same password.'; return; }
        const target = invitation; busy = true; error = '';
        try {
            const response = await fetch(`${target.server}/api/auth/register`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password, inviteToken: target.token }),
                redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(15000)
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'The invitation was refused. It may be expired, revoked, used, or registration may be closed.');
            useAccount(target.server, result as HostAccount); password = ''; repeated = ''; invitation = null;
            localStorage.setItem('wabi.desktop-choice', 'join');
            window.location.assign('/');
        } catch (e) { error = String(e); }
        finally { busy = false; }
    }
</script>
<svelte:head><title>Join a community — Wabi</title><meta name="referrer" content="no-referrer" /><meta name="robots" content="noindex" /></svelte:head>
<main>
    <h1>Join this community</h1>
    {#if error}<p role="alert">{error}</p>{/if}
    {#if invitation}
        <p>You are creating an account on <strong>{invitation.server}</strong>, not a global Wabi account. Only continue if this is the community you intended to join.</p>
        {#if invitation.server.startsWith('http:')}<p role="note">This is an unencrypted local-network connection. Do not reuse an important password.</p>{/if}
        <form onsubmit={(event) => { event.preventDefault(); void accept(); }}>
            <label for="new-name">Username</label><input id="new-name" bind:value={username} required minlength="2" maxlength="64" autocomplete="username" />
            <label for="new-password">Password</label><input id="new-password" type="password" bind:value={password} required minlength="8" autocomplete="new-password" />
            <label for="repeat-password">Repeat password</label><input id="repeat-password" type="password" bind:value={repeated} required minlength="8" autocomplete="new-password" />
            <button disabled={busy}>{busy ? 'Joining…' : 'Accept invitation and create account'}</button>
        </form>
        <p>This invitation admits one new member. Reloading clears the invitation from this page; reopen the original link to try again.</p>
    {:else if !error}<p>Reading invitation…</p>{/if}
    <a href="/host">Join another community</a>
</main>
<style>
    main { max-width: 580px; margin: 0 auto; padding: 3rem 1.5rem; color: var(--text-heading); }
    p { line-height: 1.6; color: var(--text-secondary); overflow-wrap: anywhere; } label { display: block; margin: 1rem 0 .4rem; }
    input { width: 100%; box-sizing: border-box; padding: .8rem; background: var(--surface-sunken); color: var(--text-heading); border: 1px solid var(--border-default, #454560); border-radius: var(--radius-md); font: inherit; }
    button { margin: 1.2rem 0; padding: .8rem 1rem; background: var(--accent-primary); color: white; border: 0; border-radius: var(--radius-md); font: inherit; cursor: pointer; } button:disabled { opacity: .5; } a { color: var(--accent-secondary); }
</style>
