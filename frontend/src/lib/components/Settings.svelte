<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { _ as t, availableLocales, currentLocale, setAppLocale } from '$lib/i18n';
	import { channelMessages, currentUser, getSocket, updateProfile } from '$lib/socket';
	import type { Message } from '$lib/socket';
	import { chatStorage } from '$lib/storage';
	import { getAuthToken } from '$lib/authSession';
	import { getServerUrl } from '$lib/serverUrl';
	import { uploadProfilePictureFile } from '$lib/profilePictureUpload';
	import AvatarEditor from './AvatarEditor.svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import StorageSettings from './StorageSettings.svelte';
	import AboutSettingsTab from './settings/AboutSettingsTab.svelte';
	import AccessibilitySettingsTab from './settings/AccessibilitySettingsTab.svelte';
	import AddonSettingsTab from './settings/AddonSettingsTab.svelte';
	import AdminSettingsTab from './settings/AdminSettingsTab.svelte';
	import AppearanceSettingsTab from './settings/AppearanceSettingsTab.svelte';
	import AudioSettingsTab from './settings/AudioSettingsTab.svelte';
	import EmojiSettingsTab from './settings/EmojiSettingsTab.svelte';
	import NotificationsSettingsTab from './settings/NotificationsSettingsTab.svelte';
	import ProfileSettingsTab from './settings/ProfileSettingsTab.svelte';
	import ServerSettingsTab from './settings/ServerSettingsTab.svelte';
	import PaymentConnectionsModal from '$lib/payments/PaymentConnectionsModal.svelte';
	import PaymentHistoryModal from '$lib/payments/PaymentHistoryModal.svelte';
	import PaymentSheet from '$lib/payments/PaymentSheet.svelte';
	import ServerDonationModal from '$lib/payments/ServerDonationModal.svelte';

	export let isOpen = false;
	export let requestedPaymentSurface: 'connections' | null = null;
	export let requestedPasswordChangeRequest = 0;

	type SettingsTab =
		| 'profile'
		| 'audio'
		| 'notifications'
		| 'accessibility'
		| 'appearance'
		| 'server'
		| 'addons'
		| 'emojis'
		| 'storage'
		| 'admin'
		| 'about';

	interface DonationPrefillPayload {
		amountInput: string;
		providerPluginId: string;
		methodId: string;
		currency: string;
		countryCode: string | null;
		description: string;
		metadata: Record<string, unknown>;
	}

	const dispatch = createEventDispatcher<{ logout: void }>();
	const tabs: Array<{ id: SettingsTab; labelKey: string; adminOnly?: boolean }> = [
		{ id: 'profile', labelKey: 'settings.tabs.profile' },
		{ id: 'audio', labelKey: 'settings.tabs.audio' },
		{ id: 'notifications', labelKey: 'settings.tabs.notifications' },
		{ id: 'accessibility', labelKey: 'settings.tabs.accessibility' },
		{ id: 'appearance', labelKey: 'settings.tabs.appearance' },
		{ id: 'server', labelKey: 'settings.tabs.server' },
		{ id: 'addons', labelKey: 'settings.tabs.addons' },
		{ id: 'emojis', labelKey: 'settings.tabs.emojis' },
		{ id: 'storage', labelKey: 'settings.tabs.storage' },
		{ id: 'admin', labelKey: 'settings.tabs.admin', adminOnly: true },
		{ id: 'about', labelKey: 'settings.tabs.about' }
	];

	let activeSettingsTab: SettingsTab = 'profile';
	let lastHandledRequestedPaymentSurface: 'connections' | null = null;
	let lastHandledRequestedPasswordChangeRequest = 0;
	let showAvatarEditor = false;
	let selectedAvatarFile: File | null = null;
	let paymentConnectionsOpen = false;
	let paymentHistoryOpen = false;
	let serverDonationOpen = false;
	let profilePaymentSheetOpen = false;
	let profilePaymentSheetOpenSeed = 0;
	let profilePaymentSheetInitialAmountInput: string | null = null;
	let profilePaymentSheetInitialCurrency: string | null = null;
	let profilePaymentSheetInitialCountryCode: string | null = null;
	let profilePaymentSheetInitialDescription: string | null = null;
	let profilePaymentSheetInitialCustomerRef: string | null = null;
	let profilePaymentSheetInitialProviderId: string | null = null;
	let profilePaymentSheetInitialMethodId: string | null = null;
	let profilePaymentSheetInitialMetadata: Record<string, unknown> | null = null;
	let showClearServerConfirm = false;
	let avatarUploadStatus = '';
	let avatarUploadError = '';

	$: canManageAdmin = $currentUser?.highestRole === 'owner' || $currentUser?.highestRole === 'admin';
	$: if (!canManageAdmin && activeSettingsTab === 'admin') {
		activeSettingsTab = 'profile';
	}
	$: if (!isOpen) {
		lastHandledRequestedPaymentSurface = null;
	}
	$: if (
		isOpen &&
		requestedPaymentSurface === 'connections' &&
		lastHandledRequestedPaymentSurface !== requestedPaymentSurface
	) {
		paymentConnectionsOpen = true;
		lastHandledRequestedPaymentSurface = requestedPaymentSurface;
	}
	$: if (isOpen && requestedPasswordChangeRequest > lastHandledRequestedPasswordChangeRequest) {
		lastHandledRequestedPasswordChangeRequest = requestedPasswordChangeRequest;
		activeSettingsTab = 'profile';
	}

	function closeModal(): void {
		isOpen = false;
	}

	function handleLogout(): void {
		closeModal();
		dispatch('logout');
	}

	function openPaymentConnections(): void {
		const token = getAuthToken();
		if (!token || !$currentUser?.dbUserId) {
			alert('Sign in with a registered account to manage saved payment references.');
			return;
		}
		paymentConnectionsOpen = true;
	}

	function openPaymentHistory(): void {
		const token = getAuthToken();
		if (!token || !$currentUser?.dbUserId) {
			alert('Sign in with a registered account to view your payment history.');
			return;
		}
		paymentHistoryOpen = true;
	}

	function openServerDonation(): void {
		serverDonationOpen = true;
	}

	function setPaymentSheetPrefill(options: {
		amountInput?: string | null;
		currency?: string | null;
		countryCode?: string | null;
		description?: string | null;
		customerRef?: string | null;
		providerId?: string | null;
		methodId?: string | null;
		metadata?: Record<string, unknown> | null;
	} = {}): void {
		profilePaymentSheetInitialAmountInput = options.amountInput ?? null;
		profilePaymentSheetInitialCurrency = options.currency ?? null;
		profilePaymentSheetInitialCountryCode = options.countryCode ?? null;
		profilePaymentSheetInitialDescription = options.description ?? null;
		profilePaymentSheetInitialCustomerRef = options.customerRef ?? null;
		profilePaymentSheetInitialProviderId = options.providerId ?? null;
		profilePaymentSheetInitialMethodId = options.methodId ?? null;
		profilePaymentSheetInitialMetadata = options.metadata ?? null;
	}

	function openProfilePaymentSheet(options: Parameters<typeof setPaymentSheetPrefill>[0] = {}): void {
		const token = getAuthToken();
		if (!token || !$currentUser?.dbUserId) {
			alert('Sign in with a registered account to create payment requests.');
			return;
		}
		setPaymentSheetPrefill({
			amountInput: '100.00',
			currency: null,
			countryCode: null,
			description: '',
			customerRef: '',
			providerId: null,
			methodId: null,
			metadata: null,
			...options
		});
		profilePaymentSheetOpenSeed += 1;
		profilePaymentSheetOpen = true;
	}

	function handleDonationPrefill(payload: DonationPrefillPayload): void {
		serverDonationOpen = false;
		openProfilePaymentSheet({
			amountInput: payload.amountInput,
			currency: payload.currency,
			countryCode: payload.countryCode,
			description: payload.description,
			providerId: payload.providerPluginId,
			methodId: payload.methodId,
			metadata: payload.metadata
		});
	}

	function handleAvatarSelected(event: CustomEvent<{ file: File; dataUrl: string }>): void {
		selectedAvatarFile = event.detail.file;
		avatarUploadStatus = 'Uploading avatar…';
		avatarUploadError = '';
		void uploadProfilePicture();
	}

	async function uploadProfilePicture(): Promise<void> {
		if (!selectedAvatarFile) {
			alert('No image selected for upload.');
			return;
		}
		if (!getSocket()) {
			avatarUploadError = 'Not connected. Reconnect before updating your profile picture.';
			avatarUploadStatus = '';
			return;
		}

		try {
			const uploadedProfilePictureUrl = await uploadProfilePictureFile(selectedAvatarFile);
			await updateProfile({ profilePicture: uploadedProfilePictureUrl });
			currentUser.update((user) => user ? { ...user, profilePicture: uploadedProfilePictureUrl } : user);
			avatarUploadStatus = 'Avatar updated and synced.';
		} catch (error) {
			console.error('Error uploading profile picture:', error);
			avatarUploadError = error instanceof Error ? error.message : 'Failed to upload profile picture. Please try again.';
			avatarUploadStatus = '';
		} finally {
			selectedAvatarFile = null;
		}
	}

	async function confirmClearServer(): Promise<void> {
		try {
			const authToken = getAuthToken();
			const headers: HeadersInit = { 'Content-Type': 'application/json' };
			if (authToken) {
				headers.Authorization = `Bearer ${authToken}`;
			}

			const response = await fetch(`${getServerUrl()}/api/clear-messages`, {
				method: 'POST',
				headers
			});
			const result = await response.json();

			if (result.success) {
				await chatStorage.clearAllHistory();
				channelMessages.update((msgs) => {
					const cleared: Record<string, Message[]> = {};
					for (const key of Object.keys(msgs)) {
						cleared[key] = [];
					}
					if (!('general' in cleared)) {
						cleared.general = [];
					}
					return cleared;
				});
				localStorage.removeItem('channelUnreadCounts');
				localStorage.removeItem('unreadCount');
				localStorage.removeItem('lastReadMessageId');
				alert('All server messages have been deleted successfully!');
			} else {
				alert('Failed to clear server messages: ' + (result.error || 'Unknown error'));
			}
		} catch (error) {
			console.error('Error clearing server messages:', error);
			alert('Failed to clear server messages. Check console for details.');
		} finally {
			showClearServerConfirm = false;
		}
	}
</script>

{#if isOpen}
	<div
		class="modal-overlay"
		role="presentation"
		on:click={closeModal}
		on:keydown={(event) => {
			if (event.key === 'Escape') {
				event.preventDefault();
				closeModal();
			}
		}}
	>
		<div
			class="modal-content"
			role="dialog"
			aria-modal="true"
			aria-label={$t('settings.title')}
			tabindex="-1"
			on:click|stopPropagation
			on:keydown|stopPropagation={(event) => {
				if (event.key === 'Escape') {
					event.preventDefault();
					closeModal();
				}
			}}
		>
			<div class="modal-header">
				<h2>
					<svg class="header-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<circle cx="12" cy="12" r="3"></circle>
						<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path>
					</svg>
					{$t('settings.title')}
				</h2>
				<div class="header-actions">
					<label for="settings-locale" class="header-locale-label">{$t('settings.language')}</label>
					<select
						id="settings-locale"
						class="header-locale-select"
						value={$currentLocale || 'en'}
						on:change={(event) => setAppLocale(event.currentTarget.value)}
					>
						{#each availableLocales as localeOption}
							<option value={localeOption.code}>{localeOption.label}</option>
						{/each}
					</select>
					<button class="close-btn" on:click={closeModal} aria-label={$t('common.close')}>&#x2715;</button>
				</div>
			</div>

			<div class="settings-layout">
				<div class="settings-tabs">
					{#each tabs as tab}
						{#if !tab.adminOnly || canManageAdmin}
							<button
								type="button"
								class="settings-tab"
								class:active={activeSettingsTab === tab.id}
								aria-pressed={activeSettingsTab === tab.id}
								on:click={() => (activeSettingsTab = tab.id)}
							>
								{$t(tab.labelKey)}
							</button>
						{/if}
					{/each}
					<div class="settings-tabs-spacer"></div>
					<button type="button" class="settings-tab logout-tab" on:click={handleLogout}>
						{$t('settings.tabs.logout')}
					</button>
				</div>

				<div class="settings-content">
					{#if avatarUploadStatus || avatarUploadError}
						<div class="settings-inline-status" class:error={Boolean(avatarUploadError)} role="status">
							{avatarUploadError || avatarUploadStatus}
						</div>
					{/if}
					{#if activeSettingsTab === 'profile'}
						<ProfileSettingsTab
							passwordChangeRequest={requestedPasswordChangeRequest}
							on:openAvatarEditor={() => (showAvatarEditor = true)}
							on:openPaymentHistory={openPaymentHistory}
							on:openPaymentConnections={openPaymentConnections}
							on:openServerDonation={openServerDonation}
						/>
					{:else if activeSettingsTab === 'audio'}
						<AudioSettingsTab />
					{:else if activeSettingsTab === 'notifications'}
						<NotificationsSettingsTab />
					{:else if activeSettingsTab === 'accessibility'}
						<AccessibilitySettingsTab />
					{:else if activeSettingsTab === 'appearance'}
						<AppearanceSettingsTab />
					{:else if activeSettingsTab === 'server'}
						<ServerSettingsTab on:clearServer={() => (showClearServerConfirm = true)} />
					{:else if activeSettingsTab === 'addons'}
						<AddonSettingsTab />
					{:else if activeSettingsTab === 'emojis'}
						<EmojiSettingsTab />
					{:else if activeSettingsTab === 'storage'}
						<StorageSettings />
					{:else if activeSettingsTab === 'admin'}
						<AdminSettingsTab on:openServerDonation={openServerDonation} />
					{:else if activeSettingsTab === 'about'}
						<AboutSettingsTab />
					{/if}
				</div>
			</div>
		</div>
	</div>
{/if}

<AvatarEditor
	bind:isOpen={showAvatarEditor}
	overlayZIndex={'var(--z-settings-nested)'}
	on:change={handleAvatarSelected}
/>

<PaymentHistoryModal
	isOpen={paymentHistoryOpen}
	overlayZIndex={'var(--z-settings-nested)'}
	onCreatePayment={() => {
		paymentHistoryOpen = false;
		openProfilePaymentSheet();
	}}
	onClose={() => {
		paymentHistoryOpen = false;
	}}
/>

<ServerDonationModal
	isOpen={serverDonationOpen}
	overlayZIndex={'var(--z-settings-nested)'}
	onDonate={handleDonationPrefill}
	onClose={() => {
		serverDonationOpen = false;
	}}
/>

<PaymentConnectionsModal
	isOpen={paymentConnectionsOpen}
	overlayZIndex={'var(--z-settings-nested)'}
	onClose={() => {
		paymentConnectionsOpen = false;
	}}
/>

<PaymentSheet
	isOpen={profilePaymentSheetOpen}
	openSeed={profilePaymentSheetOpenSeed}
	overlayZIndex={'var(--z-settings-nested)'}
	initialAmountInput={profilePaymentSheetInitialAmountInput}
	initialCurrency={profilePaymentSheetInitialCurrency}
	initialCountryCode={profilePaymentSheetInitialCountryCode}
	initialDescription={profilePaymentSheetInitialDescription}
	initialCustomerRef={profilePaymentSheetInitialCustomerRef}
	initialProviderId={profilePaymentSheetInitialProviderId}
	initialMethodId={profilePaymentSheetInitialMethodId}
	initialMetadata={profilePaymentSheetInitialMetadata}
	onManageConnections={() => {
		profilePaymentSheetOpen = false;
		paymentConnectionsOpen = true;
	}}
	onClose={() => {
		profilePaymentSheetOpen = false;
	}}
/>

<ConfirmDialog
	isOpen={showClearServerConfirm}
	overlayZIndex={'var(--z-settings-nested)'}
	title={$t('settings.confirm.clear_server_title')}
	message={$t('settings.confirm.clear_server_message')}
	confirmText={$t('settings.confirm.clear_server_confirm')}
	variant="danger"
	onConfirm={confirmClearServer}
	onCancel={() => (showClearServerConfirm = false)}
/>
