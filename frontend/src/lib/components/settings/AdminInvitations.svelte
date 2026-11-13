<!--
	Settings › Admin › "Invite someone": the browser's way to let one person in. It sits under
	"Who can join" because the two answer the same question. Only the owner can create or cancel
	invitations (the server's rule, core/crates/wabi-server/src/api/invites.rs); admins see why.

	The link is built from the address this app is using now. If a friend could not open it (this
	computer only, private network only, or plain HTTP on the internet), the page says so before
	anything is created or right next to the link.
-->
<script lang="ts">
	import { onDestroy } from 'svelte';
	import QRCode from 'qrcode';
	import { getAuthToken } from '$lib/authSession';
	import { getApiBase } from '$lib/api';
	import {
		DEFAULT_INVITE_HOURS,
		INVITE_LIFETIMES,
		createInvite,
		formatExpiry,
		invitationLink,
		inviteReach,
		listInvites,
		outstandingInvites,
		revokeInvite,
		timeLeft,
		type InviteRecord
	} from '$lib/invitations';
	import type { JoinModeState } from './adminJoinPolicy';
	import Icon from '../ui/Icon.svelte';
	import Segmented from '../ui/Segmented.svelte';

	interface Props {
		/** Only the owner may create or cancel invitations. */
		isOwner: boolean;
		/** The server's current admission mode, to warn when invitations cannot admit anyone. */
		joinMode: JoinModeState | null;
	}
	let { isOwner, joinMode }: Props = $props();

	const server = getApiBase();
	const reach = inviteReach(server);
	const host = (() => {
		try { return new URL(server).host; } catch { return server; }
	})();

	let hours = $state<number>(DEFAULT_INVITE_HOURS);
	let invites = $state<InviteRecord[]>([]);
	let listState = $state<'idle' | 'loading' | 'ready' | 'error'>('idle');
	let busy = $state(false);
	let error = $state('');
	let created = $state<{ id: string; link: string; expiresAt: number; qr: string } | null>(null);
	let copied = $state(false);
	let now = $state(Math.floor(Date.now() / 1000));
	const clock = setInterval(() => (now = Math.floor(Date.now() / 1000)), 30_000);
	onDestroy(() => clearInterval(clock));

	const canCreate = $derived(isOwner && (reach === 'anywhere' || reach === 'network'));
	const waiting = $derived(outstandingInvites(invites, now));
	const createdExpired = $derived(created ? created.expiresAt <= now : false);

	async function refresh(): Promise<void> {
		const token = getAuthToken();
		if (!token) { listState = 'error'; return; }
		listState = 'loading';
		try {
			invites = await listInvites(server, token);
			listState = 'ready';
		} catch (cause) {
			console.warn('[Invitations] list failed:', cause);
			listState = 'error';
		}
	}

	async function create(): Promise<void> {
		const token = getAuthToken();
		if (!token || busy || !canCreate) return;
		busy = true; error = ''; copied = false;
		try {
			const result = await createInvite(server, token, hours);
			const link = invitationLink(server, result.token);
			created = { id: result.id, link, expiresAt: result.expiresAt, qr: '' };
			void refresh();
			try {
				const qr = await QRCode.toDataURL(link, { width: 280, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
				if (created?.link === link) created = { ...created, qr };
			} catch {
				// The link and the copy button still work; a QR is a convenience.
			}
		} catch (cause) {
			error = cause instanceof Error ? cause.message : "The invitation wasn't created.";
		} finally {
			busy = false;
		}
	}

	async function copy(): Promise<void> {
		if (!created) return;
		error = '';
		try {
			// navigator.clipboard exists only in secure contexts (HTTPS or localhost); a server on
			// a home network over plain HTTP has none, so fall back to copying the selected field.
			if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(created.link);
			else if (!copySelectedField()) throw new Error('copy refused');
			copied = true;
		} catch {
			if (copySelectedField()) { copied = true; return; }
			error = "This browser didn't allow copying. The link is selected: copy it with your keyboard or the right-click menu.";
		}
	}

	function copySelectedField(): boolean {
		const field = document.getElementById('invite-link') as HTMLInputElement | null;
		if (!field) return false;
		field.focus();
		field.select();
		try { return document.execCommand('copy'); } catch { return false; }
	}

	async function cancel(id: string): Promise<void> {
		const token = getAuthToken();
		if (!token || busy) return;
		busy = true; error = '';
		try {
			await revokeInvite(server, token, id);
			if (created?.id === id) created = null;
			await refresh();
		} catch (cause) {
			error = cause instanceof Error ? cause.message : "That invitation wasn't cancelled.";
		} finally {
			busy = false;
		}
	}

	$effect(() => {
		if (isOwner && listState === 'idle') void refresh();
	});
</script>

<section class="settings-block admin-invite" aria-labelledby="admin-invite-title" aria-busy={busy || listState === 'loading'}>
	<h3 class="settings-block__title" id="admin-invite-title">Invite someone</h3>
	<p class="settings-block__hint">An invitation is a link that lets one person create an account here.</p>

	{#if !isOwner}
		<p class="admin-invite__note">Only the server owner can create invitations.</p>
	{:else}
		{#if joinMode === 'closed' || joinMode === 'unsupported'}
			<div class="w-notice w-notice--warn admin-invite__notice" role="note">
				<Icon name="warn" />
				<p class="w-notice__title">Invitations won't work while this server is closed</p>
				<p class="w-notice__text">Choose Invite only or Open above first. A friend who opens a link now is told the server isn't taking new accounts.</p>
			</div>
		{/if}

		{#if reach === 'this-device'}
			<div class="w-notice w-notice--info admin-invite__notice" role="note" data-reach="this-device">
				<Icon name="info" />
				<p class="w-notice__title">A link made here would only work on this computer</p>
				<p class="w-notice__text">You're using Wabi at <strong>{host}</strong>, which always means "this computer", so a friend's device would try to open itself. Open Wabi using this computer's network address (for example <span class="admin-invite__mono">http://192.168.1.20{host.includes(':') ? host.slice(host.lastIndexOf(':')) : ''}</span>) or its HTTPS address, then create the invitation there.</p>
			</div>
		{:else if reach === 'needs-https'}
			<div class="w-notice w-notice--warn admin-invite__notice" role="note" data-reach="needs-https">
				<Icon name="warn" />
				<p class="w-notice__title">This address needs HTTPS before you can invite anyone</p>
				<p class="w-notice__text">You're using Wabi at <strong>{host}</strong> over plain HTTP. A friend's browser refuses invitations to an internet address without HTTPS, so a link from here would not work. Set up HTTPS (see "Inviting someone" in the install guide), or use the server's private network address instead.</p>
			</div>
		{/if}

		{#if canCreate}
			<div class="admin-invite__create">
				<div class="admin-invite__field">
					<p class="w-srow__label" id="admin-invite-lifetime">Link lasts</p>
					<Segmented
						labelledby="admin-invite-lifetime"
						options={INVITE_LIFETIMES.map((choice) => ({ value: choice.hours as number, label: choice.label }))}
						value={hours}
						disabled={busy}
						onchange={(value) => (hours = Number(value))}
					/>
				</div>
				<button type="button" class="w-btn w-btn--primary admin-invite__go" disabled={busy} onclick={create}>
					<Icon name="userPlus" />{busy && !created ? 'Creating…' : 'Create invitation'}
				</button>
			</div>
		{/if}

		{#if error}
			<p class="admin-invite__note is-error" role="alert">{error}</p>
		{/if}

		{#if created}
			<div class="admin-invite__result" data-invite-result>
				<label class="w-srow__label" for="invite-link">Invitation link</label>
				<div class="admin-invite__linkrow">
					<input id="invite-link" class="w-field admin-invite__link" readonly value={created.link} onfocus={(event) => event.currentTarget.select()} />
					<button type="button" class="w-btn" onclick={copy}><Icon name={copied ? 'check' : 'copy'} />{copied ? 'Copied' : 'Copy link'}</button>
				</div>
				<p class="admin-invite__facts" data-invite-facts>
					{#if createdExpired}
						This link has expired. Create a new one.
					{:else}
						Works once, for one person. Expires {formatExpiry(created.expiresAt)} ({timeLeft(created.expiresAt, now)}).
					{/if}
				</p>
				{#if reach === 'network'}
					<p class="admin-invite__reach" data-reach="network"><Icon name="info" size={16} /><span><strong>This link only works for people on your network</strong> (the same Wi-Fi or office network, or a VPN to it), because {host} is a private address. Someone elsewhere on the internet can't open it.</span></p>
				{/if}
				{#if created.qr}
					<img class="admin-invite__qr" src={created.qr} alt="QR code of the invitation link" width="200" height="200" />
				{/if}
				<p class="admin-invite__note">Send it privately: whoever opens it first can join. You can't see this link again after you leave this page; cancel it below and create a new one if it is lost.</p>
				<button type="button" class="w-btn w-btn--quiet w-btn--sm" onclick={() => { created = null; copied = false; }}>Done</button>
			</div>
		{/if}

		<div class="admin-invite__list">
			<p class="w-srow__label" id="admin-invite-waiting">Waiting to be used</p>
			{#if listState === 'loading' && invites.length === 0}
				<p class="admin-invite__note" role="status">Checking invitations…</p>
			{:else if listState === 'error'}
				<div class="w-notice admin-invite__notice" role="alert">
					<Icon name="alert" />
					<p class="w-notice__title">The invitation list didn't load</p>
					<button type="button" class="w-btn w-btn--sm" onclick={refresh}>Retry</button>
				</div>
			{:else if waiting.length === 0}
				<p class="admin-invite__note">No invitations are waiting. Used, cancelled and expired ones stop working on their own.</p>
			{:else}
				<ul class="admin-invite__rows" aria-labelledby="admin-invite-waiting">
					{#each waiting as invite (invite.id)}
						<li class="admin-invite__row" data-invite-id={invite.id}>
							<span class="admin-invite__rowtext">
								<span>{created?.id === invite.id ? 'The link above' : 'Invitation link'}</span>
								<span class="admin-invite__rowhint">Expires {formatExpiry(invite.expiresAt)} · {timeLeft(invite.expiresAt, now)}</span>
							</span>
							<button type="button" class="w-btn w-btn--sm w-btn--danger" disabled={busy} onclick={() => cancel(invite.id)}>Cancel invitation</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}
</section>

<style>
	.admin-invite__notice {
		margin-top: 12px;
	}
	.admin-invite__note {
		margin: 10px 0 0;
		color: var(--w-mute);
		font: var(--w-t-small);
	}
	.admin-invite__note.is-error {
		color: var(--w-danger);
	}
	.admin-invite__mono {
		font-family: var(--w-mono);
	}
	.admin-invite__create {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		justify-content: space-between;
		gap: 12px 24px;
		padding: 14px 0;
		border-top: var(--w-bw) solid var(--w-line);
		border-bottom: var(--w-bw) solid var(--w-line);
	}
	.admin-invite__field {
		display: grid;
		gap: 8px;
	}
	.admin-invite__result {
		display: grid;
		gap: 10px;
		justify-items: start;
		padding: 16px 0;
		border-bottom: var(--w-bw) solid var(--w-line);
	}
	.admin-invite__linkrow {
		display: flex;
		gap: 8px;
		width: 100%;
	}
	.admin-invite__link {
		flex: 1;
		font-family: var(--w-mono);
		font-size: calc(13px * var(--w-fs));
	}
	.admin-invite__facts {
		margin: 0;
		color: var(--w-text);
		font: var(--w-t-small);
	}
	.admin-invite__reach {
		display: flex;
		gap: 8px;
		margin: 0;
		color: var(--w-text);
		font: var(--w-t-small);
	}
	.admin-invite__reach > :global(svg) {
		flex: none;
		margin-top: 2px;
		color: var(--w-warn, var(--w-mute));
	}
	/* A QR code is a functional image: dark on light in every theme so cameras can read it. */
	.admin-invite__qr {
		width: 200px;
		height: 200px;
		border-radius: var(--radius-md);
		image-rendering: pixelated;
	}
	.admin-invite__list {
		display: grid;
		gap: 8px;
		padding-top: 16px;
	}
	.admin-invite__rows {
		display: grid;
		margin: 0;
		padding: 0;
		list-style: none;
		border-top: var(--w-bw) solid var(--w-line);
	}
	.admin-invite__row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		min-height: 56px;
		padding: 8px 0;
		border-bottom: var(--w-bw) solid var(--w-line);
	}
	.admin-invite__rowtext {
		display: grid;
		gap: 2px;
		min-width: 0;
		color: var(--w-text);
		font: var(--w-t-label);
	}
	.admin-invite__rowhint {
		color: var(--w-mute);
		font: var(--w-t-small);
	}
	@media (max-width: 600px) {
		.admin-invite__create {
			flex-direction: column;
			align-items: stretch;
		}
		.admin-invite__go {
			min-height: 44px;
			justify-content: center;
		}
		.admin-invite__linkrow {
			flex-direction: column;
		}
		.admin-invite__linkrow > .w-btn {
			min-height: 44px;
			justify-content: center;
		}
		.admin-invite__qr {
			justify-self: center;
		}
		.admin-invite__row {
			flex-wrap: wrap;
		}
	}
</style>
