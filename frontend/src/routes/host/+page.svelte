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
	import { _, currentLocale, getAvailableLocales, setAppLocale } from '$lib/i18n';
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
			if (!host.ready || host.setupRequired !== false || !host.localUrl) throw new Error($_('host_page.err_owner_saved'));
			settings = mode === 'configurable';
			message = $_('host_page.msg_ready');
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
		await run($_('host_page.busy_signing_in'), async () => {
			const result = await hostCommand<HostAccount>('host_account', { username: username.trim(), password, register: false });
			if (!host?.localUrl) throw new Error($_('host_page.err_community_stopped'));
			useCommunityAccount(host.localUrl, result, host.communityName || undefined);
			authRevision++; password = ''; message = $_('host_page.msg_signed_in');
		});
	}
	async function joinCommunity() {
		await run($_('host_page.busy_checking'), async () => {
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
			if (new URL(address).protocol === 'http:' && host?.sharing !== 'lan') throw new Error($_('host_page.err_enable_lan_addr'));
			if (!ownerToken) throw new Error($_('host_page.err_sign_in_owner'));
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
				if (invite === invitation) error = $_('host_page.err_qr');
			}
			if (invite !== invitation) return;
			message = $_('host_page.msg_invite_created', { values: { date: new Date(result.expiresAt * 1000).toLocaleString() } });
			choosingAddress = false;
			focusInvitationAfterUpdate = true;
	}
	async function createInvite() {
		await run($_('host_page.busy_creating_invite'), issueInvitation);
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
			message = lanAddresses.length ? $_('host_page.msg_choose_network') : $_('host_page.msg_no_network');
		}
	}
	async function simpleInvite() {
		if (host?.sharing !== 'lan') {
			simpleInviteRequested = true;
			pending = 'lan';
		} else await run($_('host_page.busy_creating_invite'), prepareLanInvitation);
	}
	async function copyInvite() {
		try { await navigator.clipboard.writeText(invite); copied = true; }
		catch { error = $_('host_page.err_clipboard'); }
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
		await run(action === 'restart' ? 'Starting your community' : $_('host_page.busy_updating'), async () => {
			if (action === 'backup') { host = await hostCommand<HostStatus>('host_backup', { confirm: true }); message = $_('host_page.msg_snapshot_saved'); }
			else if (action === 'restore') { host = await hostCommand<HostStatus>('host_restore', { id: restoring, confirm: true }); clearInvitation(); message = $_('host_page.msg_snapshot_restored'); }
			else if (action === 'stop') host = await hostCommand<HostStatus>('host_stop');
			else if (action === 'restart') host = await hostCommand<HostStatus>('host_restart');
			else host = await hostCommand<HostStatus>('host_sharing', { lan: action === 'lan', confirm: true });
			if (host.error) throw new Error(host.error);
			if (action === 'local') clearInvitation();
			if (inviteAfterSharing) await prepareLanInvitation();
		});
	}
</script>

<svelte:head><title>{$_('host_page.title')}</title><meta name="description" content={$_('host_page.meta_desc')} /></svelte:head>

<main class="desktop-communities">
	<header><p class="eyebrow">{$_('host_page.eyebrow')}</p><h1>{$_('host_page.h1')}</h1><p>{$_('host_page.intro')}</p>
		<label class="host-locale"><span>{$_('host_page.language')}</span>
			<select aria-label={$_('host_page.language')} value={$currentLocale || 'en'} onchange={(event) => setAppLocale((event.currentTarget as HTMLSelectElement).value)}>
				{#each getAvailableLocales() as localeOption}<option value={localeOption.code}>{localeOption.label}</option>{/each}
			</select>
		</label>
	</header>
	<nav class="community-nav" aria-label={$_('host_page.community_actions')}>
		<button aria-pressed={view === 'host'} onclick={() => { view = 'host'; settings = false; }}>{$_('host_page.nav_host')}</button>
		<button aria-pressed={view === 'join'} onclick={() => view = 'join'}>{$_('host_page.nav_join')}</button>
		<button aria-pressed={view === 'communities'} onclick={() => view = 'communities'}>{$_('host_page.nav_mine')}</button>
	</nav>
	{#if error || host?.error}<p class="notice error" role="alert">{error || host?.error}</p>{/if}
	{#if message}<p class="notice" role="status">{message}</p>{/if}
	{#if busy}<p role="status" aria-live="polite">{busy}…</p>{/if}

	{#if view === 'join'}
		<section class="community-card" aria-labelledby="join-title"><h2 id="join-title">{$_('host_page.nav_join')}</h2>
			<p>{$_('host_page.join_desc')}</p>
			<form onsubmit={(event) => { event.preventDefault(); void joinCommunity(); }}>
				<label for="join-address">{$_('host_page.join_address_label')}</label><input id="join-address" bind:value={join} placeholder="https://your-community.example" autocomplete="off" autocapitalize="none" spellcheck="false" required />
				<div class="actions"><button disabled={!!busy}>{$_('host_page.continue_community')}</button></div>
			</form><p class="small">{$_('host_page.join_note')}</p>
		</section>
	{:else if view === 'communities'}
		<section class="community-card" aria-labelledby="communities-title"><h2 id="communities-title">{$_('host_page.nav_mine')}</h2>
			{#if !loaded}<p role="status">{$_('host_page.checking')}</p>
			{:else if host?.hasCommunity}
				<ul class="community-list"><li><div class="community-description"><strong>{host.communityName || $_('host_page.community_on_computer')}</strong><p class="small"><span class="status" data-state={stateLabel}>{stateLabel}</span> · {host.sharing === 'lan' ? $_('host_page.lan_enabled') : $_('host_page.local_only')}</p></div><div class="row">
					<button disabled={!!busy || (host.running && !readyToOpen)} onclick={() => host?.running && host.localUrl ? openCommunity(host.localUrl) : start(true)}>{host.running ? $_('host_page.open_community') : $_('host_page.start_open')}</button>
					<button class="secondary" onclick={() => { view = 'host'; settings = true; }}>{$_('host_page.open_hosting_settings')}</button>
				</div></li></ul>
			{/if}
			{#if $savedServers.filter(server => server.url !== host?.localUrl).length}
				<ul class="community-list">{#each $savedServers.filter(server => server.url !== host?.localUrl) as server (server.url)}<li><div class="community-description"><strong>{server.effectiveName}</strong><p class="small">{server.lastUsername ? `@${server.lastUsername} · ` : ''}{server.url}</p></div><button class="secondary" disabled={!!busy} onclick={() => openCommunity(server.url)}>{$_('host_page.open_community')}</button></li>{/each}</ul>
			{:else if loaded && !host?.hasCommunity}<p>{$_('host_page.no_comm_1')} <strong>{$_('host_page.nav_host')}</strong> {$_('host_page.no_comm_2')} <strong>{$_('host_page.nav_join')}</strong> {$_('host_page.no_comm_3')}</p>{/if}
		</section>
	{:else}
		<section class="community-card" aria-labelledby="host-title"><h2 id="host-title">{existing ? host?.communityName || $_('host_page.your_local') : $_('host_page.host_on_computer')}</h2>
			{#if !loaded}<p role="status">{$_('host_page.checking')}</p>
			{:else if !available}<p>{$_('host_page.requires_desktop')}</p>
			{:else if !host}<p>{$_('host_page.retry_text')}</p><button class="secondary" onclick={refresh}>{$_('host_page.retry')}</button>
			{:else if !host.binaryAvailable}<p>{$_('host_page.missing_binary')}</p>
			{:else}
				<p class="status" data-state={stateLabel} role="status">{$_('host_page.server_status', { values: { state: stateLabel } })}</p>
				{#if !existing}
					{#if !mode}
						<p>{$_('host_page.setup_intro')}</p>
						<div class="hosting-modes">
							<button class="mode-choice secondary" onclick={() => mode = 'simple'}><strong>{$_('host_page.mode_simple')} <span class="small">{$_('host_page.recommended')}</span></strong><span>{$_('host_page.mode_simple_desc')}</span></button>
							<button class="mode-choice secondary" onclick={() => mode = 'configurable'}><strong>{$_('host_page.mode_config')}</strong><span>{$_('host_page.mode_config_desc')}</span></button>
						</div>
					{:else}
						<div class="row"><p>{mode === 'simple' ? $_('host_page.simple_setup') : $_('host_page.config_setup')}</p><button class="secondary" disabled={!!busy} onclick={() => mode = null}>{$_('host_page.change_setup')}</button></div>
					<p>{$_('host_page.setup_desc')}</p>
					<form onsubmit={(event) => { event.preventDefault(); void createCommunity(); }}>
						<label for="community-name">{$_('host_page.community_name')}</label><input id="community-name" bind:value={communityName} required maxlength="80" autocomplete="organization" placeholder={$_('host_page.community_ph')} />
						<label for="owner-name">{$_('host_page.owner_username')}</label><input id="owner-name" bind:value={username} required minlength="2" maxlength="64" autocomplete="username" autocapitalize="none" />
						<label for="owner-password">{$_('host_page.owner_password')}</label><input id="owner-password" type="password" bind:value={password} required minlength="8" autocomplete="new-password" />
						<label for="owner-confirm">{$_('host_page.repeat_password')}</label><input id="owner-confirm" type="password" bind:value={confirmation} required minlength="8" autocomplete="new-password" />
						<details class="starter-channels"><summary>{$_('host_page.starting_channels')}</summary><p class="small">{$_('host_page.channels_hint')}</p>
							<label for="host-starter-layout">{$_('host_page.layout')}</label><select id="host-starter-layout" value={starterTemplate} onchange={event => chooseStarterTemplate(event.currentTarget.value as typeof starterTemplate)} disabled={!!busy}><option value="basic">{$_('host_page.layout_basic')}</option><option value="project">{$_('host_page.layout_project')}</option><option value="community">{$_('host_page.layout_community')}</option><option value="blank">{$_('host_page.layout_blank')}</option></select>
							{#each starterChannels as channel, index (index)}<div class="starter-channel-row"><select bind:value={channel.kind} aria-label={$_('host_page.room_type')} disabled={!!busy}><option value="text">{$_('host_page.text')}</option><option value="voice">{$_('host_page.voice')}</option></select><input bind:value={channel.name} aria-label={$_('host_page.room_name')} maxlength="40" required disabled={!!busy} /><button type="button" class="secondary" onclick={() => starterChannels = starterChannels.filter((_, item) => item !== index)} disabled={!!busy}>{$_('host_page.remove')}</button></div>{/each}
							{#if starterChannels.length < 12}<button type="button" class="secondary" onclick={() => starterChannels = [...starterChannels, { name: '', kind: 'text' }]} disabled={!!busy}>{$_('host_page.add_room')}</button>{/if}
						</details>
						<div class="actions"><button disabled={!!busy}>{$_('host_page.host_server')}</button></div>
					</form><p class="small">{$_('host_page.keep_password')}</p>
					{/if}
				{:else}
					<p>{host.sharing === 'lan' ? $_('host_page.lan_enabled_desc') : $_('host_page.local_only_desc')}</p>
					<div class="row actions">
						{#if !host.running}<button disabled={!!busy} onclick={() => start(true)}>{$_('host_page.start_open')}</button>{:else}<button disabled={!!busy || !readyToOpen} onclick={() => host?.localUrl && openCommunity(host.localUrl)}>{$_('host_page.open_community')}</button>{/if}
						{#if settings}
					<button class="secondary" disabled={!!busy || !host.running} onclick={() => pending = 'stop'}>{$_('host_page.stop')}</button><button class="secondary" disabled={!!busy || !host.running} onclick={() => pending = 'restart'}>{$_('host_page.restart')}</button>
						<button class="secondary" disabled={!!busy} onclick={() => pending = 'backup'}>{$_('host_page.backup')}</button>
						{/if}
						{#if !settings}<button class="secondary" onclick={() => settings = true}>{$_('host_page.open_hosting_settings')}</button>{/if}
					</div>
				{/if}
				<p class="small">{$_('host_page.close_window')} <strong>{$_('host_page.quit_safe')}</strong> {$_('host_page.sleep_note')} <strong>{$_('host_page.start_open')}</strong> {$_('host_page.restart_note_2')}</p>
			{/if}
		</section>
		{#if !settings && available && existing && host?.ready}
			<section class="community-card" aria-labelledby="simple-invite-title"><h2 id="simple-invite-title">{$_('host_page.invite_friend')}</h2>
				<p>{$_('host_page.invite_intro')}</p>
				{#if !ownerToken}
					<p>{$_('host_page.invite_need_owner')}</p>
				{:else if invite}
					<label for="invite-result">{$_('host_page.invite_link_label')}</label><textarea id="invite-result" readonly value={invite} rows="3"></textarea>
					{#if inviteQr}<img class="invitation-qr" src={inviteQr} alt={$_('host_page.qr_alt')} width="320" height="320" />{/if}
					<div class="row actions"><button id="copy-invitation" onclick={copyInvite}>{copied ? $_('host_page.copied') : $_('host_page.copy_invitation')}</button><button class="secondary" disabled={!!busy} onclick={simpleInvite}>{$_('host_page.invite_another')}</button></div>
					<p class="small">{$_('host_page.invite_same')}{inviteExpiresAt ? `${$_('host_page.expiring', { values: { date: new Date(inviteExpiresAt * 1000).toLocaleString() } })}` : ''}{$_('host_page.invite_note')}</p>
				{:else}
					{#if invitationWasExpired}<p class="notice" role="status">{$_('host_page.invite_expired')}</p>{/if}
					{#if choosingAddress && lanAddresses.length > 1}
						<form onsubmit={(event) => { event.preventDefault(); void createInvite(); }}>
							<label for="lan-address">{$_('host_page.lan_address_friend')}</label><select id="lan-address" bind:value={shareAddress} disabled={!!busy} required><option value="" disabled>{$_('host_page.choose_network_addr')}</option>{#each lanAddresses as address}<option value={address}>{address}</option>{/each}</select>
							<p class="small">{$_('host_page.several_networks')}</p>
							<div class="actions"><button disabled={!!busy || !shareAddress}>{$_('host_page.create_invitation')}</button></div>
						</form>
					{:else}<div class="actions"><button disabled={!!busy} onclick={simpleInvite}>{choosingAddress ? $_('host_page.find_network') : $_('host_page.create_invitation')}</button></div>{/if}
				{/if}
				<details><summary>{$_('host_page.outside_title')}</summary><p>{$_('host_page.outside_1')}</p><p>{$_('host_page.outside_2')}</p></details>
			</section>
		{/if}
		{#if settings && available && host?.hasCommunity}
			<section class="community-card" aria-labelledby="sharing-title"><h2 id="sharing-title">{$_('host_page.hosting_settings_title')}</h2>
				<p><strong>{host.sharing === 'lan' ? $_('host_page.lan_enabled') : $_('host_page.local_only')}</strong> · {$_('host_page.internet_not_config')}</p>
				{#if !host.ready || host.setupRequired !== false}<p>{$_('host_page.settings_need_start')}</p>
				{:else}
					<button class="secondary" disabled={!!busy} onclick={() => pending = host?.sharing === 'lan' ? 'local' : 'lan'}>{host.sharing === 'lan' ? $_('host_page.turn_off_lan') : $_('host_page.enable_lan')}</button>
					<p class="small">{$_('host_page.lan_warning')}</p>
					<form onsubmit={(event) => { event.preventDefault(); void createInvite(); }}>
						<label for="share-address">{$_('host_page.guest_address')}</label><input id="share-address" type="url" bind:value={shareAddress} disabled={!!busy} required placeholder="http://192.168.1.25:3001" />
						<p class="small">{$_('host_page.guest_hint')}</p>
						<label for="expiry">{$_('host_page.expiry_label')}</label><select id="expiry" bind:value={expiry} disabled={!!busy}><option value={1}>{$_('host_page.expires_1h')}</option><option value={24}>{$_('host_page.expires_24h')}</option><option value={168}>{$_('host_page.expires_7d')}</option></select>
						<div class="actions"><button disabled={!!busy || !ownerToken}>{$_('host_page.create_one_use')}</button></div>
					</form>
					{#if invitationWasExpired}<p class="notice" role="status">{$_('host_page.invite_expired')}</p>{/if}
					{#if invite}<label for="invite-result">{$_('host_page.invite_link_label')}</label><textarea id="invite-result" readonly value={invite} rows="3"></textarea>{#if inviteQr}<img class="invitation-qr" src={inviteQr} alt={$_('host_page.qr_alt')} width="320" height="320" />{/if}<div class="actions"><button id="copy-invitation" onclick={copyInvite}>{copied ? $_('host_page.copied') : $_('host_page.copy_invitation')}</button></div><p class="small">{$_('host_page.invite_same')}{inviteExpiresAt ? `${$_('host_page.expiring', { values: { date: new Date(inviteExpiresAt * 1000).toLocaleString() } })}` : ''}{$_('host_page.invite_note_2')}</p>{/if}
					<details open={!ownerToken}><summary>{$_('host_page.signin_summary')}</summary><form onsubmit={(event) => { event.preventDefault(); void signIn(); }}><label for="signin-name">{$_('host_page.owner_username')}</label><input id="signin-name" bind:value={username} required autocomplete="username" /><label for="signin-password">{$_('host_page.password_label')}</label><input id="signin-password" type="password" bind:value={password} required autocomplete="current-password" /><div class="actions"><button disabled={!!busy}>{$_('host_page.sign_in')}</button></div></form></details>
				{/if}
				<details><summary>{$_('host_page.connect_title')}</summary><p>{$_('host_page.connect_1')}</p><p>{$_('host_page.connect_2')}</p><p>{$_('host_page.connect_3')}</p></details>
			</section>
			<section class="community-card" aria-labelledby="data-title"><h2 id="data-title">{$_('host_page.data_title')}</h2><p>{$_('host_page.data_accounts')}</p><code>{host.dataDirectory}</code>
				<div class="row actions"><button class="secondary" disabled={!!busy} onclick={() => run($_('host_page.busy_opening_folder'), async () => { await hostCommand('host_open_folder'); })}>{$_('host_page.open_folder')}</button><button disabled={!!busy} onclick={() => pending = 'backup'}>{$_('host_page.backup')}</button></div>
				<p class="small">{$_('host_page.backup_note')} {$_('host_page.recovery_1')} <strong>{$_('host_page.stop')}</strong> {$_('host_page.recovery_2')} <strong>{$_('host_page.recovery_3')}</strong> {$_('host_page.recovery_4')} <code>host.json</code>, <code>data</code> {$_('host_page.and')} <code>backups</code>. {$_('host_page.snapshot_note')}</p>
				{#if host.backupIds.length}<label for="snapshot">{$_('host_page.saved_snapshots')}</label><select id="snapshot" bind:value={restoring}><option value="">{$_('host_page.choose_snapshot')}</option>{#each host.backupIds as id}<option value={id}>{id}</option>{/each}</select><div class="actions"><button class="secondary" disabled={!!busy || !restoring} onclick={() => pending = 'restore'}>{$_('host_page.restore_snapshot')}</button></div><p class="small">{$_('host_page.restore_note')}</p>{/if}
				<details><summary>{$_('host_page.connection_details')}</summary><p>{$_('host_page.address_here')} <code>{host.localUrl || $_('host_page.assigned_when_started')}</code></p><p>{$_('host_page.server_identity')} <code>{host.serverId || $_('host_page.created_first_start')}</code></p><p>{$_('host_page.logs')} <code>{host.logDirectory}</code></p><p>{$_('host_page.build')} <code>{host.buildRevision}</code>{host.testBuild ? ` · ${$_('host_page.isolated_test')}` : ''}</p></details>
				<div class="actions"><button class="secondary" disabled={!!busy} onclick={() => run($_('host_page.busy_quitting'), async () => { await hostCommand('host_quit'); })}>{$_('host_page.quit_app')}</button></div><p class="small">{$_('host_page.quit_note')}</p>
			</section>
		{/if}
	{/if}
	{#if pending}
		<BaseModal isOpen onClose={() => { if (!busy) { pending = null; simpleInviteRequested = false; } }} showCloseButton={false} title={pending === 'lan' ? $_('host_page.modal_lan') : pending === 'restore' ? $_('host_page.modal_restore') : $_('host_page.modal_pause')}>
		<div class="confirmation">
			<p>{pending === 'lan' ? $_('host_page.confirm_lan') : pending === 'restore' ? $_('host_page.confirm_restore') : pending === 'backup' ? $_('host_page.confirm_backup') : pending === 'stop' ? $_('host_page.confirm_stop') : $_('host_page.confirm_restart')}</p>
			<div class="row actions"><button disabled={!!busy} onclick={confirmAction}>{pending === 'lan' ? $_('host_page.enable_lan') : $_('host_page.continue')}</button><button class="secondary" disabled={!!busy} onclick={() => { pending = null; simpleInviteRequested = false; }}>{$_('host_page.cancel')}</button></div>
		</div>
		</BaseModal>
	{/if}
	<footer><a href="/">{$_('host_page.back')}</a></footer>
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
