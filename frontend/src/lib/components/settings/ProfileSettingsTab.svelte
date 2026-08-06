<script lang="ts">
	import { createEventDispatcher, onMount, tick } from 'svelte';
	import { _ as t } from '$lib/i18n';
	import { brandName } from '$lib/branding';
	import { currentUser, updateProfile } from '$lib/socket';
	import { getAuthToken } from '$lib/authSession';
	import { getServerUrl } from '$lib/serverUrl';
	import { changePassword, getUserSettings } from '$lib/api';
	import { clearActiveCustomStatusPreset } from '$lib/customStatusPresets';
	import {
		defaultLocalWabiAccountStore,
		getLocalWabiAccountDisplayLabel,
		getLocalWabiAccountKey,
		localWabiAccountListStore,
		markLocalWabiImportPromptHandled,
		setDefaultLocalWabiAccount,
		getSuggestedLocalWabiImportSourceAccount
	} from '$lib/localWabiAccounts';
	import {
		applyLocalWabiProfileImport,
		getLocalWabiProfileImportPreview
	} from '$lib/localWabiProfileImport';
	import UsernameFontCustomizer from '../UsernameFontCustomizer.svelte';

	const dispatch = createEventDispatcher<{
		openAvatarEditor: void;
		openPaymentHistory: void;
		openPaymentConnections: void;
		openServerDonation: void;
	}>();

	let { passwordChangeRequest = 0 } = $props();
	let lastHandledPasswordChangeRequest = $state(0);

	// ── Display name ──
	let displayNameDraft = $state('');
	let updatingDisplayName = $state(false);

	$effect(() => {
		if (!updatingDisplayName && $currentUser?.username && displayNameDraft === '') {
			displayNameDraft = $currentUser.username;
		}
	});

	// ── Local Wabi accounts ──
	let linkedWabiImportSourceKey = $state('');
	let linkedWabiImportStatus = $state('');
	let linkedWabiImporting = $state(false);

	const currentLocalWabiAccountKey = $derived(getLocalWabiAccountKey($currentUser, getServerUrl()));
	const currentLocalWabiAccountIsDefault = $derived(
		Boolean(currentLocalWabiAccountKey) && $defaultLocalWabiAccountStore?.key === currentLocalWabiAccountKey
	);
	const otherLocalWabiAccounts = $derived(
		$localWabiAccountListStore.filter((account) => account.key !== currentLocalWabiAccountKey)
	);
	const linkedWabiImportPreview = $derived(
		getLocalWabiProfileImportPreview(linkedWabiImportSourceKey, $currentUser)
	);

	$effect(() => {
		const selectedStillValid = otherLocalWabiAccounts.some(
			(account) => account.key === linkedWabiImportSourceKey
		);
		if (!selectedStillValid) {
			linkedWabiImportSourceKey =
				getSuggestedLocalWabiImportSourceAccount(currentLocalWabiAccountKey)?.key ||
				otherLocalWabiAccounts[0]?.key ||
				'';
		}
	});

	// ── Password change ──
	let currentPasswordDraft = $state('');
	let newPasswordDraft = $state('');
	let confirmNewPasswordDraft = $state('');
	let currentPasswordInput = $state<HTMLInputElement | null>(null);
	let mustChangeOwnPassword = $state(false);
	let changingPassword = $state(false);

	// ── PR4: Profile status + about me (self-edit) ──
	let bioDraft = $state('');
	let bioStatus = $state('');

	$effect(() => {
		if ($currentUser?.bio && bioDraft === '') {
			bioDraft = $currentUser.bio;
		}
	});

	function changeStatus(newStatus: 'active' | 'away' | 'busy') {
		clearActiveCustomStatusPreset();
		updateProfile({ status: newStatus });
		if ($currentUser) $currentUser = { ...$currentUser, status: newStatus };
	}

	function saveBio() {
		const next = bioDraft.trim();
		updateProfile({ bio: next });
		if ($currentUser) $currentUser = { ...$currentUser, bio: next };
		bioStatus = next ? 'Bio saved.' : 'Bio cleared.';
	}

	$effect(() => {
		if (passwordChangeRequest > lastHandledPasswordChangeRequest) {
			lastHandledPasswordChangeRequest = passwordChangeRequest;
			void focusPasswordChangeForm();
		}
	});

	// ── PR1/PR2/PR3: Banner / overlay upload + visibility ──
	let bannerUploading = $state(false);
	let bannerStatus = $state('');
	let overlayUploading = $state(false);
	let overlayStatus = $state('');
	let showBannerLocal = $state(false);
	let showOverlayLocal = $state(false);
	let disableAllBannersLocal = $state(false);

	const BANNER_STORE_KEY = 'wabi:profile:bannerUrl';
	const OVERLAY_STORE_KEY = 'wabi:profile:overlayUrl';
	const VISIBILITY_KEY = 'wabi:profile:visibility';

	function loadBannerVisibility() {
		try {
			const raw = localStorage.getItem(VISIBILITY_KEY);
			if (!raw) return;
			const v = JSON.parse(raw);
			if (typeof v.showBanner === 'boolean') showBannerLocal = v.showBanner;
			if (typeof v.showOverlay === 'boolean') showOverlayLocal = v.showOverlay;
			if (typeof v.disableAll === 'boolean') disableAllBannersLocal = v.disableAll;
		} catch { /* ignore */ }
	}

	$effect(() => {
		localStorage.setItem(
			VISIBILITY_KEY,
			JSON.stringify({ showBanner: showBannerLocal, showOverlay: showOverlayLocal, disableAll: disableAllBannersLocal })
		);
	});

	async function uploadBanner(file: File) {
		if (!file) return;
		bannerUploading = true;
		bannerStatus = '';
		try {
			const fd = new FormData();
			fd.append('file', file, file.name || 'banner.png');
			const res = await fetch(`${getServerUrl()}/api/upload`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${getAuthToken()}` },
				body: fd
			});
			const payload = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(typeof payload?.error === 'string' ? payload.error : `Upload failed (${res.status})`);
			const url = typeof payload?.file_url === 'string' ? payload.file_url : '';
			if (!url) throw new Error('No URL returned');
			localStorage.setItem(BANNER_STORE_KEY, url);
			// Patch current user locally so the UI updates immediately.
			if ($currentUser) $currentUser = { ...$currentUser, bannerUrl: url };
			bannerStatus = 'Banner uploaded.';
			// Best-effort socket broadcast.
			updateProfile({ bannerUrl: url });
		} catch (e) {
			bannerStatus = e instanceof Error ? e.message : 'Banner upload failed.';
		} finally {
			bannerUploading = false;
		}
	}

	async function uploadOverlay(file: File) {
		if (!file) return;
		overlayUploading = true;
		overlayStatus = '';
		try {
			const fd = new FormData();
			fd.append('file', file, file.name || 'overlay.png');
			const res = await fetch(`${getServerUrl()}/api/upload`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${getAuthToken()}` },
				body: fd
			});
			const payload = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(typeof payload?.error === 'string' ? payload.error : `Upload failed (${res.status})`);
			const url = typeof payload?.file_url === 'string' ? payload.file_url : '';
			if (!url) throw new Error('No URL returned');
			localStorage.setItem(OVERLAY_STORE_KEY, url);
			if ($currentUser) $currentUser = { ...$currentUser, overlayUrl: url };
			overlayStatus = 'Overlay uploaded.';
			updateProfile({ overlayUrl: url });
		} catch (e) {
			overlayStatus = e instanceof Error ? e.message : 'Overlay upload failed.';
		} finally {
			overlayUploading = false;
		}
	}

	onMount(() => {
		loadBannerVisibility();
		try {
			const b = localStorage.getItem(BANNER_STORE_KEY);
			if (b && $currentUser && !$currentUser.bannerUrl) $currentUser = { ...$currentUser, bannerUrl: b };
			const o = localStorage.getItem(OVERLAY_STORE_KEY);
			if (o && $currentUser && !$currentUser.overlayUrl) $currentUser = { ...$currentUser, overlayUrl: o };
		} catch { /* ignore */ }
		const bannerInput = document.getElementById('banner-file-input');
		bannerInput?.addEventListener('change', (ev) => {
			const file = (ev.target as HTMLInputElement).files?.[0];
			if (file) void uploadBanner(file);
		});
		const overlayInput = document.getElementById('overlay-file-input');
		overlayInput?.addEventListener('change', (ev) => {
			const file = (ev.target as HTMLInputElement).files?.[0];
			if (file) void uploadOverlay(file);
		});
	});

	onMount(() => {
		const token = getAuthToken();
		if (!token) return;
		void getUserSettings(token)
			.then((settings) => {
				mustChangeOwnPassword = settings?.require_password_change === true;
			})
			.catch((error) => {
				console.warn('[Settings] Failed to load account security settings:', error);
			});
	});

	// ── Handlers ──
	function updateDisplayName() {
		const nextName = displayNameDraft.trim();
		if (!nextName) {
			alert('Display name cannot be empty.');
			return;
		}
		if (nextName.length < 2 || nextName.length > 32) {
			alert('Display name must be between 2 and 32 characters.');
			return;
		}
		if (nextName === ($currentUser?.username || '')) {
			return;
		}

		updatingDisplayName = true;
		updateProfile({ username: nextName });
		updatingDisplayName = false;
	}

	function makeCurrentLocalWabiDefault(): void {
		if (!currentLocalWabiAccountKey) return;
		setDefaultLocalWabiAccount(currentLocalWabiAccountKey);
		linkedWabiImportStatus = `This account is now the default local ${brandName} profile source on this device.`;
	}

	async function importProfileFromSelectedLocalWabiAccount(): Promise<void> {
		if (!linkedWabiImportSourceKey || linkedWabiImporting) return;
		linkedWabiImporting = true;
		linkedWabiImportStatus = '';
		try {
			const result = await applyLocalWabiProfileImport(linkedWabiImportSourceKey);
			if (currentLocalWabiAccountKey) {
				markLocalWabiImportPromptHandled(currentLocalWabiAccountKey);
			}
			if (!result.success) {
				linkedWabiImportStatus = result.errors.join(' ') || 'Profile import did not complete.';
				return;
			}
			linkedWabiImportStatus = `Imported ${result.importedFields.join(' and ')}.`;
		} finally {
			linkedWabiImporting = false;
		}
	}

	async function changeOwnPassword() {
		if (changingPassword) return;
		if (!currentPasswordDraft || !newPasswordDraft || !confirmNewPasswordDraft) {
			alert('Please fill in all password fields.');
			return;
		}
		if (newPasswordDraft !== confirmNewPasswordDraft) {
			alert('New password confirmation does not match.');
			return;
		}
		if (newPasswordDraft.length < 8) {
			alert('New password must be at least 8 characters.');
			return;
		}

		const token = getAuthToken();
		if (!token) {
			alert('You must be logged in to change password.');
			return;
		}

		changingPassword = true;
		try {
			await changePassword(token, currentPasswordDraft, newPasswordDraft);
			currentPasswordDraft = '';
			newPasswordDraft = '';
			confirmNewPasswordDraft = '';
			mustChangeOwnPassword = false;
			alert('Password updated.');
		} catch (error) {
			alert(error instanceof Error ? error.message : 'Failed to change password.');
		} finally {
			changingPassword = false;
		}
	}

	async function focusPasswordChangeForm(): Promise<void> {
		await tick();
		currentPasswordInput?.scrollIntoView({ block: 'center', behavior: 'smooth' });
		currentPasswordInput?.focus();
	}

	function openPaymentConnectionsSafe(): void {
		const token = getAuthToken();
		if (!token || !$currentUser?.dbUserId) {
			alert('Sign in with a registered account to manage saved payment references.');
			return;
		}
		dispatch('openPaymentConnections');
	}

	function openPaymentHistorySafe(): void {
		const token = getAuthToken();
		if (!token || !$currentUser?.dbUserId) {
			alert('Sign in with a registered account to view your payment history.');
			return;
		}
		dispatch('openPaymentHistory');
	}
</script>

<div class="profile-hero-card">
	<div
		class="profile-hero-banner"
		style="background: {($currentUser?.bannerUrl
			? `center/cover url(${$currentUser.bannerUrl})`
			: ($currentUser?.color || 'var(--pfp-banner, var(--accent-primary-color))'))};"
	></div>
	<div class="profile-hero-main">
		<div class="profile-hero-avatar-wrap">
			{#if $currentUser?.profilePicture}
				<img src={$currentUser.profilePicture} alt="Current profile" class="profile-hero-avatar" />
			{:else}
				<div
					class="profile-hero-avatar profile-hero-avatar-fallback"
					style="--avatar-color: {$currentUser?.color || 'var(--accent-primary-color)'}"
				>
					{$currentUser?.username?.charAt(0).toUpperCase() || '?'}
				</div>
			{/if}
			<span
				class="profile-hero-status"
				class:away={$currentUser?.status === 'away'}
				class:busy={$currentUser?.status === 'busy'}
				class:offline={!$currentUser || $currentUser.status === 'offline'}
			></span>
		</div>
		<div class="profile-hero-copy">
			<div class="profile-hero-kicker">You</div>
			<h3>{displayNameDraft || $currentUser?.username || `Your ${brandName} profile`}</h3>
			<p>
				{#if $currentUser?.handle}
					@{$currentUser.handle}
				{:else if $currentUser?.dbUserId}
					Registered account
				{:else}
					Temporary local account
				{/if}
			</p>
		</div>
		<div class="profile-hero-actions">
			<button type="button" class="profile-hero-action" on:click={() => dispatch('openAvatarEditor')}>
				Edit avatar
			</button>
			<button
				type="button"
				class="profile-hero-action secondary"
				on:click={() => document.getElementById('banner-file-input')?.click()}
				disabled={bannerUploading}
			>
				{bannerUploading ? 'Uploading…' : 'Edit banner'}
			</button>
		</div>
	</div>
</div>

<input type="file" accept="image/*" id="banner-file-input" class="hidden-file-input" />
<input type="file" accept="image/png" id="overlay-file-input" class="hidden-file-input" />

<div class="settings-section">
	<h3>Identity</h3>
	<div class="settings-group-card">
		<div class="setting-item-full">
			<div class="setting-info">
				<span class="setting-label">Display name</span>
				<span class="setting-description">Shown in chat, calls, and notifications.</span>
			</div>
			<div class="setting-inline-save">
				<input type="text" class="emoji-name-input" maxlength="32" bind:value={displayNameDraft} placeholder="Display name" />
				<button class="pfp-upload-btn" on:click={updateDisplayName} disabled={updatingDisplayName}>
					{updatingDisplayName ? 'Saving…' : 'Save'}
				</button>
			</div>
		</div>

		<div class="setting-item-full">
			<div class="setting-info">
				<span class="setting-label">Status</span>
				<span class="setting-description">How you appear to others.</span>
			</div>
			<div class="status-option-row">
				<button type="button" class="status-option-btn" class:active={$currentUser?.status === 'active'} on:click={() => changeStatus('active')}>
					<span class="status-option-dot" style="background-color: var(--status-online)"></span>
					Active
				</button>
				<button type="button" class="status-option-btn" class:active={$currentUser?.status === 'away'} on:click={() => changeStatus('away')}>
					<span class="status-option-dot" style="background-color: var(--status-away)"></span>
					Away
				</button>
				<button type="button" class="status-option-btn" class:active={$currentUser?.status === 'busy'} on:click={() => changeStatus('busy')}>
					<span class="status-option-dot" style="background-color: var(--status-busy)"></span>
					Busy
				</button>
			</div>
		</div>

		<div class="setting-item-full">
			<div class="setting-info">
				<span class="setting-label">About me</span>
				<span class="setting-description">Short bio on your profile popout.</span>
			</div>
			<textarea class="emoji-name-input bio-input" rows="2" maxlength="500" bind:value={bioDraft} placeholder="A short line about yourself…"></textarea>
			<div class="setting-inline-save">
				<button class="pfp-upload-btn" on:click={saveBio}>Save bio</button>
				{#if bioStatus}<span class="runtime-note">{bioStatus}</span>{/if}
			</div>
		</div>
	</div>
</div>

<div class="settings-section">
	<h3>Look</h3>
	<div class="settings-group-card">
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Avatar overlay</span>
				<span class="setting-description">Optional PNG frame. {overlayStatus || ($currentUser?.overlayUrl ? 'Set' : 'None')}</span>
			</div>
			<button class="pfp-select-btn" type="button" on:click={() => document.getElementById('overlay-file-input')?.click()} disabled={overlayUploading}>
				{overlayUploading ? 'Uploading…' : ($currentUser?.overlayUrl ? 'Replace' : 'Upload PNG')}
			</button>
		</div>
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Show my banner</span>
				<span class="setting-description">In popouts and member list.</span>
			</div>
			<button type="button" class="toggle-btn" class:active={showBannerLocal} aria-pressed={showBannerLocal} on:click={() => (showBannerLocal = !showBannerLocal)} aria-label="Show my banner"></button>
		</div>
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Show my overlay</span>
				<span class="setting-description">Avatar frame on this account.</span>
			</div>
			<button type="button" class="toggle-btn" class:active={showOverlayLocal} aria-pressed={showOverlayLocal} on:click={() => (showOverlayLocal = !showOverlayLocal)} aria-label="Show my overlay"></button>
		</div>
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Hide all banners</span>
				<span class="setting-description">This client only — hide everyone’s banners & overlays.</span>
			</div>
			<button type="button" class="toggle-btn" class:active={disableAllBannersLocal} aria-pressed={disableAllBannersLocal} on:click={() => (disableAllBannersLocal = !disableAllBannersLocal)} aria-label="Hide all banners"></button>
		</div>
		{#if bannerStatus}<div class="runtime-note" style="padding:0.35rem 0.1rem">{bannerStatus}</div>{/if}
	</div>
</div>

{#if $currentUser?.dbUserId}
	<div class="settings-section">
		<h3>Account</h3>
		<div class="settings-group-card">
			<div class="setting-item-full">
				<div class="setting-info">
					<span class="setting-label">Password</span>
					<span class="setting-description">No email recovery — ask an owner/admin if locked out.</span>
				</div>
				{#if mustChangeOwnPassword}
					<p class="warning-text">Temporary password — change it now.</p>
				{/if}
				<input type="password" class="emoji-name-input" placeholder="Current password" bind:value={currentPasswordDraft} bind:this={currentPasswordInput} autocomplete="current-password" />
				<input type="password" class="emoji-name-input" placeholder="New password" bind:value={newPasswordDraft} autocomplete="new-password" />
				<input type="password" class="emoji-name-input" placeholder="Confirm new password" bind:value={confirmNewPasswordDraft} autocomplete="new-password" />
				<div class="setting-inline-save">
					<button class="pfp-upload-btn" on:click={changeOwnPassword} disabled={changingPassword}>
						{changingPassword ? 'Updating…' : 'Update password'}
					</button>
				</div>
			</div>

			<div class="setting-item-full">
				<div class="setting-info">
					<span class="setting-label">Local accounts on this device</span>
					<span class="setting-description">
						Default:
						{$defaultLocalWabiAccountStore
							? getLocalWabiAccountDisplayLabel($defaultLocalWabiAccountStore)
							: 'none'}
					</span>
				</div>
				<div class="setting-inline-save">
					<button
						class="pfp-upload-btn"
						on:click={makeCurrentLocalWabiDefault}
						disabled={!currentLocalWabiAccountKey || currentLocalWabiAccountIsDefault}
					>
						{currentLocalWabiAccountIsDefault ? 'Is default' : 'Make default'}
					</button>
				</div>
				{#if otherLocalWabiAccounts.length > 0}
					<div class="setting-inline-save" style="margin-top:0.55rem">
						<select class="emoji-name-input" bind:value={linkedWabiImportSourceKey}>
							{#each otherLocalWabiAccounts as account (account.key)}
								<option value={account.key}>{getLocalWabiAccountDisplayLabel(account)}</option>
							{/each}
						</select>
						<button
							class="pfp-upload-btn"
							on:click={importProfileFromSelectedLocalWabiAccount}
							disabled={!linkedWabiImportPreview?.canImport || linkedWabiImporting}
						>
							{linkedWabiImporting ? 'Importing…' : 'Import look'}
						</button>
					</div>
					<div class="runtime-note">
						{#if linkedWabiImportPreview?.canImport}
							Can copy: {linkedWabiImportPreview.importableFields.join(', ')}
						{:else}
							Nothing new to import from that account.
						{/if}
					</div>
				{:else}
					<div class="runtime-note">No other local accounts seen yet.</div>
				{/if}
				{#if linkedWabiImportStatus}<div class="runtime-note">{linkedWabiImportStatus}</div>{/if}
			</div>
		</div>
	</div>
{/if}

<div class="settings-section">
	<h3>Payments</h3>
	<div class="settings-group-card">
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">History</span>
				<span class="setting-description">Requests you created.</span>
			</div>
			<button class="pfp-upload-btn" on:click={openPaymentHistorySafe} disabled={!$currentUser?.dbUserId}>
				{$currentUser?.dbUserId ? 'Open' : 'Sign in'}
			</button>
		</div>
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Saved references</span>
				<span class="setting-description">Non-sensitive payment refs for this server.</span>
			</div>
			<button class="pfp-upload-btn" on:click={openPaymentConnectionsSafe} disabled={!$currentUser?.dbUserId}>
				{$currentUser?.dbUserId ? 'Manage' : 'Sign in'}
			</button>
		</div>
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Support server</span>
				<span class="setting-description">Donations route if configured.</span>
			</div>
			<button class="pfp-upload-btn" on:click={() => dispatch('openServerDonation')}>View</button>
		</div>
	</div>
</div>

<div class="settings-section">
	<UsernameFontCustomizer />
</div>

