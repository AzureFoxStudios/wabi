<script lang="ts">
	import { createEventDispatcher, onMount, tick } from 'svelte';
	import { _ as t } from '$lib/i18n';
	import { brandName } from '$lib/branding';
	import { currentUser, updateProfile } from '$lib/socket';
	import { getAuthToken } from '$lib/authSession';
	import { getServerUrl } from '$lib/serverUrl';
	import { changePassword, getUserSettings } from '$lib/api';
	import { fetchWithTimeout } from '$lib/api/utils';
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
	let profileMediaLoaded = $state(false);

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
			await saveProfileMedia();
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
			await saveProfileMedia();
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
		void loadProfileMedia();
	});

	async function loadProfileMedia(): Promise<void> {
		if (profileMediaLoaded || !getAuthToken()) return;
		try {
			const response = await fetchWithTimeout(`${getServerUrl()}/api/user/profile-media`, {
				headers: { Authorization: `Bearer ${getAuthToken()}` }
			});
			if (!response.ok) return;
			const media = await response.json();
			if ($currentUser) $currentUser = { ...$currentUser, bannerUrl: media.banner_url || undefined, overlayUrl: media.overlay_url || undefined, showBanner: media.show_banner, showOverlay: media.show_overlay };
			profileMediaLoaded = true;
		} catch (error) {
			console.warn('[Settings] Failed to load profile media:', error);
		}
	}

	async function saveProfileMedia(): Promise<void> {
		const token = getAuthToken();
		if (!token) return;
		try {
			await fetchWithTimeout(`${getServerUrl()}/api/user/profile-media`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ banner_url: $currentUser?.bannerUrl || null, overlay_url: $currentUser?.overlayUrl || null, show_banner: showBannerLocal, show_overlay: showOverlayLocal })
			});
		} catch (error) {
			console.warn('[Settings] Failed to save profile media:', error);
		}
	}

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

	const previewHandle = $derived(
		$currentUser?.handle
			? `@${$currentUser.handle}`
			: $currentUser?.username
				? `@${$currentUser.username}`
				: 'No handle'
	);
	const previewName = $derived(displayNameDraft.trim() || $currentUser?.username || 'You');
	const previewJoined = $derived(
		new Date($currentUser?.joinedAt || Date.now()).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
	);
	const previewStatus = $derived($currentUser?.status || 'offline');
	const previewStatusLabel = $derived(
		previewStatus === 'active' ? 'Online' : previewStatus === 'away' ? 'Away' : previewStatus === 'busy' ? 'Busy' : 'Offline'
	);
</script>

<input type="file" accept="image/*" id="banner-file-input" class="hidden-file-input" />
<input type="file" accept="image/png" id="overlay-file-input" class="hidden-file-input" />

<section class="profile-settings-layout">
	<div class="profile-preview-column">
		<p class="profile-preview-kicker">How others see you</p>
		<div class="profile-preview-card" aria-label="Live profile preview">
			<div
				class="profile-preview-banner"
				class:is-empty={!$currentUser?.bannerUrl || !showBannerLocal || disableAllBannersLocal}
				style={$currentUser?.bannerUrl && showBannerLocal && !disableAllBannersLocal
					? `background-image: url(${$currentUser.bannerUrl})`
					: `background: linear-gradient(135deg, ${$currentUser?.color || 'var(--accent-secondary-color)'}, var(--accent-primary-color))`}
			></div>
			<div class="profile-preview-avatar-wrap">
				<div class="profile-preview-avatar">
					{#if $currentUser?.profilePicture}
						<img src={$currentUser.profilePicture} alt="" />
					{:else}
						<span class="profile-preview-avatar-fallback" style="--avatar-color: {$currentUser?.color || 'var(--accent-primary-color)'}">
							{previewName.charAt(0).toUpperCase()}
						</span>
					{/if}
					{#if $currentUser?.overlayUrl && showOverlayLocal && !disableAllBannersLocal}
						<span class="profile-preview-overlay" style="background-image: url({$currentUser.overlayUrl})"></span>
					{/if}
					<span
						class="profile-preview-status"
						class:away={previewStatus === 'away'}
						class:busy={previewStatus === 'busy'}
						class:offline={previewStatus === 'offline'}
						title={previewStatusLabel}
					></span>
				</div>
			</div>
			<div class="profile-preview-body">
				<strong class="profile-preview-name">{previewName}</strong>
				<span class="profile-preview-handle">{previewHandle}</span>
				{#if bioDraft.trim()}
					<p class="profile-preview-bio">{bioDraft.trim()}</p>
				{/if}
				<span class="profile-preview-meta">Member since {previewJoined}</span>
			</div>
		</div>
	</div>

	<div class="profile-editor-column">
<div class="profile-mock">
	<button
		type="button"
		class="profile-mock-banner"
		class:is-empty={!$currentUser?.bannerUrl}
		style={$currentUser?.bannerUrl
			? `background-image: url(${$currentUser.bannerUrl})`
			: `background: linear-gradient(135deg, ${$currentUser?.color || 'var(--accent-secondary-color)'}, var(--accent-primary-color))`}
		on:click={() => document.getElementById('banner-file-input')?.click()}
		disabled={bannerUploading}
		title="Change banner"
		aria-label="Change banner"
	>
		<span class="profile-mock-banner-hint">{bannerUploading ? 'Uploading banner…' : 'Change banner'}</span>
	</button>

	<div class="profile-mock-body">
		<div class="profile-mock-avatar-stack">
			<button
				type="button"
				class="profile-mock-avatar-btn"
				on:click={() => dispatch('openAvatarEditor')}
				title="Change avatar"
				aria-label="Change avatar"
			>
				{#if $currentUser?.profilePicture}
					<img src={$currentUser.profilePicture} alt="" class="profile-mock-avatar" />
				{:else}
					<span
						class="profile-mock-avatar profile-mock-avatar-fallback"
						style="--avatar-color: {$currentUser?.color || 'var(--accent-primary-color)'}"
					>
						{$currentUser?.username?.charAt(0).toUpperCase() || '?'}
					</span>
				{/if}
				{#if $currentUser?.overlayUrl && showOverlayLocal && !disableAllBannersLocal}
					<span class="profile-mock-overlay" style="background-image: url({$currentUser.overlayUrl})"></span>
				{/if}
				<span
					class="profile-mock-status"
					class:away={$currentUser?.status === 'away'}
					class:busy={$currentUser?.status === 'busy'}
					class:offline={!$currentUser || $currentUser.status === 'offline'}
				></span>
			</button>
			<span class="profile-mock-media-label">Profile picture</span>
			<button
				type="button"
				class="profile-mock-overlay-slot"
				class:is-empty={!$currentUser?.overlayUrl}
				on:click={() => document.getElementById('overlay-file-input')?.click()}
				disabled={overlayUploading}
				title={overlayUploading ? 'Uploading…' : ($currentUser?.overlayUrl ? 'Replace overlay' : 'Upload overlay PNG')}
				aria-label="Upload avatar overlay"
			>
				{#if $currentUser?.overlayUrl}
					<span class="profile-mock-overlay-thumb" style="background-image: url({$currentUser.overlayUrl})"></span>
				{:else}
					<span class="profile-mock-overlay-empty" aria-hidden="true"></span>
				{/if}
			</button>
			<span class="profile-mock-media-label">Avatar overlay</span>
		</div>

		<div class="profile-mock-identity">
			<div class="profile-mock-name-row">
				<input
					type="text"
					class="profile-mock-name"
					maxlength="32"
					bind:value={displayNameDraft}
					placeholder="Display name"
					aria-label="Display name"
				/>
				<button
					type="button"
					class="profile-mock-save"
					on:click={updateDisplayName}
					disabled={updatingDisplayName || !displayNameDraft.trim() || displayNameDraft.trim() === ($currentUser?.username || '')}
				>
					{updatingDisplayName ? '…' : 'Save'}
				</button>
			</div>
			<p class="profile-mock-handle">
				{#if $currentUser?.handle}
					@{$currentUser.handle}
				{:else if $currentUser?.dbUserId}
					Registered
				{:else}
					Local account
				{/if}
			</p>
			<div class="profile-mock-presence" role="group" aria-label="Presence">
				<button type="button" class="presence-chip" class:active={$currentUser?.status === 'active'} on:click={() => changeStatus('active')}>
					<span class="status-option-dot" style="background-color: var(--status-online)"></span> Active
				</button>
				<button type="button" class="presence-chip" class:active={$currentUser?.status === 'away'} on:click={() => changeStatus('away')}>
					<span class="status-option-dot" style="background-color: var(--status-away)"></span> Away
				</button>
				<button type="button" class="presence-chip" class:active={$currentUser?.status === 'busy'} on:click={() => changeStatus('busy')}>
					<span class="status-option-dot" style="background-color: var(--status-busy)"></span> Busy
				</button>
			</div>
			<textarea
				class="profile-mock-bio"
				rows="2"
				maxlength="500"
				bind:value={bioDraft}
				placeholder="About me…"
				aria-label="About me"
				on:blur={saveBio}
			></textarea>
			<div class="profile-mock-bio-bar">
				<button type="button" class="profile-mock-save ghost" on:click={saveBio}>Save bio</button>
				{#if bioStatus}<span class="runtime-note">{bioStatus}</span>{/if}
				{#if bannerStatus}<span class="runtime-note">{bannerStatus}</span>{/if}
				{#if overlayStatus}<span class="runtime-note">{overlayStatus}</span>{/if}
			</div>
		</div>
	</div>

	<div class="profile-mock-toggles" role="group" aria-label="Banner and overlay visibility">
		<label class="mini-toggle" title="Show my banner in popouts">
			<input type="checkbox" bind:checked={showBannerLocal} />
			<span>Banner</span>
		</label>
		<label class="mini-toggle" title="Show my avatar overlay">
			<input type="checkbox" bind:checked={showOverlayLocal} />
			<span>Overlay</span>
		</label>
		<label class="mini-toggle" title="Hide everyone’s banners and overlays on this client">
			<input type="checkbox" bind:checked={disableAllBannersLocal} />
			<span>Hide all</span>
		</label>
	</div>
</div>
	</div>
</section>

<div class="settings-section">
	<div class="settings-group-card tight">
		<div class="setting-item-full" style="padding-top:0.55rem">
			<UsernameFontCustomizer />
		</div>
	</div>
</div>

<div class="settings-section">
	<div class="icon-action-row">
		<button type="button" class="icon-action" title="Payment requests you created" on:click={openPaymentHistorySafe} disabled={!$currentUser?.dbUserId}>
			<span class="icon-action-glyph" aria-hidden="true">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7h18v10H3z"/><path d="M3 10h18"/><path d="M7 15h4"/></svg>
			</span>
			<span class="icon-action-label">History</span>
		</button>
		<button type="button" class="icon-action" title="Saved non-sensitive payment references" on:click={openPaymentConnectionsSafe} disabled={!$currentUser?.dbUserId}>
			<span class="icon-action-glyph" aria-hidden="true">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18"/><path d="M7 15h2"/></svg>
			</span>
			<span class="icon-action-label">Refs</span>
		</button>
		<button type="button" class="icon-action" title="Support this server" on:click={() => dispatch('openServerDonation')}>
			<span class="icon-action-glyph" aria-hidden="true">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 11c0 5.5-7 10-7 10z"/></svg>
			</span>
			<span class="icon-action-label">Support</span>
		</button>
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
				<div class="pwd-grid">
					<input type="password" class="emoji-name-input" placeholder="Current" bind:value={currentPasswordDraft} bind:this={currentPasswordInput} autocomplete="current-password" />
					<input type="password" class="emoji-name-input" placeholder="New" bind:value={newPasswordDraft} autocomplete="new-password" />
					<input type="password" class="emoji-name-input" placeholder="Confirm" bind:value={confirmNewPasswordDraft} autocomplete="new-password" />
					<button class="pfp-upload-btn" on:click={changeOwnPassword} disabled={changingPassword}>
						{changingPassword ? '…' : 'Update'}
					</button>
				</div>
			</div>

			<div class="setting-item-full">
				<div class="setting-info">
					<span class="setting-label">Local accounts</span>
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
					<div class="setting-inline-save" style="margin-top:0.45rem">
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
							{linkedWabiImporting ? '…' : 'Import look'}
						</button>
					</div>
					<div class="runtime-note">
						{#if linkedWabiImportPreview?.canImport}
							Can copy: {linkedWabiImportPreview.importableFields.join(', ')}
						{:else}
							Nothing new from that account.
						{/if}
					</div>
				{:else}
					<div class="runtime-note">No other local accounts yet.</div>
				{/if}
				{#if linkedWabiImportStatus}<div class="runtime-note">{linkedWabiImportStatus}</div>{/if}
			</div>
		</div>
	</div>
{/if}

