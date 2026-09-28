<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { goto } from '$app/navigation';
	import QRCode from 'qrcode';
	import { canUseDesktopHosting, hostCommand, openCommunity, useCommunityAccount, type HostStatus, type HostAccount } from '$lib/desktopHosting';
	import { checkCommunityForJoin, createHostedCommunity, hostStateLabel } from '$lib/desktopHostFlow';
	import type { StarterChannel } from '$lib/api/auth';
	import { getAuthToken } from '$lib/authSession';
	import { savedServers } from '$lib/savedServerStore';
	import { makeInvitation, parseInvitation, parseJoinAddress } from '$lib/hostInvites';
	import { initializeTheme } from '$lib/theme/initTheme';
	import BaseModal from '$lib/components/BaseModal.svelte';
	import '../../styles/components/desktop-hosting.css';

	let available = $state(false);
	let loaded = $state(false);
	let host = $state<HostStatus | null>(null);
	let view = $state<'host' | 'join' | 'communities'>('communities');
	let settings = $state(false);
	let mode = $state<'simple' | 'configurable' | null>(null);
	let lanAddresses = $state<string[]>([]);
	let choosingAddress = $state(false);
	let simpleInviteRequested = false;
	let focusInvitationAfterUpdate = false;
	let busy = $state('');
	let error = $state('');
	let message = $state('');
	let communityName = $state('');
	let username = $state('');
	let password = $state('');
	let confirmation = $state('');
	let starterTemplate: 'basic' | 'project' | 'community' | 'blank' = $state('basic');
	let starterChannels: StarterChannel[] = $state([{ name: 'general', kind: 'text' }, { name: 'general', kind: 'voice' }]);
	function chooseStarterTemplate(value: typeof starterTemplate) {
		starterTemplate = value;
		starterChannels = ({
			basic: [{ name: 'general', kind: 'text' }, { name: 'general', kind: 'voice' }],
			project: [{ name: 'general', kind: 'text' }, { name: 'updates', kind: 'text' }, { name: 'planning', kind: 'text' }, { name: 'voice', kind: 'voice' }],
			community: [{ name: 'general', kind: 'text' }, { name: 'announcements', kind: 'text' }, { name: 'introductions', kind: 'text' }, { name: 'voice', kind: 'voice' }],
			blank: []
		} satisfies Record<typeof starterTemplate, StarterChannel[]>)[value].map(channel => ({ ...channel }));
	}
	let join = $state('');
	let shareAddress = $state('');
	let invite = $state('');
	let inviteQr = $state('');
	let inviteExpiresAt = $state<number | null>(null);
	let invitationWasExpired = $state(false);
	let inviteExpiryTimer: ReturnType<typeof setTimeout> | null = null;
	let expiry = $state(24);
	let copied = $state(false);
	let restoring = $state('');
	let pending = $state<'stop' | 'restart' | 'lan' | 'local' | 'backup' | 'restore' | null>(null);
	let authRevision = $state(0);
	let disposed = false;
	let refreshing = false;
	const stateLabel = $derived(hostStateLabel(host, busy === 'Starting your community'));
	const ownerToken = $derived.by(() => { void authRevision; return host?.localUrl ? getAuthToken(host.localUrl) : null; });
	const existing = $derived(!!host?.hasCommunity && host?.setupRequired !== true);
	const readyToOpen = $derived(host?.ready && host.setupRequired === false);

	async function refresh() {
		if (busy || refreshing || disposed) return;
		refreshing = true;
		try { const next = await hostCommand<HostStatus>('host_status'); if (!disposed) host = next; }
		catch (e) { if (!disposed) error = String(e); }
		finally { refreshing = false; }
	}
	onMount(() => {
		void initializeTheme(false);
		void (async () => {
			available = await canUseDesktopHosting();
			if (available) await refresh();
			if (!disposed) loaded = true;
		})();
		const timer = setInterval(() => { if (available) void refresh(); }, 2500);
		return () => { disposed = true; clearInterval(timer); if (inviteExpiryTimer) clearTimeout(inviteExpiryTimer); };
	});
	async function run(label: string, action: () => Promise<void>) {
		if (busy) return;
		busy = label; error = ''; message = '';
		try { await action(); } catch (e) { error = String(e).replace(/^Error: /, ''); }
		finally {
			busy = ''; pending = null;
			if (available) await refresh();
			if (focusInvitationAfterUpdate) {
				focusInvitationAfterUpdate = false;
				await tick();
				document.getElementById('copy-invitation')?.focus();
			}
		}
	}
	async function createCommunity() {
		await run('Starting your community', async () => {
			const result = await createHostedCommunity(hostCommand, { communityName, username, password, confirmation, starterChannels });
			host = result.host;
			useCommunityAccount(result.host.localUrl!, result.account, communityName.trim());
			authRevision++; password = ''; confirmation = '';
			host = await hostCommand<HostStatus>('host_status');
			if (!host.ready || host.setupRequired !== false || !host.localUrl) throw new Error('The owner account was saved, but readiness could not be confirmed. Start the community and sign in with your existing account.');
			settings = mode === 'configurable';
			message = 'Your community is ready. Invite a friend, or open it now.';
		});
	}
	async function start(open = false) {
		await run('Starting your community', async () => {
			host = await hostCommand<HostStatus>('host_start');
			if (host.error) throw new Error(host.error);
			if (open && host.ready && host.setupRequired === false && host.localUrl) openCommunity(host.localUrl);
			else if (host.setupRequired) view = 'host';
		});
	}
	async function signIn() {
		await run('Signing in', async () => {
			const result = await hostCommand<HostAccount>('host_account', { username: username.trim(), password, register: false });
			if (!host?.localUrl) throw new Error('The community stopped. Start it and try again.');
			useCommunityAccount(host.localUrl, result, host.communityName || undefined);
			authRevision++; password = ''; message = 'Signed in. You can now create an invitation if this account is the owner.';
		});
	}
	async function joinCommunity() {
		await run('Checking community', async () => {
			if (join.includes('#')) {
				parseInvitation(join);
				await goto(`/join#ticket=${encodeURIComponent(join.trim())}`);
			} else {
				const server = parseJoinAddress(join);
				await checkCommunityForJoin(server);
				openCommunity(server);
			}
		});
	}
	async function issueInvitation() {
			const address = shareAddress.trim();
			makeInvitation(address, 'a'.repeat(64));
			if (new URL(address).protocol === 'http:' && host?.sharing !== 'lan') throw new Error('Enable LAN sharing before creating an invitation for a LAN address.');
			if (!ownerToken) throw new Error('Sign in as the community owner below first.');
			const result = await hostCommand<{ token: string; expiresAt: number }>('host_invite', { token: ownerToken, expiresInHours: Number(expiry) });
			const invitation = makeInvitation(address, result.token);
			clearInvitationOffer();
			invitationWasExpired = false;
			invite = invitation; inviteExpiresAt = result.expiresAt;
			const remainingMs = result.expiresAt * 1000 - Date.now();
			if (remainingMs <= 0) { expireInvitation(); return; }
			inviteExpiryTimer = setTimeout(expireInvitation, remainingMs);
			try {
				const qr = await QRCode.toDataURL(invitation, { width: 320, margin: 3, errorCorrectionLevel: 'M' });
				if (invite === invitation) inviteQr = qr;
			} catch {
				if (invite === invitation) error = 'The QR could not be generated. Copy the invitation link instead.';
			}
			if (invite !== invitation) return;
			message = `Invitation created. It expires ${new Date(result.expiresAt * 1000).toLocaleString()}.`;
			choosingAddress = false;
			focusInvitationAfterUpdate = true;
	}
	async function createInvite() {
		await run('Creating invitation', issueInvitation);
	}
	async function prepareLanInvitation() {
		const addresses = await hostCommand<string[]>('host_lan_addresses');
		clearInvitation();
		lanAddresses = addresses;
		expiry = 24;
		if (lanAddresses.length === 1) {
			shareAddress = lanAddresses[0];
			await issueInvitation();
		} else {
			choosingAddress = true;
			message = lanAddresses.length ? 'Choose the network your friend is connected to.' : 'No private network address was found. Connect to Wi-Fi or Ethernet, then try again.';
		}
	}
	async function simpleInvite() {
		if (host?.sharing !== 'lan') {
			simpleInviteRequested = true;
			pending = 'lan';
		} else await run('Creating invitation', prepareLanInvitation);
	}
	async function copyInvite() {
		try { await navigator.clipboard.writeText(invite); copied = true; }
		catch { error = 'Clipboard access was refused. Select and copy the invitation below.'; }
	}
	function clearInvitationOffer() {
		if (inviteExpiryTimer) clearTimeout(inviteExpiryTimer);
		inviteExpiryTimer = null;
		invite = ''; inviteQr = ''; inviteExpiresAt = null; copied = false;
	}
	function expireInvitation() {
		clearInvitationOffer();
		invitationWasExpired = true;
		message = '';
	}
	function clearInvitation() {
		clearInvitationOffer();
		invitationWasExpired = false;
		choosingAddress = false; lanAddresses = []; shareAddress = '';
		simpleInviteRequested = false;
	}
	async function confirmAction() {
		const action = pending;
		const inviteAfterSharing = action === 'lan' && simpleInviteRequested;
		simpleInviteRequested = false;
		await run(action === 'restart' ? 'Starting your community' : 'Updating your community', async () => {
			if (action === 'backup') { host = await hostCommand<HostStatus>('host_backup', { confirm: true }); message = 'Snapshot saved. To protect against drive failure, stop hosting and copy the entire hosting folder to another drive.'; }
			else if (action === 'restore') { host = await hostCommand<HostStatus>('host_restore', { id: restoring, confirm: true }); clearInvitation(); message = 'Snapshot restored. Previous data was preserved in the recovery folder.'; }
			else if (action === 'stop') host = await hostCommand<HostStatus>('host_stop');
			else if (action === 'restart') host = await hostCommand<HostStatus>('host_restart');
			else host = await hostCommand<HostStatus>('host_sharing', { lan: action === 'lan', confirm: true });
			if (host.error) throw new Error(host.error);
			if (action === 'local') clearInvitation();
			if (inviteAfterSharing) await prepareLanInvitation();
		});
	}
</script>

<svelte:head><title>My communities — Wabi</title><meta name="description" content="Host a Wabi community on your computer or join an existing community." /></svelte:head>

<main class="desktop-communities">
	<header><p class="eyebrow">Wabi · Your communities</p><h1>A place for your people.</h1><p>Run a community on this computer, or join one someone has shared with you.</p></header>
	<nav class="community-nav" aria-label="Community actions">
		<button aria-pressed={view === 'host'} onclick={() => { view = 'host'; settings = false; }}>Host a community</button>
		<button aria-pressed={view === 'join'} onclick={() => view = 'join'}>Join a community</button>
		<button aria-pressed={view === 'communities'} onclick={() => view = 'communities'}>My communities</button>
	</nav>
	{#if error || host?.error}<p class="notice error" role="alert">{error || host?.error}</p>{/if}
	{#if message}<p class="notice" role="status">{message}</p>{/if}
	{#if busy}<p role="status" aria-live="polite">{busy}…</p>{/if}

	{#if view === 'join'}
		<section class="community-card" aria-labelledby="join-title"><h2 id="join-title">Join a community</h2>
			<p>Paste an invitation or server address. This connects to an existing community; it never starts a server on this computer.</p>
			<form onsubmit={(event) => { event.preventDefault(); void joinCommunity(); }}>
				<label for="join-address">Invitation link or server address</label><input id="join-address" bind:value={join} placeholder="https://your-community.example" autocomplete="off" autocapitalize="none" spellcheck="false" required />
				<div class="actions"><button disabled={!!busy}>Continue to community</button></div>
			</form><p class="small">Each community has its own accounts and messages. A local-network address works only when you can reach that network. For HTTP, use a trusted network and a unique password.</p>
		</section>
	{:else if view === 'communities'}
		<section class="community-card" aria-labelledby="communities-title"><h2 id="communities-title">My communities</h2>
			{#if !loaded}<p role="status">Checking this installation…</p>
			{:else if host?.hasCommunity}
				<ul class="community-list"><li><div class="community-description"><strong>{host.communityName || 'Community on this computer'}</strong><p class="small"><span class="status" data-state={stateLabel}>{stateLabel}</span> · {host.sharing === 'lan' ? 'LAN sharing enabled' : 'Local only'}</p></div><div class="row">
					<button disabled={!!busy || (host.running && !readyToOpen)} onclick={() => host?.running && host.localUrl ? openCommunity(host.localUrl) : start(true)}>{host.running ? 'Open community' : 'Start & open'}</button>
					<button class="secondary" onclick={() => { view = 'host'; settings = true; }}>Open hosting settings</button>
				</div></li></ul>
			{/if}
			{#if $savedServers.filter(server => server.url !== host?.localUrl).length}
				<ul class="community-list">{#each $savedServers.filter(server => server.url !== host?.localUrl) as server (server.url)}<li><div class="community-description"><strong>{server.effectiveName}</strong><p class="small">{server.lastUsername ? `@${server.lastUsername} · ` : ''}{server.url}</p></div><button class="secondary" disabled={!!busy} onclick={() => openCommunity(server.url)}>Open community</button></li>{/each}</ul>
			{:else if loaded && !host?.hasCommunity}<p>No communities saved yet. Choose <strong>Host a community</strong> to create one, or <strong>Join a community</strong> if you have an address.</p>{/if}
		</section>
	{:else}
		<section class="community-card" aria-labelledby="host-title"><h2 id="host-title">{existing ? host?.communityName || 'Your local community' : 'Host on this computer'}</h2>
			{#if !loaded}<p role="status">Checking this installation…</p>
			{:else if !available}<p>Hosting requires the Wabi desktop application. This browser can join a community using the tab above.</p>
			{:else if !host}<p>The hosting service could not be read. Retry to check the installation.</p><button class="secondary" onclick={refresh}>Retry</button>
			{:else if !host.binaryAvailable}<p>This installation is missing the bundled Wabi server. Install a desktop hosting package to continue. Your saved data will remain in place.</p>
			{:else}
				<p class="status" data-state={stateLabel} role="status">Server status: {stateLabel}</p>
				{#if !existing}
					{#if !mode}
						<p>Your community lives on this computer. Choose how you want to set it up.</p>
						<div class="hosting-modes">
							<button class="mode-choice secondary" onclick={() => mode = 'simple'}><strong>Simple <span class="small">Recommended</span></strong><span>Name your community, create your account, then invite a friend on your network.</span></button>
							<button class="mode-choice secondary" onclick={() => mode = 'configurable'}><strong>Configurable</strong><span>Create your community, then open sharing, invitation and backup settings.</span></button>
						</div>
					{:else}
						<div class="row"><p>{mode === 'simple' ? 'Simple setup' : 'Configurable setup'}</p><button class="secondary" disabled={!!busy} onclick={() => mode = null}>Change setup</button></div>
					<p>Give your community a name and create your owner account. Sharing stays off until you choose to invite someone.</p>
					<form onsubmit={(event) => { event.preventDefault(); void createCommunity(); }}>
						<label for="community-name">Community name</label><input id="community-name" bind:value={communityName} required maxlength="80" autocomplete="organization" placeholder="Our little corner" />
						<label for="owner-name">Owner username</label><input id="owner-name" bind:value={username} required minlength="2" maxlength="64" autocomplete="username" autocapitalize="none" />
						<label for="owner-password">Owner password</label><input id="owner-password" type="password" bind:value={password} required minlength="8" autocomplete="new-password" />
						<label for="owner-confirm">Repeat password</label><input id="owner-confirm" type="password" bind:value={confirmation} required minlength="8" autocomplete="new-password" />
						<details class="starter-channels"><summary>Starting channels</summary><p class="small">Choose an editable room layout. Security and membership controls come later in server settings.</p>
							<label for="host-starter-layout">Layout</label><select id="host-starter-layout" value={starterTemplate} onchange={event => chooseStarterTemplate(event.currentTarget.value as typeof starterTemplate)} disabled={!!busy}><option value="basic">Basic · chat and voice</option><option value="project">Project · updates and planning</option><option value="community">Community · introductions and announcements</option><option value="blank">Blank</option></select>
							{#each starterChannels as channel, index (index)}<div class="starter-channel-row"><select bind:value={channel.kind} aria-label="Room type" disabled={!!busy}><option value="text">Text</option><option value="voice">Voice</option></select><input bind:value={channel.name} aria-label="Room name" maxlength="40" required disabled={!!busy} /><button type="button" class="secondary" onclick={() => starterChannels = starterChannels.filter((_, item) => item !== index)} disabled={!!busy}>Remove</button></div>{/each}
							{#if starterChannels.length < 12}<button type="button" class="secondary" onclick={() => starterChannels = [...starterChannels, { name: '', kind: 'text' }]} disabled={!!busy}>Add room</button>{/if}
						</details>
						<div class="actions"><button disabled={!!busy}>Host Server</button></div>
					</form><p class="small">Keep your owner password somewhere safe. You can invite friends as soon as your community is ready.</p>
					{/if}
				{:else}
					<p>{host.sharing === 'lan' ? 'LAN sharing is enabled. People on your trusted network may connect using this computer’s LAN address.' : 'Local only. Your community is available on this computer.'}</p>
					<div class="row actions">
						{#if !host.running}<button disabled={!!busy} onclick={() => start(true)}>Start &amp; open</button>{:else}<button disabled={!!busy || !readyToOpen} onclick={() => host?.localUrl && openCommunity(host.localUrl)}>Open community</button>{/if}
						{#if settings}
					<button class="secondary" disabled={!!busy || !host.running} onclick={() => pending = 'stop'}>Stop</button><button class="secondary" disabled={!!busy || !host.running} onclick={() => pending = 'restart'}>Restart</button>
						<button class="secondary" disabled={!!busy} onclick={() => pending = 'backup'}>Backup</button>
						{/if}
						{#if !settings}<button class="secondary" onclick={() => settings = true}>Open hosting settings</button>{/if}
					</div>
				{/if}
				<p class="small">Closing the window keeps hosting in the tray. <strong>Quit stops the community safely.</strong> Sleep or shutdown disconnects members. After restarting the computer, open Wabi and choose <strong>Start &amp; open</strong> to resume the same data. Reopening Wabi starts with LAN sharing off.</p>
			{/if}
		</section>
		{#if !settings && available && existing && host?.ready}
			<section class="community-card" aria-labelledby="simple-invite-title"><h2 id="simple-invite-title">Invite a friend</h2>
				<p>Share a link with someone on the same trusted Wi-Fi or local network. Wabi finds this computer’s address for you.</p>
				{#if !ownerToken}
					<p>Sign in as the owner in hosting settings to create an invitation.</p>
				{:else if invite}
					<label for="invite-result">Invitation link</label><textarea id="invite-result" readonly value={invite} rows="3"></textarea>
					{#if inviteQr}<img class="invitation-qr" src={inviteQr} alt="One-use invitation QR code" width="320" height="320" />{/if}
					<div class="row actions"><button id="copy-invitation" onclick={copyInvite}>{copied ? 'Copied' : 'Copy invitation'}</button><button class="secondary" disabled={!!busy} onclick={simpleInvite}>Invite another friend</button></div>
					<p class="small">The link and QR contain the same one-use invitation{inviteExpiresAt ? `, expiring ${new Date(inviteExpiresAt * 1000).toLocaleString()}` : ''}. Show them only to the intended person. Keep Wabi running; their device must be able to reach this address.</p>
				{:else}
					{#if invitationWasExpired}<p class="notice" role="status">Previous invitation expired. Create a new one.</p>{/if}
					{#if choosingAddress && lanAddresses.length > 1}
						<form onsubmit={(event) => { event.preventDefault(); void createInvite(); }}>
							<label for="lan-address">Address on your friend’s network</label><select id="lan-address" bind:value={shareAddress} disabled={!!busy} required><option value="" disabled>Choose a network address</option>{#each lanAddresses as address}<option value={address}>{address}</option>{/each}</select>
							<p class="small">Several connections were found, such as Wi-Fi, Ethernet or a VPN. Choose the address your friend can reach.</p>
							<div class="actions"><button disabled={!!busy || !shareAddress}>Create invitation</button></div>
						</form>
					{:else}<div class="actions"><button disabled={!!busy} onclick={simpleInvite}>{choosingAddress ? 'Find network again' : 'Create invitation'}</button></div>{/if}
				{/if}
				<details><summary>Friends outside your network</summary><p>A local IP link only works where that address is reachable. Remote browser access needs an HTTPS connection set up in hosting settings.</p><p>Tailcat can provide private access through the Wabi app, but first-time guest enrollment is not yet connected to this invitation flow. It is currently configured separately for existing members.</p></details>
			</section>
		{/if}
		{#if settings && available && host?.hasCommunity}
			<section class="community-card" aria-labelledby="sharing-title"><h2 id="sharing-title">Hosting settings · Access &amp; invitations</h2>
				<p><strong>{host.sharing === 'lan' ? 'LAN sharing enabled' : 'Local only'}</strong> · Internet access is not configured automatically.</p>
				{#if !host.ready || host.setupRequired !== false}<p>Start your community and finish creating its owner before enabling sharing or invitations.</p>
				{:else}
					<button class="secondary" disabled={!!busy} onclick={() => pending = host?.sharing === 'lan' ? 'local' : 'lan'}>{host.sharing === 'lan' ? 'Turn off LAN sharing' : 'Enable LAN sharing'}</button>
					<p class="small">LAN uses unencrypted HTTP. Enable it only on a trusted private network. It does not open your router or prove that another device can reach you.</p>
					<form onsubmit={(event) => { event.preventDefault(); void createInvite(); }}>
						<label for="share-address">Address your guest can reach</label><input id="share-address" type="url" bind:value={shareAddress} disabled={!!busy} required placeholder="http://192.168.1.25:3001" />
						<p class="small">For LAN, use this computer’s private IP and the port shown below. Do not send localhost to guests. For remote access, configure HTTPS first.</p>
						<label for="expiry">Invitation expires after</label><select id="expiry" bind:value={expiry} disabled={!!busy}><option value={1}>1 hour</option><option value={24}>24 hours</option><option value={168}>7 days</option></select>
						<div class="actions"><button disabled={!!busy || !ownerToken}>Create one-use invitation</button></div>
					</form>
					{#if invitationWasExpired}<p class="notice" role="status">Previous invitation expired. Create a new one.</p>{/if}
					{#if invite}<label for="invite-result">Invitation link</label><textarea id="invite-result" readonly value={invite} rows="3"></textarea>{#if inviteQr}<img class="invitation-qr" src={inviteQr} alt="One-use invitation QR code" width="320" height="320" />{/if}<div class="actions"><button id="copy-invitation" onclick={copyInvite}>{copied ? 'Copied' : 'Copy invitation'}</button></div><p class="small">The link and QR contain the same one-use invitation{inviteExpiresAt ? `, expiring ${new Date(inviteExpiresAt * 1000).toLocaleString()}` : ''}. Show them only to the intended person. Their device must be able to reach this address; this does not create a network connection.</p>{/if}
					<details open={!ownerToken}><summary>Sign in as owner to manage invitations</summary><form onsubmit={(event) => { event.preventDefault(); void signIn(); }}><label for="signin-name">Owner username</label><input id="signin-name" bind:value={username} required autocomplete="username" /><label for="signin-password">Password</label><input id="signin-password" type="password" bind:value={password} required autocomplete="current-password" /><div class="actions"><button disabled={!!busy}>Sign in</button></div></form></details>
				{/if}
				<details><summary>Connect people outside your network</summary><p>Remote internet hosting needs a separate HTTPS reverse proxy or tunnel, a reachable address, and any required firewall configuration. Complete that setup, test it from another network, then create an invitation for that HTTPS address.</p><p>Private-access transport such as Tailcat is a separate optional helper with its own enrollment. An invitation alone does not install or configure it. Calling may require additional media networking.</p><p>Community messages, including DMs, are readable by the server operator. Transport encryption does not make them end-to-end encrypted.</p></details>
			</section>
			<section class="community-card" aria-labelledby="data-title"><h2 id="data-title">Data &amp; recovery</h2><p>Accounts, content, uploads and identity keys are stored together on this computer:</p><code>{host.dataDirectory}</code>
				<div class="row actions"><button class="secondary" disabled={!!busy} onclick={() => run('Opening hosting folder', async () => { await hostCommand('host_open_folder'); })}>Open hosting folder</button><button disabled={!!busy} onclick={() => pending = 'backup'}>Backup</button></div>
				<p class="small">Backup briefly stops the server, copies and verifies its data, then resumes it if it was running. These snapshots stay on this drive. For recovery after drive failure or damaged settings, choose <strong>Stop</strong>, open the hosting folder, and copy the <strong>entire folder</strong> to another drive, including <code>host.json</code>, <code>data</code> and <code>backups</code>. A snapshot alone does not include the hosting settings. The folder contains account data and secret keys; keep your external copy encrypted.</p>
				{#if host.backupIds.length}<label for="snapshot">Saved snapshots</label><select id="snapshot" bind:value={restoring}><option value="">Choose a snapshot</option>{#each host.backupIds as id}<option value={id}>{id}</option>{/each}</select><div class="actions"><button class="secondary" disabled={!!busy || !restoring} onclick={() => pending = 'restore'}>Restore snapshot</button></div><p class="small">Restore stops hosting and preserves the previous data in a recovery folder before using the snapshot. Never delete lock files or identity keys to fix a startup error.</p>{/if}
				<details><summary>Connection &amp; support details</summary><p>Address on this computer: <code>{host.localUrl || 'Assigned when started'}</code></p><p>Server identity: <code>{host.serverId || 'Created on first start'}</code></p><p>Logs: <code>{host.logDirectory}</code></p><p>Build: <code>{host.buildRevision}</code>{host.testBuild ? ' · Isolated test installation' : ''}</p></details>
				<div class="actions"><button class="secondary" disabled={!!busy} onclick={() => run('Stopping community and quitting', async () => { await hostCommand('host_quit'); })}>Quit Wabi</button></div><p class="small">Quit safely stops this computer’s community and closes Wabi.</p>
			</section>
		{/if}
	{/if}
	{#if pending}
		<BaseModal isOpen onClose={() => { if (!busy) { pending = null; simpleInviteRequested = false; } }} showCloseButton={false} title={pending === 'lan' ? 'Allow connections from your LAN?' : pending === 'restore' ? 'Restore this snapshot?' : 'Pause community connections?'}>
		<div class="confirmation">
			<p>{pending === 'lan' ? 'This opens an unencrypted HTTP listener on this computer. Only continue on a trusted private network. People on that network can reach the login page; they still need an account or invitation. Router forwarding, HTTPS and calls are separate.' : pending === 'restore' ? 'Current members will disconnect. The selected snapshot becomes the active community; the previous data is kept for recovery. Changes made after the snapshot remain only in that preserved copy.' : pending === 'backup' ? 'Members will briefly disconnect while a complete backup is copied and verified. Hosting resumes afterward if it was running.' : pending === 'stop' ? 'Members will disconnect until you start hosting again. Your saved community stays on this computer.' : 'Members will briefly disconnect while the server restarts. Saved data stays in place.'}</p>
			<div class="row actions"><button disabled={!!busy} onclick={confirmAction}>{pending === 'lan' ? 'Enable LAN sharing' : 'Continue'}</button><button class="secondary" disabled={!!busy} onclick={() => { pending = null; simpleInviteRequested = false; }}>Cancel</button></div>
		</div>
		</BaseModal>
	{/if}
	<footer><a href="/">Back to Wabi</a></footer>
</main>

<style>
	.invitation-qr {
		display: block;
		max-width: 100%;
		height: auto;
		margin: 1rem 0;
		border-radius: 0.75rem;
	}
</style>
