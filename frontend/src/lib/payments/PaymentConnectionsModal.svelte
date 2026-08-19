<script lang="ts">
	import BaseModal from '../components/BaseModal.svelte';
	import { brandName } from '$lib/branding';
	import { getAuthToken } from '$lib/authSession';
	import {
		deletePaymentAccountLink,
		listPaymentAccountLinks,
		listPaymentProviders,
		upsertPaymentAccountLink,
		type PaymentAccountLink,
		type PaymentProviderCapability
	} from '$lib/api';
	import { subscribePaymentRealtimeEvent } from '$lib/payments/paymentRealtime';

	let {
		isOpen = false,
		onClose = () => {},
		overlayZIndex = null
	}: {
		isOpen?: boolean;
		onClose?: () => void;
		overlayZIndex?: number | string | null;
	} = $props();

	let loadingProviders = $state(false);
	let loadingLinks = $state(false);
	let providersLoaded = $state(false);
	let linksLoaded = $state(false);
	let providersError = $state('');
	let linksError = $state('');
	let actionInfo = $state('');
	let actionError = $state('');
	let savingPluginId = $state('');
	let providers = $state<PaymentProviderCapability[]>([]);
	let paymentAccountLinks = $state<PaymentAccountLink[]>([]);
	let editorRefs = $state<Record<string, string>>({});
	let editorLabels = $state<Record<string, string>>({});

	const unsubscribeAccountLinksRealtime = subscribePaymentRealtimeEvent('payments:account-links-updated', () => {
		if (!isOpen) return;
		linksLoaded = false;
		void loadAccountLinks();
	});

	$effect(() => () => unsubscribeAccountLinksRealtime());

	$effect(() => {
		if (isOpen && !providersLoaded) {
			void loadProviders();
		}
	});

	$effect(() => {
		if (isOpen && !linksLoaded) {
			void loadAccountLinks();
		}
	});

	$effect(() => {
		if (!isOpen) {
			providersLoaded = false;
			linksLoaded = false;
			providersError = '';
			linksError = '';
			actionInfo = '';
			actionError = '';
			savingPluginId = '';
		}
	});

	function getLinkedAccount(pluginId: string): PaymentAccountLink | null {
		return paymentAccountLinks.find((link) => link.pluginId === pluginId) || null;
	}

	function ensureEditorsInitialized(): void {
		const nextRefs = { ...editorRefs };
		const nextLabels = { ...editorLabels };
		let changed = false;

		for (const provider of providers) {
			const existing = getLinkedAccount(provider.pluginId);
			if (!(provider.pluginId in nextRefs)) {
				nextRefs[provider.pluginId] = existing?.providerAccountRef || '';
				changed = true;
			}
			if (!(provider.pluginId in nextLabels)) {
				nextLabels[provider.pluginId] = existing?.displayLabel || '';
				changed = true;
			}
		}

		if (changed) {
			editorRefs = nextRefs;
			editorLabels = nextLabels;
		}
	}

	function syncEditorsForPlugin(pluginId: string): void {
		const existing = getLinkedAccount(pluginId);
		editorRefs = {
			...editorRefs,
			[pluginId]: existing?.providerAccountRef || ''
		};
		editorLabels = {
			...editorLabels,
			[pluginId]: existing?.displayLabel || ''
		};
	}

	function formatMarkets(provider: PaymentProviderCapability): string {
		const countries = provider.countries.length > 0 ? provider.countries.join(', ') : 'Any region';
		const currencies = provider.currencies.length > 0 ? provider.currencies.join(', ') : 'Any currency';
		return `${countries} · ${currencies}`;
	}

	function formatMethods(provider: PaymentProviderCapability): string {
		if (provider.methods.length === 0) return 'No payment methods are currently exposed by this provider.';
		return provider.methods.map((method) => method.label).join(', ');
	}

	function getReferenceFieldLabel(provider: PaymentProviderCapability): string {
		if (provider.pluginId === 'promptpay' || provider.pluginId === 'th-payments') {
			return 'PromptPay number';
		}
		if (provider.pluginId === 'payments-crypto') {
			return 'Wallet address';
		}
		if (provider.pluginId === 'payments-eu') {
			return 'Your IBAN';
		}
		if (provider.pluginId === 'payments-us') {
			return 'US payment handle';
		}
		return 'Saved payment reference';
	}

	function getReferencePlaceholder(provider: PaymentProviderCapability): string {
		if (provider.pluginId === 'promptpay' || provider.pluginId === 'th-payments') {
			return 'Thai mobile number or PromptPay ID';
		}
		if (provider.pluginId === 'payments-crypto') {
			return '0x… / bc1… / TRX… wallet address';
		}
		if (provider.pluginId === 'payments-eu') {
			return 'DE… IBAN (22 chars, mod-97 valid)';
		}
		if (provider.pluginId === 'payments-us') {
			return '$Cashtag / @Venmo handle / email / routing-account';
		}
		return 'PromptPay number / wallet handle / PSP customer id';
	}

	function getDisplayLabelPlaceholder(provider: PaymentProviderCapability): string {
		if (provider.pluginId === 'promptpay' || provider.pluginId === 'th-payments') {
			return 'My PromptPay';
		}
		if (provider.pluginId === 'payments-crypto') {
			return 'Main wallet';
		}
		if (provider.pluginId === 'payments-eu') {
			return 'My bank account';
		}
		if (provider.pluginId === 'payments-us') {
			return 'Main US account';
		}
		return 'Main wallet / primary bank';
	}

	function getConnectionHelp(provider: PaymentProviderCapability): string {
		if (provider.pluginId === 'promptpay' || provider.pluginId === 'th-payments') {
			return 'For personal Thai QR requests, save your own PromptPay number here. Server donations use the server donation route separately. Stored with your account; also cached on this device.';
		}
		if (provider.pluginId === 'payments-crypto') {
			return `For crypto requests, save the wallet address that should receive the coins here. ${brandName} never holds the keys. Stored with your account; also cached on this device.`;
		}
		if (provider.pluginId === 'payments-eu') {
			return `For SEPA Instant requests, save the IBAN that should receive the money here. The QR is built from this IBAN. Stored with your account; also cached on this device.`;
		}
		if (provider.pluginId === 'payments-us') {
			return `For US app requests, save the handle that should receive the money here. Stored with your account; also cached on this device.`;
		}
		return `Optional. If you leave the advanced account field blank in a payment request, ${brandName} reuses this saved reference for this provider.`;
	}

	async function loadProviders(): Promise<void> {
		loadingProviders = true;
		providersError = '';
		try {
			providers = await listPaymentProviders();
			providersLoaded = true;
			ensureEditorsInitialized();
		} catch (error) {
			providersError = error instanceof Error ? error.message : 'Failed to load payment providers';
		} finally {
			loadingProviders = false;
		}
	}

	async function loadAccountLinks(): Promise<void> {
		const token = getAuthToken();
		if (!token) {
			paymentAccountLinks = [];
			linksLoaded = true;
			ensureEditorsInitialized();
			return;
		}

		loadingLinks = true;
		linksError = '';
		try {
			paymentAccountLinks = await listPaymentAccountLinks(token);
			linksLoaded = true;
			ensureEditorsInitialized();
		} catch (error) {
			linksError = error instanceof Error ? error.message : 'Failed to load saved payment references';
		} finally {
			loadingLinks = false;
		}
	}

	async function handleSave(pluginId: string): Promise<void> {
		actionInfo = '';
		actionError = '';
		const token = getAuthToken();
		if (!token) {
			actionError = 'You must be logged in to save a payment reference.';
			return;
		}

		const providerAccountRef = (editorRefs[pluginId] || '').trim();
		if (!providerAccountRef) {
			actionError = 'Enter a payment reference before saving.';
			return;
		}

		savingPluginId = pluginId;
		try {
			const saved = await upsertPaymentAccountLink(token, {
				pluginId,
				providerAccountRef,
				displayLabel: (editorLabels[pluginId] || '').trim() || undefined
			});
			paymentAccountLinks = [
				saved,
				...paymentAccountLinks.filter((link) => link.pluginId !== pluginId)
			];
			syncEditorsForPlugin(pluginId);
			actionInfo = `Saved payment reference for ${saved.pluginId}.`;
		} catch (error) {
			actionError = error instanceof Error ? error.message : 'Failed to save payment reference';
		} finally {
			savingPluginId = '';
		}
	}

	async function handleClear(pluginId: string): Promise<void> {
		actionInfo = '';
		actionError = '';
		const token = getAuthToken();
		if (!token) {
			actionError = 'You must be logged in to clear a saved payment reference.';
			return;
		}

		savingPluginId = pluginId;
		try {
			await deletePaymentAccountLink(token, pluginId);
			paymentAccountLinks = paymentAccountLinks.filter((link) => link.pluginId !== pluginId);
			syncEditorsForPlugin(pluginId);
			actionInfo = `Cleared payment reference for ${pluginId}.`;
		} catch (error) {
			actionError = error instanceof Error ? error.message : 'Failed to clear payment reference';
		} finally {
			savingPluginId = '';
		}
	}
</script>

<BaseModal
	{isOpen}
	onClose={onClose}
	width="760px"
	{overlayZIndex}
	title="Saved Payment References"
	subtitle={`Save a non-sensitive payment reference (e.g. your PromptPay number) once and ${brandName} reuses it for that rail. References are stored with your account on the server and cached on this device.`}
>
	<div class="sheet-body">
		{#if !getAuthToken()}
			<p class="error">Sign in with a registered account to manage saved payment references.</p>
		{/if}

		{#if loadingProviders || loadingLinks}
			<p class="hint">Loading saved payment references...</p>
		{/if}

		{#if providersError}
			<p class="error">{providersError}</p>
		{/if}

		{#if linksError}
			<p class="error">{linksError}</p>
		{/if}

		{#if actionInfo}
			<p class="info">{actionInfo}</p>
		{/if}

		{#if actionError}
			<p class="error">{actionError}</p>
		{/if}

		{#if !loadingProviders && providers.length === 0}
			<p class="hint">
				No payment rails are active on this server yet. Once the server owner enables a rail, it will appear here automatically for saved references.
			</p>
		{/if}

		<div class="provider-list">
			{#each providers as provider (provider.pluginId)}
				{@const linkedAccount = getLinkedAccount(provider.pluginId)}
				<div class="provider-card">
					<div class="provider-header">
						<div class="provider-copy">
							<h3>{provider.providerName}</h3>
							<p class="provider-meta">{provider.pluginId} · {formatMarkets(provider)}</p>
						</div>
						<span class:linked={Boolean(linkedAccount)} class="status-pill">
							{linkedAccount ? 'Saved' : 'Not saved'}
						</span>
					</div>

					{#if provider.notes}
						<p class="hint">{provider.notes}</p>
					{/if}

					<p class="hint">Available methods: {formatMethods(provider)}</p>
					<p class="hint">{getConnectionHelp(provider)}</p>

					<div class="grid">
						<label>
							<span>{getReferenceFieldLabel(provider)}</span>
							<input
								type="text"
								value={editorRefs[provider.pluginId] || ''}
								maxlength="240"
								placeholder={getReferencePlaceholder(provider)}
								oninput={(event) => (editorRefs = { ...editorRefs, [provider.pluginId]: event.currentTarget.value })}
							/>
						</label>

						<label>
							<span>Display label</span>
							<input
								type="text"
								value={editorLabels[provider.pluginId] || ''}
								maxlength="160"
								placeholder={getDisplayLabelPlaceholder(provider)}
								oninput={(event) => (editorLabels = { ...editorLabels, [provider.pluginId]: event.currentTarget.value })}
							/>
						</label>
					</div>

					<div class="actions">
						<button
							class="action primary"
							onclick={() => void handleSave(provider.pluginId)}
							disabled={!getAuthToken() || savingPluginId === provider.pluginId}
						>
							{savingPluginId === provider.pluginId
								? 'Saving...'
								: linkedAccount
									? 'Update reference'
									: 'Save reference'}
						</button>
						<button
							class="action"
							onclick={() => void handleClear(provider.pluginId)}
							disabled={!getAuthToken() || !linkedAccount || savingPluginId === provider.pluginId}
						>
							Clear reference
						</button>
					</div>

					{#if linkedAccount}
						<p class="linked-copy">
							Saved as
							<code>{linkedAccount.displayLabel || linkedAccount.providerAccountRef}</code>
						</p>
					{/if}
				</div>
			{/each}
		</div>
	</div>
</BaseModal>

<style>
	.sheet-body {
		padding: 0.75rem 1.5rem 1.5rem;
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
	}

	.provider-list {
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
	}

	.provider-card {
		border: 1px solid var(--border-default, rgba(255, 255, 255, 0.13));
		border-radius: var(--radius-lg, 0.75rem);
		padding: 0.9rem;
		background: var(--surface-raised, rgba(255, 255, 255, 0.03));
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.provider-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 1rem;
	}

	.provider-copy h3 {
		margin: 0;
		font-size: 1rem;
	}

	.provider-meta {
		margin: 0.2rem 0 0;
		font-size: 0.82rem;
		color: var(--text-secondary);
	}

	.status-pill {
		font-size: 0.78rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		padding: 0.22rem 0.46rem;
		border-radius: 999px;
		border: 1px solid var(--border-default, rgba(255, 255, 255, 0.2));
		color: var(--text-secondary);
	}

	.status-pill.linked {
		color: var(--color-success, #00ff7f);
		border-color: rgba(105, 224, 147, 0.45);
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.75rem;
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		font-size: 0.82rem;
		color: var(--text-secondary);
	}

	input {
		background: var(--surface-input, rgba(255, 255, 255, 0.05));
		border: 1px solid var(--border-default, rgba(255, 255, 255, 0.12));
		border-radius: var(--radius-md, 0.55rem);
		padding: 0.55rem 0.65rem;
		color: var(--text-heading);
		font-size: 0.9rem;
		transition: border-color var(--duration-fast, 150ms) var(--ease-out, ease-out);
	}

	input:focus-visible {
		outline: none;
		border-color: var(--pay-accent, rgba(0, 210, 255, 0.55));
		box-shadow: 0 0 0 2px rgba(0, 210, 255, 0.18);
	}

	.actions {
		display: flex;
		gap: 0.6rem;
		flex-wrap: wrap;
	}

	.action {
		border: 1px solid var(--border-default, rgba(255, 255, 255, 0.18));
		border-radius: var(--radius-md, 0.55rem);
		background: var(--surface-button, rgba(255, 255, 255, 0.04));
		color: var(--text-heading);
		padding: 0.5rem 0.8rem;
		cursor: pointer;
		font-size: 0.86rem;
		transition: background var(--duration-fast, 150ms) var(--ease-out, ease-out),
			border-color var(--duration-fast, 150ms) var(--ease-out, ease-out),
			transform var(--duration-fast, 150ms) var(--ease-out, ease-out);
	}

	.action:hover:not(:disabled) {
		background: var(--surface-hover, rgba(255, 255, 255, 0.08));
		border-color: rgba(255, 255, 255, 0.3);
	}

	.action:active:not(:disabled) {
		transform: scale(0.98);
	}

	.action:focus-visible {
		outline: 2px solid rgba(0, 210, 255, 0.55);
		outline-offset: 2px;
	}

	.action.primary {
		background: rgba(0, 210, 255, 0.18);
		border-color: rgba(0, 210, 255, 0.45);
	}

	.action.primary:hover:not(:disabled) {
		background: rgba(0, 210, 255, 0.28);
	}

	.action:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.hint {
		margin: 0;
		font-size: 0.84rem;
		color: var(--text-secondary);
	}

	.info {
		margin: 0;
		color: var(--color-info, #00bfff);
		font-size: 0.84rem;
	}

	.error {
		margin: 0;
		color: var(--color-danger, #ef4444);
		font-size: 0.84rem;
	}

	.linked-copy {
		margin: 0;
		font-size: 0.82rem;
		color: var(--text-secondary);
	}

	@media (max-width: 760px) {
		.grid {
			grid-template-columns: 1fr;
		}

		.provider-header {
			flex-direction: column;
			align-items: flex-start;
		}
	}
</style>
