<script lang="ts">
	import { createEventDispatcher, onMount, tick } from 'svelte';
	import { _ as t } from '$lib/i18n';
	import { brandName } from '$lib/branding';
	import { currentUser, updateProfile } from '$lib/socket';
	import { getAuthToken } from '$lib/authSession';
	import { getServerUrl } from '$lib/serverUrl';
	import { changePassword, getUserSettings } from '$lib/api';
	import {
		defaultLocalWabiAccountStore,
		getLocalWabiAccountDisplayLabel,
		getLocalWabiAccountKey,
		localWabiAccountListStore,
		markLocalWabiImportPromptHandled,
		setDefaultLocalWabiAccount,
		getSuggestedLocalWabiImportSourceAccount,
		type LocalWabiAccountRecord
	} from '$lib/localWabiAccounts';
	import {
		applyLocalWabiProfileImport,
		getLocalWabiProfileImportPreview,
		type LocalWabiProfileImportPreview
	} from '$lib/localWabiProfileImport';
	import UsernameFontCustomizer from '../UsernameFontCustomizer.svelte';

	const dispatch = createEventDispatcher<{
		openAvatarEditor: void;
		openPaymentHistory: void;
		openPaymentConnections: void;
		openServerDonation: void;
	}>();

	export let passwordChangeRequest = 0;
	let lastHandledPasswordChangeRequest = 0;

	// ── Display name ──
	let displayNameDraft = '';
	let updatingDisplayName = false;

	$: if (!updatingDisplayName && $currentUser?.username && displayNameDraft === '') {
		displayNameDraft = $currentUser.username;
	}

	// ── Local Wabi accounts ──
	let currentLocalWabiAccountKey = '';
	let currentLocalWabiAccountIsDefault = false;
	let otherLocalWabiAccounts: LocalWabiAccountRecord[] = [];
	let linkedWabiImportPreview = null;
	let linkedWabiImportSourceKey = '';
	let linkedWabiImportStatus = '';
	let linkedWabiImporting = false;

	$: currentLocalWabiAccountKey = getLocalWabiAccountKey($currentUser, getServerUrl());
	$: currentLocalWabiAccountIsDefault =
		Boolean(currentLocalWabiAccountKey) && $defaultLocalWabiAccountStore?.key === currentLocalWabiAccountKey;
	$: otherLocalWabiAccounts = $localWabiAccountListStore.filter(
		(account) => account.key !== currentLocalWabiAccountKey
	);
	$: {
		const selectedStillValid = otherLocalWabiAccounts.some(
			(account) => account.key === linkedWabiImportSourceKey
		);
		if (!selectedStillValid) {
			linkedWabiImportSourceKey =
				getSuggestedLocalWabiImportSourceAccount(currentLocalWabiAccountKey)?.key ||
				otherLocalWabiAccounts[0]?.key ||
				'';
		}
	}
	$: linkedWabiImportPreview = getLocalWabiProfileImportPreview(linkedWabiImportSourceKey, $currentUser);

	// ── Password change ──
	let currentPasswordDraft = '';
	let newPasswordDraft = '';
	let confirmNewPasswordDraft = '';
	let currentPasswordInput: HTMLInputElement | null = null;
	let mustChangeOwnPassword = false;
	let changingPassword = false;

	$: if (passwordChangeRequest > lastHandledPasswordChangeRequest) {
		lastHandledPasswordChangeRequest = passwordChangeRequest;
		void focusPasswordChangeForm();
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
