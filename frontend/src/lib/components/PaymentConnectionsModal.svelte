<script lang="ts">
	import { onDestroy } from 'svelte';
	import BaseModal from './BaseModal.svelte';
	import { getAuthToken } from '$lib/authSession';
	import {
		deletePaymentAccountLink,
		listPaymentAccountLinks,
		listPaymentProviders,
		upsertPaymentAccountLink,
		type PaymentAccountLink,
		type PaymentProviderCapability
	} from '$lib/api';
	import { subscribePaymentRealtimeEvent } from '$lib/paymentRealtime';

	export let isOpen = false;
	export let onClose: () => void = () => {};
	export let overlayZIndex: number | string | null = null;

	let loadingProviders = false;
	let loadingLinks = false;
	let providersLoaded = false;
	let linksLoaded = false;
	let providersError = '';
	let linksError = '';
	let actionInfo = '';
	let actionError = '';
	let savingPluginId = '';
	let providers: PaymentProviderCapability[] = [];
	let paymentAccountLinks: PaymentAccountLink[] = [];
	let editorRefs: Record<string, string> = {};
	let editorLabels: Record<string, string> = {};

	$: if (isOpen && !providersLoaded) {
		void loadProviders();
	}

	$: if (isOpen && !linksLoaded) {
		void loadAccountLinks();
	}

	$: if (!isOpen) {
		providersLoaded = false;
		linksLoaded = false;
		providersError = '';
		linksError = '';
		actionInfo = '';
		actionError = '';
		savingPluginId = '';
	}

	const unsubscribeAccountLinksRealtime = subscribePaymentRealtimeEvent('payments:account-links-updated', () => {
		if (!isOpen) return;
		linksLoaded = false;
		void loadAccountLinks();
	});

	onDestroy(() => {
		unsubscribeAccountLinksRealtime();
	});

	function getLinkedAccount(pluginId: string): PaymentAccountLink | null {
		return paymentAccountLinks.find((link) => link.pluginId === pluginId) || null;
	}

	function ensureEditorsInitialized(): void {
		let changed = false;
		const nextRefs = { ...editorRefs };
		const nextLabels = { ...editorLabels };

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

	function setEditorRef(pluginId: string, value: string): void {
		editorRefs = {
			...editorRefs,
			[pluginId]: value
		};
	}

	function setEditorLabel(pluginId: string, value: string): void {
		editorLabels = {
			...editorLabels,
			[pluginId]: value
		};
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

	function isLocalTestProvider(provider: PaymentProviderCapability): boolean {
		return String(provider.notes || '').toLowerCase().includes('local test');
	}

	function isThaiPromptPayProvider(provider: PaymentProviderCapability): boolean {
		return provider.pluginId === 'th-payments';
	}

	function isBitcoinProvider(provider: PaymentProviderCapability): boolean {
		return provider.pluginId === 'btc-payments';
	}

	function getReferenceFieldLabel(provider: PaymentProviderCapability): string {
		if (isThaiPromptPayProvider(provider)) {
			return 'PromptPay number';
		}
		if (isBitcoinProvider(provider)) {
			return 'Bitcoin address';
		}
		return 'Saved payment reference';
	}

	function getReferencePlaceholder(provider: PaymentProviderCapability): string {
		if (isThaiPromptPayProvider(provider)) {
			return 'Thai mobile number or PromptPay ID';
		}
		if (isBitcoinProvider(provider)) {
			return 'bc1... or 1... / 3...';
		}
		return 'PromptPay number / wallet handle / PSP customer id';
	}

	function getDisplayLabelPlaceholder(provider: PaymentProviderCapability): string {
		if (isThaiPromptPayProvider(provider)) {
			return 'My PromptPay';
		}
		if (isBitcoinProvider(provider)) {
			return 'Main Bitcoin wallet';
		}
		return 'Main wallet / primary bank';
	}

	function getConnectionHelp(provider: PaymentProviderCapability): string {
		if (isLocalTestProvider(provider)) {
			return 'This provider is currently in local test mode. Saving a reference is optional and not required for localhost simulation.';
		}
		if (isThaiPromptPayProvider(provider)) {
			return 'For personal Thai QR requests, save your own PromptPay number here. Server donations use the server donation route separately.';
		}
		if (isBitcoinProvider(provider)) {
			return 'For personal Bitcoin QR requests, save your own Bitcoin address here. Server donations use the server donation Bitcoin address separately.';
		}
		return 'Optional. If you leave the advanced account field blank in a payment request, Wabi reuses this saved reference for this provider.';
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

<BaseModal isOpen={isOpen} onClose={onClose} width="760px" {overlayZIndex}>
	<div slot="header" class="sheet-header">
		<h2>Saved Payment References</h2>
		<p>Providers appear here automatically when the backend has an active payment plugin. Save a non-sensitive payment reference only when you want Wabi to reuse it for that provider.</p>
	</div>

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
				No payment providers are active on this server yet. This panel does not install plugins by itself. Once the
				server owner enables a payment plugin, its provider will appear here automatically for saved references.
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
								on:input={(event) => setEditorRef(provider.pluginId, event.currentTarget.value)}
							/>
						</label>

						<label>
							<span>Display label</span>
							<input
								type="text"
								value={editorLabels[provider.pluginId] || ''}
								maxlength="160"
								placeholder={getDisplayLabelPlaceholder(provider)}
								on:input={(event) => setEditorLabel(provider.pluginId, event.currentTarget.value)}
							/>
						</label>
					</div>

					<div class="actions">
						<button
							class="action primary"
							on:click={() => handleSave(provider.pluginId)}
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
							on:click={() => handleClear(provider.pluginId)}
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
	.sheet-header {
		padding: 1.25rem 1.5rem 0.5rem;
	}

	.sheet-header h2 {
		margin: 0;
		font-size: 1.2rem;
	}

	.sheet-header p {
		margin: 0.25rem 0 0;
		color: var(--text-secondary);
		font-size: 0.9rem;
	}

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
		border: 1px solid rgba(255, 255, 255, 0.13);
		border-radius: 0.75rem;
		padding: 0.9rem;
		background: rgba(255, 255, 255, 0.03);
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
		border: 1px solid rgba(255, 255, 255, 0.2);
		color: var(--text-secondary);
	}

	.status-pill.linked {
		color: #69e093;
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
		background: rgba(255, 255, 255, 0.05);
		border: 1px solid rgba(255, 255, 255, 0.12);
		border-radius: 0.55rem;
		padding: 0.55rem 0.65rem;
		color: var(--text-primary);
		font-size: 0.9rem;
	}

	.actions {
		display: flex;
		gap: 0.6rem;
		flex-wrap: wrap;
	}

	.action {
		border: 1px solid rgba(255, 255, 255, 0.18);
		border-radius: 0.55rem;
		background: rgba(255, 255, 255, 0.04);
		color: var(--text-primary);
		padding: 0.5rem 0.8rem;
		cursor: pointer;
	}

	.action.primary {
		background: rgba(0, 210, 255, 0.18);
		border-color: rgba(0, 210, 255, 0.45);
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
		color: #7fd5ff;
		font-size: 0.84rem;
	}

	.error {
		margin: 0;
		color: #ff8585;
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
