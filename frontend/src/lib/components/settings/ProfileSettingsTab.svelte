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
	<div class="profile-hero-banner" style="background: {($currentUser?.color || 'var(--pfp-banner, var(--accent-primary-color))')};"></div>
	<div class="profile-hero-main">
		<div class="profile-hero-avatar-wrap">
			{#if $currentUser?.profilePicture}
				<img src={$currentUser.profilePicture} alt="Current profile" class="profile-hero-avatar" />
			{:else}
				<div class="profile-hero-avatar profile-hero-avatar-fallback" style="--avatar-color: {$currentUser?.color || 'var(--accent-primary-color)'}">
					{$currentUser?.username?.charAt(0).toUpperCase() || '?'}
				</div>
			{/if}
			<span class="profile-hero-status" class:away={$currentUser?.status === 'away'} class:busy={$currentUser?.status === 'busy'} class:offline={!$currentUser || $currentUser.status === 'offline'}></span>
		</div>
		<div class="profile-hero-copy">
			<div class="profile-hero-kicker">Profile</div>
			<h3>{displayNameDraft || $currentUser?.username || `Your ${brandName} profile`}</h3>
			<p>
				{#if $currentUser?.handle}
					@{$currentUser.handle}
				{:else if $currentUser?.dbUserId}
					Registered account #{$currentUser.dbUserId}
				{:else}
					Temporary local account
				{/if}
			</p>
		</div>
		<div class="profile-hero-actions">
			<button type="button" class="profile-hero-action" on:click={() => dispatch('openAvatarEditor')}>
				Update Avatar
			</button>
		</div>
	</div>
</div>

<div class="settings-section">
	<h3>{$t('settings.sections.display_name')}</h3>
	<div class="setting-item-full">
		<div class="setting-info">
			<span class="setting-label">Your display name</span>
			<span class="setting-description">Shown in chat, calls, and notifications.</span>
		</div>
		<input
			type="text"
			class="emoji-name-input"
			maxlength="32"
			bind:value={displayNameDraft}
			placeholder="Enter display name"
		/>
		<button class="pfp-upload-btn" on:click={updateDisplayName} disabled={updatingDisplayName}>
			{updatingDisplayName ? 'Saving...' : 'Save Display Name'}
		</button>
	</div>
</div>

<div class="settings-section">
	<h3>Profile Status</h3>
	<div class="setting-item-full">
		<div class="setting-info">
			<span class="setting-label">Set your presence</span>
			<span class="setting-description">Choose how you appear to other users across the server.</span>
		</div>
		<div class="status-option-row">
			<button
				type="button"
				class="status-option-btn"
				class:active={$currentUser?.status === 'active'}
				on:click={() => changeStatus('active')}
			>
				<span class="status-option-dot" style="background-color: var(--status-online)"></span>
				Active
			</button>
			<button
				type="button"
				class="status-option-btn"
				class:active={$currentUser?.status === 'away'}
				on:click={() => changeStatus('away')}
			>
				<span class="status-option-dot" style="background-color: var(--status-away)"></span>
				Away
			</button>
			<button
				type="button"
				class="status-option-btn"
				class:active={$currentUser?.status === 'busy'}
				on:click={() => changeStatus('busy')}
			>
				<span class="status-option-dot" style="background-color: var(--status-busy)"></span>
				Busy
			</button>
		</div>
	</div>
</div>

<div class="settings-section">
	<h3>About Me</h3>
	<div class="setting-item-full">
		<div class="setting-info">
			<span class="setting-label">Bio</span>
			<span class="setting-description">Shown on your profile popout for other users.</span>
		</div>
		<textarea
			class="emoji-name-input bio-input"
			rows="3"
			maxlength="500"
			bind:value={bioDraft}
			placeholder="Write a short line about yourself…"
		></textarea>
		<button class="pfp-upload-btn" on:click={saveBio}>
			Save Bio
		</button>
		{#if bioStatus}<div class="runtime-note">{bioStatus}</div>{/if}
	</div>
</div>

{#if $currentUser?.dbUserId}
	<div class="settings-section">
		<h3>Multi-{brandName} Account Import</h3>
		<div class="setting-item-full">
			<div class="setting-info">
				<span class="setting-label">Default Local {brandName} Account</span>
				<span class="setting-description">Choose which locally linked {brandName} account should be treated as your default source profile on this device.</span>
			</div>
			<div class="runtime-note">
				Current default:
				{$defaultLocalWabiAccountStore
					? getLocalWabiAccountDisplayLabel($defaultLocalWabiAccountStore)
					: 'None yet'}
			</div>
			<button
				class="pfp-upload-btn"
				on:click={makeCurrentLocalWabiDefault}
				disabled={!currentLocalWabiAccountKey || currentLocalWabiAccountIsDefault}
			>
				{currentLocalWabiAccountIsDefault ? 'This Is The Default' : 'Make This Account Default'}
			</button>
		</div>
		<div class="setting-item-full">
			<div class="setting-info">
				<span class="setting-label">Import Profile From Another Local {brandName} Account</span>
				<span class="setting-description">Copy the other account's display name and profile picture into this server account. This stays local to this device until you choose to import.</span>
			</div>
			{#if otherLocalWabiAccounts.length > 0}
				<select class="emoji-name-input" bind:value={linkedWabiImportSourceKey}>
					{#each otherLocalWabiAccounts as account (account.key)}
						<option value={account.key}>{getLocalWabiAccountDisplayLabel(account)}</option>
					{/each}
				</select>
				<div class="runtime-note">
					{#if linkedWabiImportPreview?.canImport}
						Importable right now:
						{linkedWabiImportPreview.importableFields.includes('displayName') ? 'display name' : ''}
						{linkedWabiImportPreview.importableFields.includes('displayName') && linkedWabiImportPreview.importableFields.includes('profilePicture') ? ' and ' : ''}
						{linkedWabiImportPreview.importableFields.includes('profilePicture') ? 'profile picture' : ''}
					{:else}
						Nothing new is available to import from the selected account.
					{/if}
				</div>
				<button
					class="pfp-upload-btn"
					on:click={importProfileFromSelectedLocalWabiAccount}
					disabled={!linkedWabiImportPreview?.canImport || linkedWabiImporting}
				>
					{linkedWabiImporting ? 'Importing...' : 'Import Profile'}
				</button>
			{:else}
				<div class="runtime-note">
					No other registered {brandName} accounts have been seen on this device yet.
				</div>
			{/if}
			{#if linkedWabiImportStatus}
				<div class="runtime-note">{linkedWabiImportStatus}</div>
			{/if}
		</div>
	</div>

	<div class="settings-section">
		<h3>Account Security</h3>
		<div class="setting-item-full">
			<div class="setting-info">
				<span class="setting-label">Change Password</span>
				<span class="setting-description">Update your account password. If you lose it, there is no email recovery here today; ask an owner/admin to reset it.</span>
			</div>
			{#if mustChangeOwnPassword}
				<p class="warning-text">This account is using a temporary password. Change it now.</p>
			{/if}
			<input
				type="password"
				class="emoji-name-input"
				placeholder="Current password"
				bind:value={currentPasswordDraft}
				bind:this={currentPasswordInput}
				autocomplete="current-password"
			/>
			<input
				type="password"
				class="emoji-name-input"
				placeholder="New password"
				bind:value={newPasswordDraft}
				autocomplete="new-password"
			/>
			<input
				type="password"
				class="emoji-name-input"
				placeholder="Confirm new password"
				bind:value={confirmNewPasswordDraft}
				autocomplete="new-password"
			/>
			<button class="pfp-upload-btn" on:click={changeOwnPassword} disabled={changingPassword}>
				{changingPassword ? 'Updating...' : 'Update Password'}
			</button>
		</div>
	</div>
{/if}

<div class="settings-section">
	<h3>Payments</h3>
	<div class="setting-item-full">
		<div class="setting-info">
			<span class="setting-label">Payment History</span>
			<span class="setting-description">View the payment requests you created, then export them if you need a record.</span>
		</div>
		<button class="pfp-upload-btn" on:click={openPaymentHistorySafe} disabled={!$currentUser?.dbUserId}>
			{$currentUser?.dbUserId ? 'View History' : 'Sign In Required'}
		</button>
	</div>
	<div class="setting-item-full">
		<div class="setting-info">
			<span class="setting-label">Saved Payment References</span>
			<span class="setting-description">Save non-sensitive payment references for providers this server already exposes, so {brandName} can reuse them when you make or request payment.</span>
		</div>
		<button class="pfp-upload-btn" on:click={openPaymentConnectionsSafe} disabled={!$currentUser?.dbUserId}>
			{$currentUser?.dbUserId ? 'Manage References' : 'Sign In Required'}
		</button>
	</div>
	<div class="setting-item-full">
		<div class="setting-info">
			<span class="setting-label">Support This Server</span>
			<span class="setting-description">View donation totals and contribute through the server's configured donation route.</span>
		</div>
		<button class="pfp-upload-btn" on:click={() => dispatch('openServerDonation')}>
			View Donations
		</button>
	</div>
</div>

<div class="settings-section">
	<h3>Profile Banner</h3>
	<div class="pfp-upload-section">
		<div class="current-pfp">
			{#if $currentUser?.bannerUrl}
				<img src={$currentUser.bannerUrl} alt="Profile banner" class="pfp-current-img banner-preview" />
			{:else}
				<div class="pfp-placeholder banner-placeholder">No banner set</div>
			{/if}
		</div>
		<div class="pfp-upload-form">
			<input type="file" accept="image/*" id="banner-file-input" class="hidden-file-input" />
			<button class="pfp-select-btn" on:click={() => document.getElementById('banner-file-input')?.click()}>
				{bannerUploading ? 'Uploading...' : 'Upload Banner'}
			</button>
			{#if bannerStatus}<div class="runtime-note">{bannerStatus}</div>{/if}
		</div>
	</div>
</div>

<div class="settings-section">
	<h3>Avatar Overlay</h3>
	<div class="pfp-upload-section">
		<div class="current-pfp">
			{#if $currentUser?.overlayUrl}
				<div class="avatar-overlay-preview" style="background-image: url({$currentUser.overlayUrl})"></div>
			{:else}
				<div class="pfp-placeholder">No overlay set</div>
			{/if}
		</div>
		<div class="pfp-upload-form">
			<input type="file" accept="image/png" id="overlay-file-input" class="hidden-file-input" />
			<button class="pfp-select-btn" on:click={() => document.getElementById('overlay-file-input')?.click()}>
				{overlayUploading ? 'Uploading...' : 'Upload Overlay (PNG)'}
			</button>
			{#if overlayStatus}<div class="runtime-note">{overlayStatus}</div>{/if}
		</div>
	</div>
</div>

<div class="settings-section">
	<h3>Banner & Overlay Visibility</h3>
	<div class="setting-item-full">
		<div class="setting-info">
			<span class="setting-label">Show my banner</span>
			<span class="setting-description">Display my profile banner in popouts and member list.</span>
		</div>
		<input type="checkbox" bind:checked={showBannerLocal} />
	</div>
	<div class="setting-item-full">
		<div class="setting-info">
			<span class="setting-label">Show my avatar overlay</span>
			<span class="setting-description">Display my PNG overlay frame on avatars.</span>
		</div>
		<input type="checkbox" bind:checked={showOverlayLocal} />
	</div>
	<div class="setting-item-full">
		<div class="setting-info">
			<span class="setting-label">Disable all banner overlays (global)</span>
			<span class="setting-description">"People hate banners" — hide every banner and overlay for everyone on this client.</span>
		</div>
		<input type="checkbox" bind:checked={disableAllBannersLocal} />
	</div>
</div>

<div class="settings-section">
	<h3>{$t('settings.sections.profile_picture')}</h3>
	<div class="pfp-upload-section">
		<div class="current-pfp">
			{#if $currentUser?.profilePicture}
				<img src={$currentUser.profilePicture} alt="Current PFP" class="pfp-current-img" />
			{:else}
				<div class="pfp-placeholder">
					{$currentUser?.username?.charAt(0).toUpperCase() || '?'}
				</div>
			{/if}
		</div>
		<div class="pfp-upload-form">
			<button class="pfp-select-btn" on:click={() => dispatch('openAvatarEditor')}>
				Change Profile Picture
			</button>
		</div>
	</div>
</div>

<div class="settings-section">
	<UsernameFontCustomizer />
</div>
