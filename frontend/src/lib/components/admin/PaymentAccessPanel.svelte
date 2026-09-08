<script lang="ts">
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
		? 'New payment requests are currently turned off.'
		: effectiveAdminPaymentRoles(publishedPaymentPolicy).length === 0
			? 'Nobody can currently create payment requests.'
			: 'Payment requests are enabled for the saved role selection.');

	function change(next: PaymentAccessPolicy) { if (editable) onPolicyChange(next); }
	function submit(event: SubmitEvent) { event.preventDefault(); if (canSave) onSave(); }
</script>

<section class="payment-access" aria-labelledby="payment-access-title" aria-busy={busy}>
	<header class="payment-access-heading">
		<h3 id="payment-access-title">Payment requests</h3>
		<p>Choose who can create a payment request on this server. Existing requests are not deleted when access changes.</p>
	</header>

	{#if !ready}
		{#if paymentPolicyError}
			<div class="payment-access-notice payment-access-error" role="alert">
				<p>{paymentPolicyError}</p>
				<p>No settings have been loaded. Nothing can be changed until the server responds.</p>
			</div>
			<button class="payment-access-button" type="button" onclick={onRefresh} disabled={busy}>{paymentPolicyLoading ? 'Loading…' : 'Retry loading policy'}</button>
		{:else}
			<p class="payment-access-notice" role="status">Loading payment policy…</p>
		{/if}
	{:else}
		<p class="payment-access-live">{liveSummary}</p>
		{#if paymentPolicyError}<p class="payment-access-notice payment-access-error" role="alert">{paymentPolicyError}</p>{/if}
		{#if rolesError}
			<div class="payment-access-notice payment-access-error" role="alert">
				<p>Permission roles could not be loaded. Your saved policy has not changed.</p>
				<button class="payment-access-button" type="button" onclick={onRoleRetry} disabled={busy}>Retry loading roles</button>
			</div>
		{:else if !rolesReady}<p class="payment-access-notice" role="status">Loading permission roles…</p>{/if}
		<form class="payment-access-form" onsubmit={submit}>
			<fieldset disabled={!editable}>
				<legend class="payment-access-legend">Server access</legend>
				<label class="payment-access-choice payment-access-master">
					<input type="checkbox" checked={paymentPolicy.enabled} onchange={(event) => change({ ...paymentPolicy, enabled: event.currentTarget.checked })} />
					<span><strong>Allow new payment requests</strong><span>Turn this off to pause new requests for everyone. Your role choices are kept.</span></span>
				</label>
			</fieldset>

			<fieldset disabled={!editable}>
				<legend class="payment-access-legend">Registered members</legend>
				<p class="payment-access-help">Select the roles allowed to create requests. Selecting none allows no registered members.</p>
				<div class="payment-access-roles">
					{#each roleOptions as role (role.roleName)}
						<label class="payment-access-choice">
							<input type="checkbox" checked={paymentPolicy.allowedRoleNames.includes(role.roleName)} onchange={(event) => change(setAdminPaymentRole(paymentPolicy, role.roleName, event.currentTarget.checked))} />
							<span>{getRoleLabel(role.roleName)}</span>
						</label>
					{/each}
				</div>
			</fieldset>

			{#if retainedRoles.length > 0}
				<div class="payment-access-notice">
					<p><strong>Other saved role names</strong></p>
					<p>These exact names are not recognized by this server and currently grant no access. They are kept unless you explicitly replace or remove them.</p>
					{#if roleReviewRequired}
						<p>Saving would change names with uppercase letters or outer spaces. Review those names below before saving any changes.</p>
					{/if}
					{#each retainedRoles as storedName (storedName)}
						{@const suggestedRole = canonicalAdminPaymentRole(storedName)}
						{@const normalizedName = storedName.trim().toLowerCase()}
						<div class="payment-access-retained-role">
							<p>Saved name: <code>{JSON.stringify(storedName)}</code></p>
							<div class="payment-access-actions">
								{#if suggestedRole}
									<button class="payment-access-button" type="button" disabled={!editable} onclick={() => change(reviewAdminPaymentRole(paymentPolicy, storedName, 'use-built-in'))}>Use {getRoleLabel(suggestedRole)} role</button>
								{/if}
								{#if storedName !== normalizedName && suggestedRole !== normalizedName}
									<button class="payment-access-button" type="button" disabled={!editable} onclick={() => change(reviewAdminPaymentRole(paymentPolicy, storedName, 'normalize'))}>Keep as {normalizedName}</button>
								{/if}
								<button class="payment-access-button" type="button" disabled={!editable} aria-label={`Remove saved role name ${storedName}`} onclick={() => change(reviewAdminPaymentRole(paymentPolicy, storedName, 'remove'))}>Remove saved name</button>
							</div>
						</div>
					{/each}
				</div>
			{/if}

			<fieldset disabled={!editable}>
				<legend class="payment-access-legend">Guests</legend>
				<label class="payment-access-choice">
					<input type="checkbox" checked={guestEnabled} onchange={(event) => change(setAdminPaymentGuestAccess(paymentPolicy, event.currentTarget.checked))} />
					<span><strong>Allow guest requests</strong><span>Guests can create requests only while server access is on. Individual restrictions still apply.</span></span>
				</label>
			</fieldset>

			{#if paymentPolicy.enabled && effectiveRoles.length === 0}
				<p class="payment-access-notice">No recognized roles are selected. After saving, nobody will be able to create a payment request.</p>
			{:else if !paymentPolicy.enabled && dirty}
				<p class="payment-access-notice">After saving, new requests will be turned off for everyone.</p>
			{/if}

			<footer class="payment-access-footer">
				<p class="payment-access-save-state" role="status">{paymentPolicySaving ? 'Saving policy…' : roleReviewRequired ? 'Review saved role names before making changes' : dirty ? 'Unsaved changes' : paymentPolicySaveStatus || 'Showing saved settings'}</p>
				<div class="payment-access-actions">
					<button class="payment-access-button" type="button" onclick={onRefresh} disabled={busy || dirty}>Refresh</button>
					<button class="payment-access-button" type="button" onclick={onDiscard} disabled={busy || !dirty}>Discard</button>
					<button class="payment-access-button payment-access-primary" type="submit" disabled={!canSave}>{paymentPolicySaving ? 'Saving…' : 'Save changes'}</button>
				</div>
			</footer>
		</form>

		<div class="payment-access-restrictions">
			<p><span class="payment-access-count">{paymentUserBlocks.length}</span> {paymentUserBlocks.length === 1 ? 'person has an' : 'people have an'} individual payment restriction.</p>
			<button class="payment-access-button" type="button" onclick={onOpenPeople}>Manage in People</button>
		</div>
	{/if}
</section>

<style>
	.payment-access { display: grid; gap: 1.25rem; min-width: 0; color: var(--text-primary); }
	.payment-access-heading h3 { margin: 0 0 0.5rem; color: var(--text-heading); font-size: 1.2rem; text-wrap: balance; }
	.payment-access p { margin: 0; color: var(--text-secondary); line-height: 1.6; text-wrap: pretty; overflow-wrap: anywhere; }
	.payment-access-heading p { max-width: 70ch; }
	.payment-access .payment-access-live { color: var(--text-heading); }
	.payment-access-form { display: grid; gap: 1.25rem; min-width: 0; }
	.payment-access fieldset { display: grid; gap: 0.75rem; margin: 0; padding: 1rem; min-width: 0; border: 1px solid var(--border-subtle); border-radius: var(--radius-lg); background: var(--surface-raised); }
	.payment-access-legend { padding: 0 0.4rem; color: var(--text-heading); font-weight: 600; }
	.payment-access .payment-access-help { font-size: 0.875rem; }
	.payment-access-roles { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr)); gap: 0.5rem; }
	.payment-access-retained-role button { overflow-wrap: anywhere; }
	.payment-access-choice { display: flex; flex-direction: row; align-items: center; gap: 0.75rem; min-height: 44px; min-width: 0; padding: 0.5rem; border-radius: var(--radius-md); cursor: pointer; }
	.payment-access-choice:hover { background: var(--surface-hover); }
	.payment-access-choice input { width: 20px; height: 20px; margin: 0; flex: 0 0 20px; accent-color: var(--accent-primary); }
	.payment-access-choice > span { min-width: 0; overflow-wrap: anywhere; }
	.payment-access-choice strong { display: block; color: var(--text-heading); font-weight: 600; line-height: 1.5; }
	.payment-access-choice span span { display: block; margin-top: 0.25rem; font-size: 0.875rem; color: var(--text-secondary); line-height: 1.5; text-wrap: pretty; }
	.payment-access fieldset:disabled .payment-access-choice { cursor: default; opacity: 0.65; }
	.payment-access fieldset:disabled .payment-access-choice:hover { background: transparent; }
	.payment-access-notice { padding: 0.85rem 1rem; border-radius: var(--radius-md); background: var(--surface-sunken); border-inline-start: 3px solid var(--border-default); }
	.payment-access .payment-access-error { color: var(--color-danger); border-inline-start-color: var(--color-danger); }
	.payment-access-error p { color: inherit; }
	.payment-access-error p + p, .payment-access-error button { margin-top: 0.65rem; }
	.payment-access-retained-role { display: grid; gap: 0.65rem; margin-top: 1rem; }
	.payment-access-footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 1rem; padding-top: 0.25rem; }
	.payment-access .payment-access-save-state { flex: 1 1 10rem; font-size: 0.875rem; }
	.payment-access-actions { display: flex; flex-wrap: wrap; gap: 0.65rem; }
	.payment-access-button { min-width: 44px; min-height: 44px; padding: 0.65rem 0.9rem; background: var(--surface-raised); color: var(--text-primary); border: 1px solid var(--border-default); border-radius: var(--radius-md); font: inherit; font-size: 0.9rem; font-weight: 600; cursor: pointer; }
	.payment-access-button:not(:disabled):hover { background: var(--surface-hover); }
	.payment-access-primary { background: var(--accent-primary); border-color: var(--accent-primary); color: var(--text-on-accent, white); }
	.payment-access-primary:not(:disabled):hover { background: var(--accent-secondary); }
	.payment-access-button:disabled { opacity: 0.5; cursor: not-allowed; }
	.payment-access :is(button, input):focus-visible { outline: 2px solid var(--accent-secondary); outline-offset: 3px; }
	.payment-access-restrictions { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 1rem; padding-top: 1rem; border-top: 1px solid var(--border-subtle); }
	.payment-access-count { font-variant-numeric: tabular-nums; }
	@media (max-width: 480px) { .payment-access-actions { width: 100%; } .payment-access-actions button { flex: 1 1 auto; } }
</style>
