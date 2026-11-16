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
	import { captureScope, request } from '$lib/workspaces/bridge';

	const dispatch = createEventDispatcher<{ openDashboard: { section: AdminSection } }>();
	const canManageAdmin = $derived(['owner', 'admin'].includes($currentUser?.highestRole ?? ''));
	const destinations: Array<{ section: AdminSection; title: string; description: string }> = [
		{ section: 'users', title: $t('places.people'), description: $t('ast.dest_people_desc') },
		{ section: 'branding', title: $t('ast.dest_identity'), description: $t('ast.dest_identity_desc') },
		{ section: 'roles', title: $t('lore_roles.roles_eyebrow'), description: $t('ast.dest_roles_desc') },
		{ section: 'runtime', title: $t('server_health.label'), description: $t('ast.dest_health_desc') }
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
		$currentUser?.highestRole ? $currentUser.highestRole.charAt(0).toUpperCase() + $currentUser.highestRole.slice(1) : $t('gallery.unknown_creator')
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
			policyNote = { text: $t('ast.policy_saved'), error: false };
		} catch (error) {
			console.warn('[Admin] auth policy save failed:', error);
			policy = previous;
			policyNote = { text: $t('ast.policy_not_saved'), error: true };
		} finally {
			policySaving = false;
		}
	}

	// ── Office tools (the server's sharing policy, moved here from the office host's band) ──
	type OfficeCapabilities = { documents: boolean; sheets: boolean; present: boolean; admin: boolean; officeConversion: boolean };
	let office = $state<OfficeCapabilities | null>(null);
	let officeState = $state<'loading' | 'ready' | 'error'>('loading');
	let officeSaving = $state(false);
	let officeNote = $state<{ text: string; error: boolean } | null>(null);

	async function loadOffice(): Promise<void> {
		officeState = 'loading';
		officeNote = null;
		try {
			const scope = await captureScope();
			office = await request<OfficeCapabilities>(scope, '/capabilities');
			officeState = 'ready';
		} catch (error) {
			console.warn('[Admin] office capabilities did not load:', error);
			officeState = 'error';
		}
	}

	async function saveOffice(next: { sheets: boolean; present: boolean }): Promise<void> {
		if (!office?.admin || officeSaving) return;
		const previous = office;
		office = { ...office, ...next };
		officeSaving = true;
		officeNote = null;
		try {
			const scope = await captureScope();
			office = await request<OfficeCapabilities>(scope, '/capabilities', next, 'PUT');
			officeNote = { text: $t('ast.office_saved'), error: false };
		} catch (error) {
			console.warn('[Admin] office capabilities save failed:', error);
			office = previous;
			officeNote = { text: $t('ast.office_not_saved'), error: true };
		} finally {
			officeSaving = false;
		}
	}

	onMount(() => {
		if (canManageAdmin) {
			void loadPolicy();
			void loadOffice();
		}
	});
</script>

{#if canManageAdmin}
	<section class="settings-block admin-join" aria-labelledby="admin-join-title" aria-busy={policyState === 'loading' || policySaving}>
		<h3 class="settings-block__title" id="admin-join-title">{label('login.wizard.join_title', 'Who can join this server?')}</h3>
		{#if policyState === 'ready' && policy}
			<div class="w-srows">
				<div class="w-srow">
					<div class="w-srow__text">
						<p class="w-srow__label" id="admin-join-mode">{$t('ast.new_accounts')}</p>
						<p class="w-srow__hint">
							{#if joinMode === 'open'}
								{label('login.wizard.join_open_desc', 'Anyone who reaches this server can create an account.')}
							{:else if joinMode === 'invite'}
								{$t('ast.invite_needed')}
							{:else if joinMode === 'unsupported'}
								{$t('ast.unsupported')}
							{:else}
								{label('login.wizard.join_closed_desc', 'No one else can create an account on this server.')} {$t('ast.invite_no_accounts')}
							{/if}
						</p>
					</div>
					<div class="w-srow__control">
						<Segmented
							labelledby="admin-join-mode"
							options={[
								{ value: 'open', label: label('login.wizard.join_open_label', 'Open') },
								{ value: 'invite', label: $t('ast.invite_only') },
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
								{$t('ast.guest_first')}
							{:else if policy && !guestSwitchAvailable(policy)}
								{joinMode === 'invite' ? $t('ast.invite_no_guests') : $t('ast.closed_no_guests')}
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
			<p class="admin-join__note" role="status">{$t('ast.checking_join')}</p>
		{/if}
		{#if policyState === 'error'}
			<div class="w-notice admin-join__notice" role="alert">
				<Icon name="alert" />
				<p class="w-notice__title">{$t('ast.join_failed')}</p>
				<p class="w-notice__text">{$t('ast.join_failed_text')}</p>
				<button type="button" class="w-btn w-btn--sm" onclick={loadPolicy}>{$t('common.retry')}</button>
			</div>
		{:else if policyNote}
			<p class="admin-join__note" class:is-error={policyNote.error} role={policyNote.error ? 'alert' : 'status'}>{policyNote.text}</p>
		{/if}
	</section>

	<section class="settings-block admin-office" aria-labelledby="admin-office-title" aria-busy={officeState === 'loading' || officeSaving}>
		<h3 class="settings-block__title" id="admin-office-title">{$t('addon.office_title')} <span class="w-tag w-tag--mat" title={$t('maturity.preview_title')}>{$t('maturity.preview')}</span></h3>
		<p class="settings-block__hint">{$t('ast.office_desc')}</p>
		{#if officeState === 'ready' && office}
			{#if office.admin}
				<div class="w-srows">
					<div class="w-srow">
						<div class="w-srow__text">
							<p class="w-srow__label" id="admin-office-sheets">{$t('ast.allow_sheets')}</p>
							<p class="w-srow__hint">{$t('ast.allow_sheets_desc')}</p>
						</div>
						<div class="w-srow__control">
							<Switch labelledby="admin-office-sheets" checked={office.sheets} disabled={officeSaving} onchange={(on) => office && void saveOffice({ sheets: on, present: office.present })} />
						</div>
					</div>
					<div class="w-srow">
						<div class="w-srow__text">
							<p class="w-srow__label" id="admin-office-present">{$t('ast.allow_present')}</p>
							<p class="w-srow__hint">{$t('ast.allow_present_desc')}</p>
						</div>
						<div class="w-srow__control">
							<Switch labelledby="admin-office-present" checked={office.present} disabled={officeSaving} onchange={(on) => office && void saveOffice({ sheets: office.sheets, present: on })} />
						</div>
					</div>
				</div>
			{:else}
				<p class="admin-join__note">{$t('ast.sheets_present', { values: { sheets: office.sheets ? $t('ast.on') : $t('ast.off'), present: office.present ? $t('ast.on') : $t('ast.off') } })}</p>
			{/if}
		{:else if officeState === 'loading'}
			<p class="admin-join__note" role="status">{$t('ast.checking_office')}</p>
		{/if}
		{#if officeState === 'error'}
			<div class="w-notice admin-join__notice" role="alert">
				<Icon name="alert" />
				<p class="w-notice__title">{$t('ast.office_failed')}</p>
				<p class="w-notice__text">{$t('ast.office_failed_text')}</p>
				<button type="button" class="w-btn w-btn--sm" onclick={loadOffice}>{$t('common.retry')}</button>
			</div>
		{:else if officeNote}
			<p class="admin-join__note" class:is-error={officeNote.error} role={officeNote.error ? 'alert' : 'status'}>{officeNote.text}</p>
		{/if}
	</section>

	<section class="settings-block admin-launcher" aria-labelledby="admin-launcher-title">
		<h3 class="settings-block__title" id="admin-launcher-title">{$t('ast.overview')}</h3>
		<p class="settings-block__hint">{$connected ? $t('ast.connected') : $t('ast.offline')}</p>
		<dl class="admin-summary">
			<div><dt>{$t('ast.online_roster')}</dt><dd>{$users.filter((user) => ['active', 'away', 'busy'].includes(user.status)).length}</dd></div>
			<div><dt>{$t('ast.channels_visible')}</dt><dd>{$channels.length}</dd></div>
			<div><dt>{$t('ast.your_role')}</dt><dd class="admin-summary__word">{roleWord}</dd></div>
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
