<script lang="ts">
    import { onMount } from 'svelte';
    import { goto } from '$app/navigation';
    import { canUseDesktopHosting, hostCommand, useAccount, type HostStatus, type HostAccount } from '$lib/desktopHosting';
    import { getAuthToken } from '$lib/authSession';
    import { setConfiguredServerUrl } from '$lib/serverUrl';
    import { makeInvitation, parseInvitation, invitationServer } from '$lib/hostInvites';

    let available = $state(false); let loaded = $state(false);
    let host = $state<HostStatus | null>(null); let busy = $state(''); let error = $state('');
    let username = $state(''); let password = $state(''); let confirmation = $state('');
    let join = $state(''); let shareAddress = $state(''); let invite = $state('');
    let expiry = $state(24); let message = $state(''); let pausedAction = $state('');
    let restoring = $state(''); let copied = $state(false);
    const ownerToken = () => host?.localUrl ? getAuthToken(host.localUrl) : null;
    async function refresh() {
        if (busy) return;
        try { host = await hostCommand<HostStatus>('host_status'); }
        catch (e) { error = String(e); }
    }
    onMount(() => {
        let disposed = false;
        void canUseDesktopHosting().then(async value => {
            if (disposed) return; available = value; loaded = true;
            if (value) await refresh();
        });
        const timer = setInterval(() => { if (available && !disposed) void refresh(); }, 2500);
        return () => { disposed = true; clearInterval(timer); };
    });
    async function run(label: string, action: () => Promise<void>) {
        if (busy) return; busy = label; error = ''; message = '';
        try { await action(); } catch (e) { error = String(e); }
        finally { busy = ''; pausedAction = ''; await refresh(); }
    }
    function enter() {
        if (!host?.localUrl) return;
        setConfiguredServerUrl(host.localUrl, true);
        sessionStorage.setItem('wabi.host-entered', 'true');
        localStorage.setItem('wabi.desktop-choice', 'host');
        window.location.assign('/');
    }
    async function account() {
        if (host?.setupRequired && (password.length < 8 || password !== confirmation)) {
            error = 'Use at least eight characters and repeat the same password.'; return;
        }
        await run('Saving account', async () => {
            const result = await hostCommand<HostAccount>('host_account', { username, password, register: host?.setupRequired === true });
            if (!host?.localUrl) throw new Error('The host stopped before the account was saved.');
            useAccount(host.localUrl, result); password = ''; confirmation = '';
            message = 'Your account is ready. Open the community or set up an invitation below.';
        });
    }
    async function joinCommunity() {
        try {
            if (join.includes('#invite=')) {
                parseInvitation(join); // Validate before navigating; never load remote pages into the native window.
                await goto(`/join#ticket=${encodeURIComponent(join.trim())}`);
            } else {
                const server = invitationServer(new URL(/^https?:\/\//i.test(join) ? join : `https://${join}`).href);
                setConfiguredServerUrl(server, true); localStorage.setItem('wabi.desktop-choice', 'join');
                window.location.assign('/');
            }
        } catch (e) { error = String(e); }
    }
    async function createInvite() {
        await run('Creating invitation', async () => {
            // Validate the address before minting/burning an invitation.
            makeInvitation(shareAddress, 'a'.repeat(64));
            const token = ownerToken(); if (!token) throw new Error('Sign in as this community’s owner first.');
            const result = await hostCommand<{ token: string; expiresAt: number }>('host_invite', { token, expiresInHours: Number(expiry) });
            invite = makeInvitation(shareAddress, result.token); copied = false;
        });
    }
    async function copyInvite() {
        try { await navigator.clipboard.writeText(invite); copied = true; }
        catch { error = 'Clipboard access was refused. Select and copy the invitation text below.'; }
    }
    async function confirmAction() {
        const action = pausedAction;
        await run('Updating community', async () => {
            if (action === 'backup') host = await hostCommand<HostStatus>('host_backup', { confirm: true });
            else if (action === 'restore') host = await hostCommand<HostStatus>('host_restore', { id: restoring, confirm: true });
            else if (action === 'stop') host = await hostCommand<HostStatus>('host_stop');
            else host = await hostCommand<HostStatus>('host_sharing', { lan: action === 'lan', confirm: true });
        });
    }
</script>

<svelte:head><title>Host or join — Wabi</title><meta name="description" content="Host a Wabi community on your computer or join an existing community." /></svelte:head>
<main class="hosting">
    <header><p class="eyebrow">YOUR COMMUNITY. YOUR COMPUTER.</p><h1>Host or join Wabi</h1><p>One server, whether you run it here or move it to a dedicated machine later.</p></header>
    {#if error || host?.error}<p class="notice error" role="alert">{error || host?.error}</p>{/if}
    {#if message}<p class="notice" role="status">{message}</p>{/if}
    {#if busy}<p role="status" aria-live="polite">{busy}…</p>{/if}
    <section aria-labelledby="join-title"><h2 id="join-title">Join a community</h2>
        <form onsubmit={(e) => { e.preventDefault(); void joinCommunity(); }}>
            <label for="join-address">Invitation link or server address</label>
            <div class="row"><input id="join-address" bind:value={join} placeholder="Paste your invitation" autocomplete="off" required /><button disabled={!!busy}>Join</button></div>
        </form>
    </section>
    <section aria-labelledby="host-title"><h2 id="host-title">Host on this computer</h2>
        {#if !loaded}<p>Checking this installation…</p>
        {:else if !available}<p>Hosting controls require the desktop application. This browser can still join a server above.</p>
        {:else if !host?.binaryAvailable}<p>This installation does not contain the Wabi Authority. A hosting package bundles it; installing Docker or Node is not required.</p>
        {:else}
            <p class="state">{host.running ? (host.ready ? 'Running' : 'Starting or recovering') : 'Stopped'} · {host.sharing === 'lan' ? 'Network listener enabled' : 'Local computer only'}</p>
            {#if !host.running}
                <button disabled={!!busy} onclick={() => run('Starting community', async () => { host = await hostCommand<HostStatus>('host_start'); })}>Start my community</button>
                <p>No owner account is exposed to the network during first setup.</p>
            {:else}
                {#if host.setupRequired || !ownerToken()}
                    <h3>{host.setupRequired ? 'Create the owner account' : 'Sign in to manage invitations'}</h3>
                    <form onsubmit={(e) => { e.preventDefault(); void account(); }}>
                        <label for="owner-name">Username</label><input id="owner-name" bind:value={username} required autocomplete="username" maxlength="64" />
                        <label for="owner-password">Password</label><input id="owner-password" type="password" bind:value={password} required minlength="8" autocomplete={host.setupRequired ? 'new-password' : 'current-password'} />
                        {#if host.setupRequired}<label for="owner-confirm">Repeat password</label><input id="owner-confirm" type="password" bind:value={confirmation} required autocomplete="new-password" />{/if}
                        <button disabled={!!busy}>{host.setupRequired ? 'Create my community' : 'Sign in'}</button>
                    </form>
                {/if}
                <div class="row actions"><button onclick={enter} disabled={!!busy || !host.ready || host.setupRequired === true}>Open my community</button><button class="secondary" disabled={!!busy} onclick={() => pausedAction = 'stop'}>Stop hosting</button></div>
                <p>Closing the window keeps hosting in the tray. <strong>Quit stops the community.</strong> Sleeping, shutting down or losing internet disconnects your guests.</p>
            {/if}
        {/if}
    </section>
    {#if available && host?.running && host.setupRequired === false}
        <section aria-labelledby="invite-title"><h2 id="invite-title">Invite someone</h2>
            <p>A local health check is <strong>not</strong> proof that friends can connect. This build does not automatically create a public HTTPS tunnel or complete private first-contact enrollment.</p>
            <div class="row"><button class="secondary" disabled={!!busy} onclick={() => pausedAction = host?.sharing === 'lan' ? 'local' : 'lan'}>{host.sharing === 'lan' ? 'Return to local-only' : 'Enable LAN / reverse-proxy listener'}</button></div>
            <form onsubmit={(e) => { e.preventDefault(); void createInvite(); }}>
                <label for="share-address">Address your guest can reach</label><input id="share-address" type="url" bind:value={shareAddress} required placeholder="https://your-community.example" />
                <p class="small">Use HTTPS on the internet. A private LAN address works only on that LAN; HTTP does not encrypt passwords. Never share a localhost address. A reverse proxy on this machine can use the local-only listener.</p>
                <label for="expiry">Invitation expires after</label><select id="expiry" bind:value={expiry}><option value={1}>1 hour</option><option value={24}>24 hours</option><option value={168}>7 days</option></select>
                <button disabled={!!busy || !ownerToken()}>Create one-use invitation</button>
            </form>
            {#if invite}<label for="invite-result">Invitation — keep this private until delivered</label><textarea id="invite-result" readonly value={invite} rows="3"></textarea><button onclick={copyInvite}>{copied ? 'Copied' : 'Copy invitation'}</button><p class="small">This admits one new member, not an administrator. It does not set up the network route.</p>{/if}
        </section>
    {/if}
    {#if available && host?.binaryAvailable}
        <section aria-labelledby="data-title"><h2 id="data-title">Data and recovery</h2>
            <p>Your accounts, messages, uploads and keys live here:</p><code>{host.dataDirectory}</code>
            <div class="row actions"><button class="secondary" onclick={() => run('Opening folder', async () => { await hostCommand('host_open_folder'); })}>Open data and logs folder</button><button disabled={!!busy} onclick={() => pausedAction = 'backup'}>Take a stopped backup</button></div>
            <p class="small">Backups pause the community, copy its complete data, verify file hashes, then resume it. Backups contain secret keys; keep an encrypted copy on a different drive. A same-drive snapshot does not protect against drive failure.</p>
            {#if host.backupIds.length}<label for="snapshot">Available snapshots</label><select id="snapshot" bind:value={restoring}><option value="">Choose a snapshot</option>{#each host.backupIds as id}<option value={id}>{id}</option>{/each}</select><button class="secondary" disabled={!!busy || !restoring} onclick={() => pausedAction = 'restore'}>Restore selected snapshot</button>{/if}
        </section>
    {/if}
    {#if pausedAction}
        <section class="confirm" role="alertdialog" aria-labelledby="confirm-title"><h2 id="confirm-title">Confirm interruption</h2>
            <p>{pausedAction === 'restore' ? 'This replaces the active community with the selected snapshot. The previous data is retained for recovery. Everyone will disconnect.' : pausedAction === 'lan' ? 'This allows connections from other computers to the HTTP listener after owner setup. It does not configure your router, HTTPS, or calls. Everyone currently connected will reconnect.' : 'This pauses or stops the community. Everyone currently connected will disconnect.'}</p>
            <div class="row"><button disabled={!!busy} onclick={confirmAction}>Confirm</button><button class="secondary" disabled={!!busy} onclick={() => pausedAction = ''}>Cancel</button></div>
        </section>
    {/if}
    <footer><a href="/">Back to Wabi</a><p>Experts can run the same <code>wabi-server --host … --port … --data-dir …</code>. Move the complete stopped data directory, including keys and uploads—not selected database files.</p></footer>
</main>
<style>
    .hosting { max-width: 850px; margin: 0 auto; padding: clamp(1rem, 4vw, 3rem); color: var(--text-heading); }
    header { margin-bottom: 2rem; } h1 { font-size: clamp(2rem, 5vw, 3rem); margin: .4rem 0; } h2 { margin-top: 0; } p { line-height: 1.6; color: var(--text-secondary); }
    .eyebrow { color: var(--accent-secondary); font-size: .8rem; letter-spacing: .1em; }
    section { padding: 1.5rem; margin: 1rem 0; border: 1px solid var(--border-default, #454560); border-radius: var(--radius-xl); background: var(--surface-base); }
    label { display: block; margin: 1rem 0 .4rem; } input, textarea, select { width: 100%; min-width: 0; box-sizing: border-box; padding: .8rem; border: 1px solid var(--border-default, #454560); border-radius: var(--radius-md); color: var(--text-heading); background: var(--surface-sunken); font: inherit; }
    button { padding: .8rem 1rem; border: 1px solid transparent; border-radius: var(--radius-md); background: var(--accent-primary); color: white; cursor: pointer; font: inherit; margin-top: .8rem; }
    button:disabled { opacity: .5; cursor: not-allowed; } button.secondary { background: var(--surface-raised); border-color: var(--border-default, #454560); }
    .row { display: flex; flex-wrap: wrap; gap: .7rem; align-items: center; } .row input { flex: 1 1 240px; } .row button { margin-top: 0; } .actions { margin-top: 1rem; }
    code { overflow-wrap: anywhere; font-size: .85rem; } .small, footer { font-size: .875rem; } .notice { padding: 1rem; background: var(--surface-raised); border-radius: var(--radius-md); } .error { border: 1px solid var(--color-danger, #e87070); }
    .confirm { border: 2px solid var(--accent-secondary); } a { color: var(--accent-secondary); } .state { font-weight: 600; }
</style>
