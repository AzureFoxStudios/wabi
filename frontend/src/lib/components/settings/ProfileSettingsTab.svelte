<script lang="ts">
	import { createEventDispatcher, onMount, tick } from 'svelte';
	import { _ as t } from '$lib/i18n';
	import { brandName } from '$lib/branding';
	import { currentUser } from '$lib/socket';
	import { saveProfilePatch } from '$lib/profileSave';
	import { selectPresence, getStoredPresence, type PresenceState } from '$lib/presenceControl';
	import { profileAppearance, setProfileAppearance, profileDecorationsVisible } from '$lib/profileAppearance';
	import ProfileName from '$lib/components/ProfileName.svelte';
	import { getAuthToken, authSessionGeneration } from '$lib/authSession';
	import { paymentAccessStore } from '$lib/payments/paymentAccessStore';
	import { activeServerUrl, getServerUrl } from '$lib/serverUrl';
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
	import ProfileArtExamples from '$lib/components/ProfileArtExamples.svelte';
	import type { ProfileArtExample } from '$lib/profileArtExamples';
	import RoleBadge from '../RoleBadge.svelte';
	import ProfileMedia from '$lib/components/ProfileMedia.svelte';
	import ProfileDecoration from '$lib/components/ProfileDecoration.svelte';
	import { mediaUrl } from '$lib/mediaUrl';

	const dispatch = createEventDispatcher<{
		openAvatarEditor: void;
		openPaymentHistory: void;
		openPaymentConnections: void;
		openServerDonation: void;
	}>();

	let { passwordChangeRequest = 0 } = $props();
	let nameDesignStudio = $state<{ loadExampleDraft: (example: ProfileArtExample) => void } | null>(null);
	let lastHandledPasswordChangeRequest = $state(0);

	// ── Display name ──
	let displayNameDraft = $state('');
	let updatingDisplayName = $state(false);
	let displayNameStatus = $state('');
	let loadedProfileIdentity = $state('');
	let selectedPresence = $state<PresenceState>(getStoredPresence());


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

	// ── Password change (two-step flow) ──
	let currentPasswordDraft = $state('');
	let newPasswordDraft = $state('');
	let confirmNewPasswordDraft = $state('');
	let currentPasswordInput = $state<HTMLInputElement | null>(null);
	let mustChangeOwnPassword = $state(false);
	let changingPassword = $state(false);
	let passwordStep = $state<1 | 2>(1);
	let passwordError = $state('');
	let passwordSuccess = $state('');

	function advancePasswordStep(): void {
		passwordError = '';
		passwordSuccess = '';
		if (!currentPasswordDraft) {
			passwordError = 'Enter your current password first.';
			return;
		}
		passwordStep = 2;
		tick().then(() => {
			document.querySelector<HTMLInputElement>('[data-pwd-new]')?.focus();
		});
	}

	function backPasswordStep(): void {
		passwordStep = 1;
		passwordError = '';
		passwordSuccess = '';
		tick().then(() => currentPasswordInput?.focus());
	}

	// Profile identity drafts stay local until the Authority confirms the save.
	let bioDraft = $state('');
	let bioStatus = $state('');
	let bioSaving = $state(false);
	let statusMessageDraft = $state('');
	let statusMessageFeedback = $state('');
	let statusMessageSaving = $state(false);
	const statusMessageBytes = $derived(new TextEncoder().encode(statusMessageDraft.trim()).length);
	const bioBytes = $derived(new TextEncoder().encode(bioDraft.trim()).length);
	$effect(() => {
		const identity = `${getServerUrl()}:${$currentUser?.dbUserId ?? $currentUser?.id ?? ''}`;
		if ($currentUser && identity !== loadedProfileIdentity) {
			loadedProfileIdentity = identity;
			displayNameDraft = $currentUser.username || '';
			bioDraft = $currentUser.bio || '';
			statusMessageDraft = $currentUser.statusMessage || '';
			statusMessageFeedback = '';
			bioStatus = ''; displayNameStatus = '';
		}
	});
	function changeStatus(newStatus: PresenceState) {
		clearActiveCustomStatusPreset();
		selectedPresence = newStatus;
		selectPresence(newStatus);
	}
	async function saveBio() {
		if (bioSaving) return;
		if (bioBytes > 280) { bioStatus = 'About me must be 280 bytes or fewer. Emoji and some letters use more than one byte.'; return; }
		bioSaving = true; bioStatus = 'Saving bio…';
		try {
			const submitted = bioDraft; const next = submitted.trim();
			await saveProfilePatch({ bio: next });
			if (bioDraft === submitted) { bioDraft = next; bioStatus = next ? 'Bio saved.' : 'Bio cleared.'; }
			else bioStatus = 'Earlier bio saved. Your newer edits are still a draft.';
		} catch (error) { bioStatus = error instanceof Error ? error.message : 'Could not save bio. Your draft is still here.'; }
		finally { bioSaving = false; }
	}
	async function saveStatusMessage(): Promise<void> {
		if (statusMessageSaving || statusMessageBytes > 120) return;
		statusMessageSaving = true; statusMessageFeedback = 'Saving status message…';
		const submitted = statusMessageDraft;
		try {
			await saveProfilePatch({ statusMessage: submitted.trim() });
			statusMessageFeedback = statusMessageDraft === submitted ? (submitted.trim() ? 'Status message saved.' : 'Status message cleared.') : 'Earlier status message saved. Your newer edits are still a draft.';
		} catch (error) { statusMessageFeedback = error instanceof Error ? error.message : 'Could not save the status message.'; }
		finally { statusMessageSaving = false; }
	}

	$effect(() => {
		if (passwordChangeRequest > lastHandledPasswordChangeRequest) {
			lastHandledPasswordChangeRequest = passwordChangeRequest;
			void focusPasswordChangeForm();
		}
	});

	// ── PR1/PR2/PR3: Banner / overlay upload (proxy-card driven) ──
	let bannerUploading = $state(false);
	let bannerStatus = $state('');
	let overlayUploading = $state(false);
	let avatarRemoving = $state(false);
	let avatarStatus = $state('');
	let overlayStatus = $state('');
	const disableAllBannersLocal = $derived(!$profileDecorationsVisible);

	// ── Overlay alignment editor (per-user scale + X/Y offset) ──
	let overlayAlignMode = $state(false);
	let overlayPendingUrl = $state('');
	let overlayDraftOwner = $state('');
	function overlayOwner() { return `${getServerUrl()}:${$currentUser?.dbUserId ?? $currentUser?.id ?? ''}:${authSessionGeneration(getServerUrl())}`; }
	$effect(() => { void $activeServerUrl; void $currentUser?.id; if (overlayDraftOwner && overlayDraftOwner !== overlayOwner()) { overlayPendingUrl = ''; overlayAlignMode = false; overlayDraftOwner = ''; overlayDrag = null; } });
	let overlayDraftScale = $state(1);
	let overlayDraftX = $state(0);
	let overlayDraftY = $state(0);
	let overlayAlignSaving = $state(false);
	const overlayPreviewUser = $derived(overlayAlignMode ? { overlayUrl: overlayPendingUrl || $currentUser?.overlayUrl, overlayScale: overlayDraftScale, overlayOffsetX: overlayDraftX, overlayOffsetY: overlayDraftY } : { overlayUrl: $currentUser?.overlayUrl, overlayScale: $currentUser?.overlayScale, overlayOffsetX: $currentUser?.overlayOffsetX, overlayOffsetY: $currentUser?.overlayOffsetY });
	let overlayDrag: { pointerId: number; startX: number; startY: number; baseX: number; baseY: number } | null = null;

	function clampOverlayDrafts() {
		overlayDraftScale = Math.min(3, Math.max(0.5, Number.isFinite(overlayDraftScale) ? overlayDraftScale : 1));
		overlayDraftX = Math.min(200, Math.max(-200, Number.isFinite(overlayDraftX) ? overlayDraftX : 0));
		overlayDraftY = Math.min(200, Math.max(-200, Number.isFinite(overlayDraftY) ? overlayDraftY : 0));
	}

	function enterOverlayAlign() {
		overlayDraftOwner = overlayOwner();
		const u = $currentUser;
		overlayDraftScale = typeof u?.overlayScale === 'number' && Number.isFinite(u.overlayScale) ? u.overlayScale : 1;
		overlayDraftX = typeof u?.overlayOffsetX === 'number' && Number.isFinite(u.overlayOffsetX) ? u.overlayOffsetX : 0;
		overlayDraftY = typeof u?.overlayOffsetY === 'number' && Number.isFinite(u.overlayOffsetY) ? u.overlayOffsetY : 0;
		clampOverlayDrafts();
		overlayAlignMode = true;
	}

	function cancelOverlayAlign() {
		if (overlayAlignSaving) return;
		overlayStatus = 'Overlay changes cancelled.';
		overlayAlignMode = false;
		overlayPendingUrl = '';
		overlayDrag = null;
	}

	function resetOverlayAlign() {
		if (overlayAlignSaving) return;
		overlayDraftScale = 1;
		overlayDraftX = 0;
		overlayDraftY = 0;
	}

	function nudgeOverlayScale(delta: number) {
		if (overlayAlignSaving) return;
		overlayDraftScale = Math.round(Math.min(3, Math.max(0.5, overlayDraftScale + delta)) * 100) / 100;
	}

	async function saveOverlayAlign() {
		if (overlayAlignSaving) return;
		if (overlayDraftOwner !== overlayOwner()) { cancelOverlayAlign(); overlayStatus = 'Your account changed. Choose the overlay again.'; return; }
		clampOverlayDrafts(); overlayAlignSaving = true; overlayStatus = 'Saving alignment…';
		try {
			await saveProfilePatch({ ...(overlayPendingUrl ? { overlayUrl: overlayPendingUrl } : {}), overlayScale: overlayDraftScale, overlayOffsetX: overlayDraftX, overlayOffsetY: overlayDraftY });
			overlayPendingUrl = '';
			overlayStatus = 'Overlay alignment saved.'; overlayAlignMode = false;
		} catch (error) { overlayStatus = error instanceof Error ? error.message : 'Could not save overlay alignment.'; }
		finally { overlayAlignSaving = false; }
	}

	function onOverlayPointerDown(e: PointerEvent) {
		if (!overlayAlignMode || overlayAlignSaving) return;
		(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
		overlayDrag = {
			pointerId: e.pointerId,
			startX: e.clientX,
			startY: e.clientY,
			baseX: overlayDraftX,
			baseY: overlayDraftY
		};
	}

	function onOverlayPointerMove(e: PointerEvent) {
		if (!overlayDrag || e.pointerId !== overlayDrag.pointerId) return;
		overlayDraftX = Math.min(200, Math.max(-200, overlayDrag.baseX + (e.clientX - overlayDrag.startX)));
		overlayDraftY = Math.min(200, Math.max(-200, overlayDrag.baseY + (e.clientY - overlayDrag.startY)));
	}

	function onOverlayPointerUp(e: PointerEvent) {
		if (!overlayDrag || e.pointerId !== overlayDrag.pointerId) return;
		overlayDraftX = Math.round(overlayDraftX);
		overlayDraftY = Math.round(overlayDraftY);
		overlayDrag = null;
	}

	function onOverlayWheel(e: WheelEvent) {
		if (!overlayAlignMode || overlayAlignSaving) return;
		e.preventDefault();
		nudgeOverlayScale(e.deltaY < 0 ? 0.05 : -0.05);
	}

	const PROFILE_MEDIA_LIMIT = 10 * 1024 * 1024;
	function validateProfileMedia(file: File, overlay = false) {
		const allowed = overlay ? ['image/png', 'image/gif', 'image/webp'] : ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
		if (!allowed.includes(file.type)) throw new Error(overlay ? 'Choose a PNG, GIF or WebP overlay.' : 'Choose a PNG, JPEG, GIF or WebP banner.');
		if (file.size > PROFILE_MEDIA_LIMIT) throw new Error('Export profile artwork at 10 MiB or less.');
	}
	async function removeAvatar() {
		if (avatarRemoving) return; avatarRemoving = true; avatarStatus = 'Removing avatar…';
		try { await saveProfilePatch({ profilePicture: '' }); avatarStatus = 'Avatar removed.'; }
		catch (error) { avatarStatus = error instanceof Error ? error.message : 'Could not remove your avatar.'; }
		finally { avatarRemoving = false; }
	}
	async function removeProfileMedia(kind: 'banner' | 'overlay') {
		if (kind === 'banner') { bannerUploading = true; bannerStatus = 'Removing banner…'; }
		else { overlayUploading = true; overlayStatus = 'Removing overlay…'; }
		try {
			await saveProfilePatch(kind === 'banner' ? { bannerUrl: '' } : { overlayUrl: '', overlayScale: 1, overlayOffsetX: 0, overlayOffsetY: 0 });
			if (kind === 'banner') bannerStatus = 'Banner removed.';
			else { overlayStatus = 'Overlay removed.'; overlayAlignMode = false; }
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Could not remove profile artwork.';
			if (kind === 'banner') bannerStatus = message; else overlayStatus = message;
		} finally { if (kind === 'banner') bannerUploading = false; else overlayUploading = false; }
	}

	async function uploadBanner(file: File) {
		if (!file) return;
		bannerUploading = true;
		bannerStatus = '';
		try {
			validateProfileMedia(file);
			const fd = new FormData();
			fd.append('file', file, file.name || 'banner.png');
			const res = await fetch(`${getServerUrl()}/api/upload-profile-media`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${getAuthToken()}` },
				body: fd
			});
			const payload = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(typeof payload?.error === 'string' ? payload.error : `Upload failed (${res.status})`);
			const url = typeof payload?.fileUrl === 'string' ? payload.fileUrl : '';
			if (!url) throw new Error('No URL returned');
			await saveProfilePatch({ bannerUrl: url });
			bannerStatus = 'Banner saved.';
		} catch (e) {
			bannerStatus = e instanceof Error ? e.message : 'Banner upload failed.';
		} finally {
			bannerUploading = false;
		}
	}

	async function uploadOverlay(file: File) {
		if (!file) return;
		const server = getServerUrl(), token = getAuthToken(), generation = authSessionGeneration(server);
		overlayUploading = true;
		overlayStatus = '';
		try {
			validateProfileMedia(file, true);
			const fd = new FormData();
			fd.append('file', file, file.name || 'overlay.png');
			const res = await fetch(`${server}/api/upload-profile-media`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${token}` },
				body: fd
			});
			const payload = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(typeof payload?.error === 'string' ? payload.error : `Upload failed (${res.status})`);
			const url = typeof payload?.fileUrl === 'string' ? payload.fileUrl : '';
			if (!url) throw new Error('No URL returned');
			if (server !== getServerUrl() || token !== getAuthToken() || generation !== authSessionGeneration(server)) return;
			overlayDraftOwner = overlayOwner();
			overlayPendingUrl = url;
			overlayDraftScale = 1; overlayDraftX = 0; overlayDraftY = 0; overlayAlignMode = true;
			overlayStatus = 'Position your new overlay, then save it. Your existing overlay stays published until you save.';
		} catch (e) {
			overlayStatus = e instanceof Error ? e.message : 'Overlay upload failed.';
		} finally {
			overlayUploading = false;
		}
	}

	async function onBannerFile(event: Event) {
		const input = event.currentTarget as HTMLInputElement; const file = input.files?.[0];
		if (file) await uploadBanner(file); input.value = '';
	}
	async function onOverlayFile(event: Event) {
		const input = event.currentTarget as HTMLInputElement; const file = input.files?.[0];
		if (file) await uploadOverlay(file); input.value = '';
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
	async function updateDisplayName() {
		if (updatingDisplayName) return;
		const nextName = displayNameDraft.trim();
		const bytes = new TextEncoder().encode(nextName).length;
		if (nextName.length < 2 || bytes > 32) { displayNameStatus = 'Use at least 2 characters and at most 32 bytes for your display name.'; return; }
		if (nextName === ($currentUser?.username || '')) return;
		updatingDisplayName = true; displayNameStatus = 'Saving name…';
		try { await saveProfilePatch({ username: nextName }); displayNameStatus = displayNameDraft.trim() === nextName ? 'Display name saved.' : 'Earlier name saved. Your newer edits are still a draft.'; }
		catch (error) { displayNameStatus = error instanceof Error ? error.message : 'Could not save your name.'; }
		finally { updatingDisplayName = false; }
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
		passwordError = '';
		passwordSuccess = '';
		if (!currentPasswordDraft || !newPasswordDraft || !confirmNewPasswordDraft) {
			passwordError = 'Fill in every field to update your password.';
			return;
		}
		if (newPasswordDraft !== confirmNewPasswordDraft) {
			passwordError = 'New password confirmation does not match.';
			return;
		}
		if (newPasswordDraft.length < 8) {
			passwordError = 'New password must be at least 8 characters.';
			return;
		}

		const token = getAuthToken();
		if (!token) {
			passwordError = 'You must be logged in to change password.';
			return;
		}

		changingPassword = true;
		try {
			await changePassword(token, currentPasswordDraft, newPasswordDraft);
			currentPasswordDraft = '';
			newPasswordDraft = '';
			confirmNewPasswordDraft = '';
			mustChangeOwnPassword = false;
			passwordStep = 1;
			passwordSuccess = 'Password updated.';
		} catch (error) {
			passwordError = error instanceof Error ? error.message : 'Failed to change password.';
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

</script>

<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" id="banner-file-input" class="hidden-file-input" onchange={onBannerFile} />
<input type="file" accept="image/png,image/gif,image/webp" id="overlay-file-input" class="hidden-file-input" onchange={onOverlayFile} />

<section class="profile-settings-layout">
	<div class="profile-preview-column">
		<p class="profile-preview-kicker">How others see you</p>
		<div class="profile-preview-card" aria-label="Live profile preview">
			<button
				type="button"
				class="profile-preview-banner"
				class:is-empty={!$currentUser?.bannerUrl || disableAllBannersLocal}
				style={`background: linear-gradient(135deg, ${$currentUser?.color || 'var(--accent-secondary-color)'}, var(--accent-primary-color))`}
				onclick={() => document.getElementById('banner-file-input')?.click()}
				disabled={bannerUploading}
				title={bannerUploading ? 'Uploading banner…' : 'Change banner'}
				aria-label="Change banner"
			>
				{#if $currentUser?.bannerUrl && !disableAllBannersLocal}<ProfileMedia src={mediaUrl($currentUser.bannerUrl)} class="profile-preview-banner-media" decorative={true} />{/if}
				<span class="profile-preview-banner-hint">{bannerUploading ? 'Uploading banner…' : 'Change banner'}</span>
			</button>
			<div class="profile-preview-avatar-wrap">
<button
					type="button"
					class="profile-preview-avatar"
					class:aligning={overlayAlignMode}
					onclick={() => { if (!overlayAlignMode) dispatch('openAvatarEditor'); }}
					onpointerdown={onOverlayPointerDown}
					onpointermove={onOverlayPointerMove}
					onpointerup={onOverlayPointerUp}
					onpointercancel={onOverlayPointerUp}
					onwheel={onOverlayWheel}
					title={overlayAlignMode ? 'Drag to move the overlay · scroll to scale' : 'Change avatar'}
					aria-label={overlayAlignMode ? 'Overlay alignment preview. Drag to move.' : 'Change avatar'}
					style={overlayAlignMode ? 'touch-action: none; cursor: move;' : undefined}
				>
					{#if $currentUser?.profilePicture}
						<ProfileMedia src={mediaUrl($currentUser.profilePicture)} class="profile-preview-avatar-media" decorative={true} />
					{:else}
						<span class="profile-preview-avatar-fallback" style="--avatar-color: {$currentUser?.color || 'var(--accent-primary-color)'}">
							{previewName.charAt(0).toUpperCase()}
						</span>
					{/if}
					{#if ($currentUser?.overlayUrl || overlayPendingUrl) && !disableAllBannersLocal}
						<ProfileDecoration user={overlayPreviewUser} class="profile-preview-overlay" />
					{/if}

				</button>
				<details class="profile-presence-picker">
					<summary class="profile-preview-status" class:away={selectedPresence === 'away'} class:busy={selectedPresence === 'busy'} class:offline={selectedPresence === 'invisible'} aria-label={`Presence: ${selectedPresence}. Change presence`} title="Change presence"></summary>
					<div class="profile-presence-menu" role="group" aria-label="Presence">
						{#each ['active', 'away', 'busy', 'invisible'] as status}
							<button type="button" aria-pressed={selectedPresence === status} onclick={(event) => { changeStatus(status as PresenceState); event.currentTarget.closest('details')?.removeAttribute('open'); }}>{status === 'active' ? 'Online' : status === 'away' ? 'Away' : status === 'busy' ? 'Busy' : 'Invisible'}</button>
						{/each}
					</div>
				</details>
			</div>
			<div class="profile-preview-edit-tools">
				<button type="button" class="action-btn secondary small" onclick={() => dispatch('openAvatarEditor')}>Change avatar</button>
				<button type="button" class="action-btn secondary small" onclick={() => document.getElementById('overlay-file-input')?.click()} disabled={overlayUploading || overlayAlignSaving}>{overlayUploading ? 'Uploading…' : 'Change overlay'}</button>
				{#if $currentUser?.overlayUrl && !overlayAlignMode}<button type="button" class="action-btn secondary small" onclick={enterOverlayAlign}>Position overlay</button>{/if}
			</div>
			{#if overlayAlignMode}
				<div class="overlay-align-editor" role="group" aria-label="Overlay alignment">
					<p class="runtime-note">Drag the preview to move · scroll or use −/+ to scale.</p>
					<div class="overlay-align-row">
						<button type="button" class="action-btn secondary small" onclick={() => nudgeOverlayScale(-0.05)} aria-label="Decrease overlay scale">−</button>
						<span class="runtime-note" aria-live="polite">Scale {overlayDraftScale.toFixed(2)}×</span>
						<button type="button" class="action-btn secondary small" onclick={() => nudgeOverlayScale(0.05)} aria-label="Increase overlay scale">+</button>
					</div>
					<div class="overlay-align-row">
						<button type="button" class="action-btn secondary small" onclick={resetOverlayAlign}>Reset</button>
						<button type="button" class="action-btn secondary small" onclick={cancelOverlayAlign}>Cancel</button>
						<button type="button" class="action-btn small" onclick={saveOverlayAlign} disabled={overlayAlignSaving}>
							{overlayAlignSaving ? 'Saving…' : 'Save alignment'}
						</button>
					</div>
				</div>
			{/if}
			<div class="profile-preview-body">
				<strong class="profile-preview-name"><ProfileName username={previewName} font={$currentUser?.usernameFont} color={$currentUser?.color} preview={true} /></strong>
				<span class="profile-preview-handle">{previewHandle}</span>
				{#if bioDraft.trim()}
					<p class="profile-preview-bio">{bioDraft.trim()}</p>
				{/if}
				{#if $currentUser?.joinedAt}<span class="profile-preview-meta">Member since {previewJoined}</span>{/if}
			</div>
		</div>
	</div>

	<div class="profile-editor-column">
<div class="profile-mock">
	<div class="profile-mock-body">

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
					onclick={updateDisplayName}
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

			<label class="setting-label" for="profile-status-message">Status message</label>
			<input id="profile-status-message" type="text" maxlength="120" bind:value={statusMessageDraft} placeholder="What are you up to?" class="profile-mock-bio" />
			<div class="profile-bio-actions">
				<button type="button" class="profile-mock-save ghost" onclick={saveStatusMessage} disabled={statusMessageSaving || statusMessageBytes > 120}>{statusMessageSaving ? 'Saving…' : 'Save status message'}</button>
				<span class="runtime-note">{statusMessageBytes}/120 bytes</span>
			</div>
			{#if statusMessageBytes > 120}<p class="profile-bio-error" role="alert">Shorten this status message before saving. Emoji can use more than one byte.</p>{/if}
			{#if statusMessageFeedback}<p class="runtime-note" role="status">{statusMessageFeedback}</p>{/if}
			<textarea
				class="profile-mock-bio"
				rows="2"
				maxlength="280"
				bind:value={bioDraft}
				placeholder="About me…"
				aria-label="About me"
			></textarea>
			{#if bioBytes > 280}<p class="profile-bio-error" role="alert">About me is too long. Emoji and some letters use more than one byte; shorten it before saving.</p>{/if}
			<div class="profile-mock-bio-bar">
				<button type="button" class="profile-mock-save ghost" onclick={saveBio} disabled={bioSaving || bioBytes > 280}>{bioSaving ? 'Saving…' : 'Save bio'}</button><span class="runtime-note" class:bio-over-limit={bioBytes > 280}>{bioBytes}/280 bytes</span>
				{#if bioStatus}<span class="runtime-note" role="status">{bioStatus}</span>{/if}
				{#if displayNameStatus}<span class="runtime-note" role="status">{displayNameStatus}</span>{/if}
				{#if bannerStatus}<span class="runtime-note">{bannerStatus}</span>{/if}
				{#if overlayStatus}<span class="runtime-note" role="status">{overlayStatus}</span>{/if}
				{#if avatarStatus}<span class="runtime-note" role="status">{avatarStatus}</span>{/if}
			</div>
		</div>
	</div>

	<details class="profile-art-reset"><summary>Remove artwork</summary>
		<div class="profile-art-actions">
			{#if $currentUser?.profilePicture}<button type="button" class="action-btn secondary small" disabled={avatarRemoving} onclick={removeAvatar}>Remove avatar</button>{/if}
			{#if $currentUser?.bannerUrl}<button type="button" class="action-btn secondary small" disabled={bannerUploading} onclick={() => removeProfileMedia('banner')}>Remove banner</button>{/if}
			{#if $currentUser?.overlayUrl}<button type="button" class="action-btn secondary small" disabled={overlayUploading || overlayAlignSaving} onclick={() => removeProfileMedia('overlay')}>Remove overlay</button>{/if}
		</div>
	</details>


</div>
	</div>
</section>

<div class="settings-section">
	<div class="settings-group-card tight">
		<div class="setting-item-full" style="padding-top:0.55rem">
			<UsernameFontCustomizer bind:this={nameDesignStudio} />
		</div>
	</div>
</div>

<div class="settings-section profile-art-resources">	<details class="profile-art-guide">
		<summary>Artwork resources · Templates and examples</summary>
		<p><strong>Banner:</strong> 1200 × 400 px, 3:1. Export PNG, JPEG, GIF or WebP at 10 MiB or less. Keep key artwork inside the guide’s safe area; the avatar overlaps the lower left and smaller views may crop the edges.</p>
		<p><strong>Avatar overlay:</strong> 512 × 512 px with a transparent center. Check the rounded square profile crop and circular message/People crops. PNG for still art; GIF or WebP for animation. Scale and position it with Adjust overlay.</p>
		<p><strong>Animation:</strong> export a looping GIF or animated WebP at 10 MiB or less. A 3–6 second seamless loop at 12–24 fps is a useful starting point. Choose a calm still frame: viewers can pause artwork or use reduced motion. Videos and SVG uploads are not profile artwork formats.</p>
		<div class="profile-guide-downloads"><a href="/profile-art/banner-guide.svg" download>Banner template · SVG</a><a href="/profile-art/avatar-overlay-guide.svg" download>Overlay template · SVG</a><a href="/profile-art/artist-guide.md" download>Full artist guide</a></div>
		<ProfileArtExamples onUseDesign={(example) => nameDesignStudio?.loadExampleDraft(example)} />
	</details>
</div>

{#if $currentUser?.badges?.length}
	<div class="settings-section">
		<h3>Badges</h3>
		<div class="settings-group-card tight">
			<div class="setting-item-full">
				<div class="setting-info">
					<span class="setting-label">Assigned by server admins</span>
					<span class="setting-description">Shown next to your name across the app.</span>
				</div>
				<RoleBadge user={$currentUser} size="md" maxBadges={8} />
			</div>
		</div>
	</div>
{/if}

<!-- 2026-08-27: payment surfaces are omitted entirely unless the server
     explicitly permits payments (canViewPaymentUi). -->
{#if $paymentAccessStore.canViewPaymentUi}
<div class="settings-section">
	<div class="icon-action-row">
		<button type="button" class="icon-action" title="Payment requests you created" onclick={openPaymentHistorySafe} disabled={!$currentUser?.dbUserId}>
			<span class="icon-action-glyph" aria-hidden="true">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7h18v10H3z"/><path d="M3 10h18"/><path d="M7 15h4"/></svg>
			</span>
			<span class="icon-action-label">History</span>
		</button>
		<button type="button" class="icon-action" title="Saved non-sensitive payment references" onclick={openPaymentConnectionsSafe} disabled={!$currentUser?.dbUserId}>
			<span class="icon-action-glyph" aria-hidden="true">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18"/><path d="M7 15h2"/></svg>
			</span>
			<span class="icon-action-label">Refs</span>
		</button>
		<button type="button" class="icon-action" title="Support this server" onclick={() => dispatch('openServerDonation')}>
			<span class="icon-action-glyph" aria-hidden="true">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 11c0 5.5-7 10-7 10z"/></svg>
			</span>
			<span class="icon-action-label">Support</span>
		</button>
	</div>
</div>
{/if}

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

				{#if passwordStep === 1}
					<div class="pwd-step">
						<input
							type="password"
							class="emoji-name-input"
							placeholder="Current password"
							bind:value={currentPasswordDraft}
							bind:this={currentPasswordInput}
							autocomplete="current-password"
							onkeydown={(e) => { if (e.key === 'Enter') advancePasswordStep(); }}
						/>
						<button type="button" class="action-btn" onclick={advancePasswordStep}>Continue</button>
					</div>
				{:else}
					<div class="pwd-step">
						<button type="button" class="action-btn secondary small" onclick={backPasswordStep} title="Back to current password">
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>
							Back
						</button>
						<div class="pwd-grid">
							<input type="password" class="emoji-name-input" placeholder="New password" data-pwd-new bind:value={newPasswordDraft} autocomplete="new-password" />
							<input type="password" class="emoji-name-input" placeholder="Confirm new password" bind:value={confirmNewPasswordDraft} autocomplete="new-password" onkeydown={(e) => { if (e.key === 'Enter') changeOwnPassword(); }} />
							<button type="button" class="action-btn" onclick={changeOwnPassword} disabled={changingPassword}>
								{changingPassword ? '…' : 'Update password'}
							</button>
						</div>
					</div>
				{/if}
				{#if passwordError}
					<p class="pwd-feedback pwd-error" role="alert">{passwordError}</p>
				{/if}
				{#if passwordSuccess}
					<p class="pwd-feedback pwd-success" role="status">{passwordSuccess}</p>
				{/if}
			</div>

			<div class="setting-item-full">
				<div class="local-accounts-head">
					<div class="setting-info">
						<span class="setting-label">Local accounts</span>
						<span class="setting-description">Default: {$defaultLocalWabiAccountStore ? getLocalWabiAccountDisplayLabel($defaultLocalWabiAccountStore) : 'none'}</span>
					</div>
					<button
						type="button"
						class="action-btn secondary small"
						onclick={makeCurrentLocalWabiDefault}
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
							type="button"
							class="action-btn secondary small"
							onclick={importProfileFromSelectedLocalWabiAccount}
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
