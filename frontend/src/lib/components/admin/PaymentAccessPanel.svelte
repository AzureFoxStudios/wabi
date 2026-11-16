<script lang="ts">
	import { _ } from '$lib/i18n';
	import type { PaymentAccessPolicy, PaymentUserBlock } from '$lib/api';
	import { adminPaymentPoliciesMatch, adminPaymentRolesNeedReview, canonicalAdminPaymentRole, canSaveAdminPaymentPolicy, effectiveAdminPaymentRoles, retainedAdminPaymentRoles, reviewAdminPaymentRole, setAdminPaymentGuestAccess, setAdminPaymentRole } from '$lib/adminPaymentPolicy';

	let {
		paymentPolicy, publishedPaymentPolicy, paymentUserBlocks, paymentPolicyLoaded, paymentPolicyLoading,
		paymentPolicySaving, paymentPolicyError, paymentPolicySaveStatus, roleDefinitions,
		rolesLoading, rolesError, getRoleLabel, onPolicyChange, onRefresh, onSave, onDiscard, onRoleRetry, onOpenPeople
	}: {
		paymentPolicy: PaymentAccessPolicy;
		publishedPaymentPolicy: PaymentAccessPolicy | null;
		paymentUserBlocks: PaymentUserBlock[];
		paymentPolicyLoaded: boolean;
		paymentPolicyLoading: boolean;
		paymentPolicySaving: boolean;
		paymentPolicyError: string;
		paymentPolicySaveStatus: string;
		roleDefinitions: Array<{ roleName: string; displayName: string }>;
		rolesLoading: boolean;
		rolesError: string;
		getRoleLabel: (roleName?: string) => string;
		onPolicyChange: (policy: PaymentAccessPolicy) => void;
		onRefresh: () => void;
		onSave: () => void;
		onDiscard: () => void;
		onRoleRetry: () => void;
		onOpenPeople: () => void;
	} = $props();

	const ready = $derived(paymentPolicyLoaded && publishedPaymentPolicy !== null);
	const dirty = $derived(ready && !adminPaymentPoliciesMatch(paymentPolicy, publishedPaymentPolicy));
	const roleOptions = $derived(roleDefinitions.filter((role) => ['owner', 'admin', 'mod', 'member'].includes(role.roleName)));
	const rolesReady = $derived(!rolesLoading && !rolesError && roleOptions.length > 0);
	const busy = $derived(paymentPolicyLoading || paymentPolicySaving);
	const editable = $derived(ready && rolesReady && !busy);
	const canSave = $derived(rolesReady && canSaveAdminPaymentPolicy({ loaded: paymentPolicyLoaded, loading: paymentPolicyLoading, saving: paymentPolicySaving, draft: paymentPolicy, published: publishedPaymentPolicy }));
	const effectiveRoles = $derived(effectiveAdminPaymentRoles(paymentPolicy));
	const retainedRoles = $derived(retainedAdminPaymentRoles(paymentPolicy));
	const roleReviewRequired = $derived(adminPaymentRolesNeedReview(paymentPolicy));
	const guestEnabled = $derived(paymentPolicy.allowGuest && paymentPolicy.allowedRoleNames.includes('guest'));
	const liveSummary = $derived(!publishedPaymentPolicy ? '' : !publishedPaymentPolicy.enabled
		? $_('payment_access.liveoff')
		: effectiveAdminPaymentRoles(publishedPaymentPolicy).length === 0
			? $_('payment_access.livenobody')
			: $_('payment_access.liveon'));

	function change(next: PaymentAccessPolicy) { if (editable) onPolicyChange(next); }
	function submit(event: SubmitEvent) { event.preventDefault(); if (canSave) onSave(); }
</script>

<section class="payment-access" aria-labelledby="payment-access-title" aria-busy={busy}>
	<header class="payment-access-heading">
		<h3 id="payment-access-title">{$_('payment_access.title')}</h3>
		<p>{$_('payment_access.intro')}</p>
	</header>

	{#if !ready}
		{#if paymentPolicyError}
			<div class="payment-access-notice payment-access-error" role="alert">
				<p>{paymentPolicyError}</p>
				<p>{$_('payment_access.no_settings')}</p>
			</div>
			<button class="ui-btn ui-btn-secondary" type="button" onclick={onRefresh} disabled={busy}>{paymentPolicyLoading ? $_('common.loading') : $_('payment_access.retry_policy')}</button>
		{:else}
			<p class="payment-access-notice" role="status">{$_('payment_access.loading_policy')}</p>
		{/if}
	{:else}
		<p class="payment-access-live">{liveSummary}</p>
		{#if paymentPolicyError}<p class="payment-access-notice payment-access-error" role="alert">{paymentPolicyError}</p>{/if}
		{#if rolesError}
			<div class="payment-access-notice payment-access-error" role="alert">
				<p>{$_('payment_access.roles_error')}</p>
				<button class="ui-btn ui-btn-secondary" type="button" onclick={onRoleRetry} disabled={busy}>{$_('payment_access.retry_roles')}</button>
			</div>
		{:else if !rolesReady}<p class="payment-access-notice" role="status">{$_('payment_access.loading_roles')}</p>{/if}
		<form class="payment-access-form" onsubmit={submit}>
			<fieldset disabled={!editable}>
				<legend class="payment-access-legend">{$_('payment_access.server_access')}</legend>
					<label class="payment-access-choice payment-access-master">
						<input type="checkbox" class="ui-check" checked={paymentPolicy.enabled} onchange={(event) => change({ ...paymentPolicy, enabled: event.currentTarget.checked })} />
					<span><strong>{$_('payment_access.allow_new')}</strong><span>{$_('payment_access.allow_new_desc')}</span></span>
				</label>
			</fieldset>

			<fieldset disabled={!editable}>
				<legend class="payment-access-legend">{$_('payment_access.registered')}</legend>
				<p class="payment-access-help">{$_('payment_access.select_roles')}</p>
				<div class="payment-access-roles">
					{#each roleOptions as role (role.roleName)}
							<label class="payment-access-choice">
								<input type="checkbox" class="ui-check" checked={paymentPolicy.allowedRoleNames.includes(role.roleName)} onchange={(event) => change(setAdminPaymentRole(paymentPolicy, role.roleName, event.currentTarget.checked))} />
							<span>{getRoleLabel(role.roleName)}</span>
						</label>
					{/each}
				</div>
			</fieldset>

			{#if retainedRoles.length > 0}
				<div class="payment-access-notice">
					<p><strong>{$_('payment_access.other_names')}</strong></p>
					<p>{$_('payment_access.other_names_desc')}</p>
					{#if roleReviewRequired}
						<p>{$_('payment_access.review_names')}</p>
					{/if}
					{#each retainedRoles as storedName (storedName)}
						{@const suggestedRole = canonicalAdminPaymentRole(storedName)}
						{@const normalizedName = storedName.trim().toLowerCase()}
						<div class="payment-access-retained-role">
							<p>{$_('payment_access.saved_name')} <code>{JSON.stringify(storedName)}</code></p>
							<div class="payment-access-actions">
								{#if suggestedRole}
									<button class="ui-btn ui-btn-secondary" type="button" disabled={!editable} onclick={() => change(reviewAdminPaymentRole(paymentPolicy, storedName, 'use-built-in'))}>{$_('payment_access.use_role', { values: { role: getRoleLabel(suggestedRole) } })}</button>
								{/if}
								{#if storedName !== normalizedName && suggestedRole !== normalizedName}
									<button class="ui-btn ui-btn-secondary" type="button" disabled={!editable} onclick={() => change(reviewAdminPaymentRole(paymentPolicy, storedName, 'normalize'))}>{$_('payment_access.keep_as', { values: { name: normalizedName } })}</button>
								{/if}
								<button class="ui-btn ui-btn-danger-ghost" type="button" disabled={!editable} aria-label={$_('payment_access.remove_name_aria', { values: { name: storedName } })} onclick={() => change(reviewAdminPaymentRole(paymentPolicy, storedName, 'remove'))}>{$_('payment_access.remove_name')}</button>
							</div>
						</div>
					{/each}
				</div>
			{/if}

			<fieldset disabled={!editable}>
				<legend class="payment-access-legend">{$_('payment_access.guests')}</legend>
					<label class="payment-access-choice">
						<input type="checkbox" class="ui-check" checked={guestEnabled} onchange={(event) => change(setAdminPaymentGuestAccess(paymentPolicy, event.currentTarget.checked))} />
					<span><strong>{$_('payment_access.allow_guest')}</strong><span>{$_('payment_access.allow_guest_desc')}</span></span>
				</label>
			</fieldset>

			{#if paymentPolicy.enabled && effectiveRoles.length === 0}
				<p class="payment-access-notice">{$_('payment_access.none_recognized')}</p>
			{:else if !paymentPolicy.enabled && dirty}
				<p class="payment-access-notice">{$_('payment_access.turned_off_notice')}</p>
			{/if}

			<footer class="payment-access-footer">
				<p class="payment-access-save-state" role="status">{paymentPolicySaving ? $_('payment_access.saving') : roleReviewRequired ? $_('payment_access.review_before_change') : dirty ? $_('payment_access.unsaved') : paymentPolicySaveStatus || $_('payment_access.showing_saved')}</p>
				<div class="payment-access-actions">
					<button class="ui-btn ui-btn-secondary" type="button" onclick={onRefresh} disabled={busy || dirty}>{$_('network_health.refresh')}</button>
					<button class="ui-btn ui-btn-ghost" type="button" onclick={onDiscard} disabled={busy || !dirty}>{$_('payment_access.discard')}</button>
					<button class="ui-btn ui-btn-primary" type="submit" disabled={!canSave}>{paymentPolicySaving ? $_('community_roles.saving') : $_('payment_access.save_changes')}</button>
				</div>
			</footer>
		</form>

		<div class="payment-access-restrictions">
			<p><span class="payment-access-count">{paymentUserBlocks.length}</span> {$_(paymentUserBlocks.length === 1 ? 'payment_access.restriction_one' : 'payment_access.restriction_many')}</p>
			<button class="ui-btn ui-btn-secondary" type="button" onclick={onOpenPeople}>{$_('payment_access.manage_people')}</button>
		</div>
	{/if}
</section>

<style>
	.payment-access { display: grid; gap: 1.25rem; min-width: 0; color: var(--w-text); }
	.payment-access-heading h3 { margin: 0 0 0.5rem; color: var(--w-text); font-size: 1.2rem; text-wrap: balance; }
	.payment-access p { margin: 0; color: var(--w-mute); line-height: 1.6; text-wrap: pretty; overflow-wrap: anywhere; }
	.payment-access-heading p { max-width: 70ch; }
	.payment-access .payment-access-live { color: var(--w-text); }
	.payment-access-form { display: grid; gap: 1.25rem; min-width: 0; }
	.payment-access fieldset { display: grid; gap: 0.75rem; margin: 0; padding: 1rem; min-width: 0; border: 1px solid var(--w-line); border-radius: calc(14px * var(--w-rs, 1)); background: var(--w-raise); }
	.payment-access-legend { padding: 0 0.4rem; color: var(--w-text); font-weight: 600; }
	.payment-access .payment-access-help { font-size: 0.875rem; }
	.payment-access-roles { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr)); gap: 0.5rem; }
	.payment-access-retained-role button { overflow-wrap: anywhere; }
	.payment-access-choice { display: flex; flex-direction: row; align-items: center; gap: 0.75rem; min-height: 44px; min-width: 0; padding: 0.5rem; border-radius: calc(10px * var(--w-rs, 1)); cursor: pointer; }
	.payment-access-choice:hover { background: var(--w-raise); }
		.payment-access-choice .ui-check { width: 20px; height: 20px; flex: 0 0 20px; }
	.payment-access-choice > span { min-width: 0; overflow-wrap: anywhere; }
	.payment-access-choice strong { display: block; color: var(--w-text); font-weight: 600; line-height: 1.5; }
	.payment-access-choice span span { display: block; margin-top: 0.25rem; font-size: 0.875rem; color: var(--w-mute); line-height: 1.5; text-wrap: pretty; }
	.payment-access fieldset:disabled .payment-access-choice { cursor: default; opacity: 0.65; }
	.payment-access fieldset:disabled .payment-access-choice:hover { background: transparent; }
	.payment-access-notice { padding: 0.85rem 1rem; border-radius: calc(10px * var(--w-rs, 1)); background: var(--w-sink); border-inline-start: 3px solid var(--w-line-strong); }
	.payment-access .payment-access-error { color: var(--w-danger); border-inline-start-color: var(--w-danger); }
	.payment-access-error p { color: inherit; }
	.payment-access-error p + p, .payment-access-error button { margin-top: 0.65rem; }
	.payment-access-retained-role { display: grid; gap: 0.65rem; margin-top: 1rem; }
	.payment-access-footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 1rem; padding-top: 0.25rem; }
	.payment-access .payment-access-save-state { flex: 1 1 10rem; font-size: 0.875rem; }
		.payment-access-actions { display: flex; flex-wrap: wrap; gap: 0.65rem; }
		.payment-access :is(button, input):focus-visible { outline: 2px solid var(--w-accent); outline-offset: 2px; }
	.payment-access-restrictions { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 1rem; padding-top: 1rem; border-top: 1px solid var(--w-line); }
	.payment-access-count { font-variant-numeric: tabular-nums; }
	@media (max-width: 480px) { .payment-access-actions { width: 100%; } .payment-access-actions button { flex: 1 1 auto; } }
</style>
