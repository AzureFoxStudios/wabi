<script lang="ts">
	/**
	 * Settings › Admin (admins only, §8.9): who can join, a short overview, and doors into the
	 * admin dashboard. "Who can join" saves the same auth_policy the first-run wizard writes, so the
	 * wizard's "You can change this later in Settings" is true.
	 */
	import { createEventDispatcher, onMount } from 'svelte';
	import { _ as t } from '$lib/i18n';
	import { currentUser, channels, users, connected } from '$lib/socket';
	import { getAuthToken } from '$lib/authSession';
	import { getAdminPolicy, saveAdminPolicy } from '$lib/api';
	import type { AdminSection } from '$lib/adminNavigation';
	import Icon from '../ui/Icon.svelte';
	import Segmented from '../ui/Segmented.svelte';
	import Switch from '../ui/Switch.svelte';
	import { guestSwitchAvailable, guestsAllowed, joinModeOf, needsEmailCheck, policyForJoinMode, type AuthPolicy, type JoinMode } from './adminJoinPolicy';

	const dispatch = createEventDispatcher<{ openDashboard: { section: AdminSection } }>();
	const canManageAdmin = $derived(['owner', 'admin'].includes($currentUser?.highestRole ?? ''));
	const destinations: Array<{ section: AdminSection; title: string; description: string }> = [
		{ section: 'users', title: 'People', description: 'Find members, manage roles, and help someone regain access.' },
		{ section: 'branding', title: 'Server identity', description: 'The name, icon and banner people see for this server.' },
		{ section: 'roles', title: 'Roles', description: 'The permission levels this server has.' },
		{ section: 'runtime', title: 'Server health', description: 'How the running server is doing.' }
	];

	// ── Who can join (auth_policy) ──
	let policy = $state<AuthPolicy | null>(null);
	let policyState = $state<'loading' | 'ready' | 'error'>('loading');
	let policySaving = $state(false);
	let policyNote = $state<{ text: string; error: boolean } | null>(null);

	const label = (key: string, fallback: string) => {
		const value = $t(key);
		return value && value !== key ? value : fallback;
	};
	const joinMode = $derived(joinModeOf(policy));
	const canSwitchGuests = $derived(policyState === 'ready' && !policySaving && guestSwitchAvailable(policy));
	const roleWord = $derived(
		$currentUser?.highestRole ? $currentUser.highestRole.charAt(0).toUpperCase() + $currentUser.highestRole.slice(1) : 'Unknown'
	);

	async function loadPolicy(): Promise<void> {
		const token = getAuthToken();
		if (!token) {
			policyState = 'error';
			return;
		}
		policyState = 'loading';
		try {
			const result = await getAdminPolicy<AuthPolicy>(token, 'auth_policy');
			policy = { ...(result.defaults ?? {}), ...(result.config ?? {}) };
			policyState = 'ready';
		} catch (error) {
			console.warn('[Admin] auth policy did not load:', error);
			policyState = 'error';
		}
	}

	async function savePolicy(next: AuthPolicy): Promise<void> {
		const token = getAuthToken();
		if (!policy || !token || policySaving) return;
		const previous = policy;
		policy = next;
		policySaving = true;
		policyNote = null;
		try {
			const saved = await saveAdminPolicy<AuthPolicy>(token, 'auth_policy', next);
			policy = { ...next, ...(saved ?? {}) };
			policyNote = { text: 'Saved. It applies to the next person who tries to join.', error: false };
		} catch (error) {
			console.warn('[Admin] auth policy save failed:', error);
			policy = previous;
			policyNote = { text: "That change wasn't saved. Joining works as it did before.", error: true };
		} finally {
			policySaving = false;
		}
	}

	onMount(() => {
		if (canManageAdmin) void loadPolicy();
	});
</script>

{#if canManageAdmin}
	<section class="settings-block admin-join" aria-labelledby="admin-join-title" aria-busy={policyState === 'loading' || policySaving}>
		<h3 class="settings-block__title" id="admin-join-title">{label('login.wizard.join_title', 'Who can join this server?')}</h3>
		{#if policyState === 'ready' && policy}
			<div class="w-srows">
				<div class="w-srow">
					<div class="w-srow__text">
						<p class="w-srow__label" id="admin-join-mode">New accounts</p>
						<p class="w-srow__hint">
							{#if joinMode === 'open'}
								{label('login.wizard.join_open_desc', 'Anyone who reaches this server can create an account.')}
							{:else if joinMode === 'invite'}
								People need an invite link to create an account.
							{:else if joinMode === 'unsupported'}
								This server is set to check email first, which this version can't do, so no one can join. Choose who can join to fix it.
							{:else}
								{label('login.wizard.join_closed_desc', 'No one else can create an account on this server.')} Invite links can't create accounts either.
							{/if}
						</p>
					</div>
					<div class="w-srow__control">
						<Segmented
							labelledby="admin-join-mode"
							options={[
								{ value: 'open', label: label('login.wizard.join_open_label', 'Open') },
								{ value: 'invite', label: 'Invite only' },
								{ value: 'closed', label: label('login.wizard.join_closed_label', 'Closed') }
							]}
							value={joinMode}
							disabled={policyState !== 'ready' || policySaving}
							onchange={(value) => policy && void savePolicy(policyForJoinMode(policy, value as JoinMode))}
						/>
					</div>
				</div>
				<div class="w-srow">
					<div class="w-srow__text">
						<p class="w-srow__label" id="admin-join-guest">{label('login.wizard.join_guest_label', 'Allow guest access')}</p>
						<p class="w-srow__hint" id="admin-join-guest-hint">
							{#if policy && needsEmailCheck(policy)}
								Choose who can join first.
							{:else if policy && !guestSwitchAvailable(policy)}
								{joinMode === 'invite' ? "Invite-only servers don't take guests." : "This server doesn't take guests while it's closed."}
							{:else}
								{label('login.wizard.join_guest_desc', 'Let people join as temporary guests without an account.')}
							{/if}
						</p>
					</div>
					<div class="w-srow__control">
						<Switch
							labelledby="admin-join-guest"
							describedby="admin-join-guest-hint"
							checked={guestsAllowed(policy)}
							disabled={!canSwitchGuests}
							onchange={(on) => policy && void savePolicy({ ...policy, allowGuest: on })}
						/>
					</div>
				</div>
			</div>
		{:else if policyState === 'loading'}
			<p class="admin-join__note" role="status">Checking who can join…</p>
		{/if}
		{#if policyState === 'error'}
			<div class="w-notice admin-join__notice" role="alert">
				<Icon name="alert" />
				<p class="w-notice__title">The join setting didn't load</p>
				<p class="w-notice__text">Joining works as it did before.</p>
				<button type="button" class="w-btn w-btn--sm" onclick={loadPolicy}>Retry</button>
			</div>
		{:else if policyNote}
			<p class="admin-join__note" class:is-error={policyNote.error} role={policyNote.error ? 'alert' : 'status'}>{policyNote.text}</p>
		{/if}
	</section>

	<section class="settings-block admin-launcher" aria-labelledby="admin-launcher-title">
		<h3 class="settings-block__title" id="admin-launcher-title">Server overview</h3>
		<p class="settings-block__hint">{$connected ? 'Connected to your community.' : 'Offline. Counts are from the last connection.'}</p>
		<dl class="admin-summary">
			<div><dt>Online in your roster</dt><dd>{$users.filter((user) => ['active', 'away', 'busy'].includes(user.status)).length}</dd></div>
			<div><dt>Channels you can see</dt><dd>{$channels.length}</dd></div>
			<div><dt>Your role</dt><dd class="admin-summary__word">{roleWord}</dd></div>
		</dl>
		<div class="admin-destinations">
			{#each destinations as destination (destination.section)}
				<button class="admin-destination" type="button" onclick={() => dispatch('openDashboard', { section: destination.section })}>
					<span class="admin-destination__text">
						<span class="admin-destination__title">{destination.title}</span>
						<span class="admin-destination__hint">{destination.description}</span>
					</span>
					<Icon name="chevRight" size={18} />
				</button>
			{/each}
		</div>
	</section>
{/if}

<style>
	.admin-join__notice {
		margin-top: 12px;
	}
	.admin-join__note {
		margin: 10px 0 0;
		color: var(--w-mute);
		font: var(--w-t-small);
	}
	.admin-join__note.is-error {
		color: var(--w-danger);
	}
	.admin-summary {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
		margin: 16px 0 0;
		border-top: var(--w-bw) solid var(--w-line);
		border-bottom: var(--w-bw) solid var(--w-line);
	}
	.admin-summary > div {
		display: grid;
		gap: 4px;
		padding: 14px 16px 14px 0;
	}
	.admin-summary > div + div {
		padding-left: 16px;
		border-left: var(--w-bw) solid var(--w-line);
	}
	.admin-summary dt {
		order: 2;
		color: var(--w-faint);
		font: var(--w-t-kicker);
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}
	.admin-summary dd {
		margin: 0;
		color: var(--w-text);
		font: 400 calc(24px * var(--w-fs)) / calc(30px * var(--w-fs)) var(--w-mono);
		font-variant-numeric: tabular-nums;
	}
	.admin-summary dd.admin-summary__word {
		font: 600 calc(20px * var(--w-fs)) / calc(30px * var(--w-fs)) var(--w-serif);
	}
	.admin-destinations {
		display: grid;
		margin-top: 24px;
		border-top: var(--w-bw) solid var(--w-line);
	}
	.admin-destination {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		width: 100%;
		min-height: 64px;
		padding: 12px 4px 12px 0;
		border: 0;
		border-bottom: var(--w-bw) solid var(--w-line);
		background: transparent;
		color: var(--w-faint);
		text-align: left;
		cursor: pointer;
		transition: background-color var(--w-dur-1) var(--w-ease);
	}
	.admin-destination:hover {
		background: color-mix(in srgb, var(--w-raise) 70%, transparent);
	}
	:global(:root[data-char='contrast']) .admin-destination:hover {
		background: transparent;
		box-shadow: inset 0 0 0 1px var(--w-line-strong);
	}
	.admin-destination:focus-visible {
		outline: 2px solid var(--w-accent);
		outline-offset: -2px;
	}
	.admin-destination__text {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.admin-destination__title {
		color: var(--w-text);
		font: var(--w-t-label);
	}
	.admin-destination__hint {
		color: var(--w-mute);
		font: var(--w-t-small);
	}
	@media (max-width: 600px) {
		.admin-summary > div + div {
			padding-left: 0;
			border-left: 0;
			border-top: var(--w-bw) solid var(--w-line);
		}
	}
</style>
