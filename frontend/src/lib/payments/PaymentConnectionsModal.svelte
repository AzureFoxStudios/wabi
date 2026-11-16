<script lang="ts">
	import { _ } from '$lib/i18n';
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
		const countries = provider.countries.length > 0 ? provider.countries.join(', ') : $_('pay_conn.any_region');
		const currencies = provider.currencies.length > 0 ? provider.currencies.join(', ') : $_('pay_conn.any_currency');
		return `${countries} · ${currencies}`;
	}

	function formatMethods(provider: PaymentProviderCapability): string {
		if (provider.methods.length === 0) return $_('pay_conn.no_methods');
		return provider.methods.map((method) => method.label).join(', ');
	}

	function getReferenceFieldLabel(provider: PaymentProviderCapability): string {
		if (provider.pluginId === 'promptpay' || provider.pluginId === 'th-payments') {
			return $_('pay_conn.ref_promptpay');
		}
		if (provider.pluginId === 'payments-crypto') {
			return $_('pay_conn.ref_wallet');
		}
		if (provider.pluginId === 'payments-eu') {
			return $_('pay_conn.ref_iban');
		}
		if (provider.pluginId === 'payments-us') {
			return $_('pay_conn.ref_us');
		}
		return $_('pay_conn.ref_saved');
	}

	function getReferencePlaceholder(provider: PaymentProviderCapability): string {
		if (provider.pluginId === 'promptpay' || provider.pluginId === 'th-payments') {
			return $_('pay_conn.ph_promptpay');
		}
		if (provider.pluginId === 'payments-crypto') {
			return $_('pay_conn.ph_wallet');
		}
		if (provider.pluginId === 'payments-eu') {
			return $_('pay_conn.ph_iban');
		}
		if (provider.pluginId === 'payments-us') {
			return $_('pay_conn.ph_us');
		}
		return $_('pay_conn.ph_default');
	}

	function getDisplayLabelPlaceholder(provider: PaymentProviderCapability): string {
		if (provider.pluginId === 'promptpay' || provider.pluginId === 'th-payments') {
			return $_('pay_conn.label_promptpay');
		}
		if (provider.pluginId === 'payments-crypto') {
			return $_('pay_conn.label_wallet');
		}
		if (provider.pluginId === 'payments-eu') {
			return $_('pay_conn.label_bank');
		}
		if (provider.pluginId === 'payments-us') {
			return $_('pay_conn.label_us');
		}
		return $_('pay_conn.label_default');
	}

	function getConnectionHelp(provider: PaymentProviderCapability): string {
		if (provider.pluginId === 'promptpay' || provider.pluginId === 'th-payments') {
			return $_('pay_conn.help_promptpay');
		}
		if (provider.pluginId === 'payments-crypto') {
			return $_('pay_conn.help_crypto', { values: { brand: brandName } });
		}
		if (provider.pluginId === 'payments-eu') {
			return $_('pay_conn.help_sepa');
		}
		if (provider.pluginId === 'payments-us') {
			return $_('pay_conn.help_us');
		}
		return $_('pay_conn.help_default', { values: { brand: brandName } });
	}

	async function loadProviders(): Promise<void> {
		loadingProviders = true;
		providersError = '';
		try {
			providers = await listPaymentProviders();
			providersLoaded = true;
			ensureEditorsInitialized();
		} catch (error) {
			providersError = error instanceof Error ? error.message : $_('pay_conn.err_load_providers');
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
			linksError = error instanceof Error ? error.message : $_('pay_conn.err_load_links');
		} finally {
			loadingLinks = false;
		}
	}

	async function handleSave(pluginId: string): Promise<void> {
		actionInfo = '';
		actionError = '';
		const token = getAuthToken();
		if (!token) {
			actionError = $_('pay_conn.err_login_save');
			return;
		}

		const providerAccountRef = (editorRefs[pluginId] || '').trim();
		if (!providerAccountRef) {
			actionError = $_('pay_conn.err_enter_ref');
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
			actionInfo = $_('pay_conn.ok_saved', { values: { plugin: saved.pluginId } });
		} catch (error) {
			actionError = error instanceof Error ? error.message : $_('pay_conn.err_save');
		} finally {
			savingPluginId = '';
		}
	}

	async function handleClear(pluginId: string): Promise<void> {
		actionInfo = '';
		actionError = '';
		const token = getAuthToken();
		if (!token) {
			actionError = $_('pay_conn.err_login_clear');
			return;
		}

		savingPluginId = pluginId;
		try {
			await deletePaymentAccountLink(token, pluginId);
			paymentAccountLinks = paymentAccountLinks.filter((link) => link.pluginId !== pluginId);
			syncEditorsForPlugin(pluginId);
			actionInfo = $_('pay_conn.ok_cleared', { values: { plugin: pluginId } });
		} catch (error) {
			actionError = error instanceof Error ? error.message : $_('pay_conn.err_clear');
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
	title={$_('pay_conn.title')}
	subtitle={$_('pay_conn.subtitle', { values: { brand: brandName } })}
>
	<div class="sheet-body">
		{#if !getAuthToken()}
			<p class="error">{$_('pay_conn.sign_in_needed')}</p>
		{/if}

		{#if loadingProviders || loadingLinks}
			<p class="hint">{$_('pay_conn.loading')}</p>
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
				{$_('pay_conn.no_rails')}
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
							{linkedAccount ? $_('pay_conn.saved') : $_('pay_conn.not_saved')}
						</span>
					</div>

					{#if provider.notes}
						<p class="hint">{provider.notes}</p>
					{/if}

					<p class="hint">{$_('pay_conn.available_methods', { values: { methods: formatMethods(provider) } })}</p>
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
							<span>{$_('pay_conn.display_label')}</span>
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
								? $_('pay_conn.saving')
								: linkedAccount
									? $_('pay_conn.update_ref')
									: $_('pay_conn.save_ref')}
						</button>
						<button
							class="action"
							onclick={() => void handleClear(provider.pluginId)}
							disabled={!getAuthToken() || !linkedAccount || savingPluginId === provider.pluginId}
						>
							{$_('pay_conn.clear_ref')}
						</button>
					</div>

					{#if linkedAccount}
						<p class="linked-copy">
							{$_('pay_conn.saved_as')}
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
