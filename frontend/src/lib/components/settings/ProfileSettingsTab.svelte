<script lang="ts">
	/**
	 * Settings › Profile (design contract §8.9): a flat preview of how members see you, then one
	 * form (display name, status message, About me) with one save. The sticky footer
	 * "Unsaved changes · Discard · Save" appears only while the drafts differ from what is
	 * published, and Save sends the changed fields in a single profile update. Pictures, presence
	 * and the password act right away, each with its own words.
	 */
	import { createEventDispatcher, onMount, tick, untrack } from 'svelte';
	import { brandName } from '$lib/branding';
	import { currentUser } from '$lib/socket';
	import { saveProfilePatch } from '$lib/profileSave';
	import { selectPresence, getStoredPresence, type PresenceState } from '$lib/presenceControl';
	import { profileDecorationsVisible } from '$lib/profileAppearance';
	import ProfileName from '$lib/components/ProfileName.svelte';
	import { getAuthToken, authSessionGeneration } from '$lib/authSession';
	import { paymentAccessStore } from '$lib/payments/paymentAccessStore';
	import { activeServerUrl, getServerUrl } from '$lib/serverUrl';
	import { currentSavedServer } from '$lib/savedServers';
	import { changePassword, getUserSettings } from '$lib/api';
	import { clearActiveCustomStatusPreset } from '$lib/customStatusPresets';
	import { confirmAction } from '$lib/confirm';
	import { inkFor } from '$lib/theme/identity';
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
	import Icon from '../ui/Icon.svelte';
	import Segmented from '../ui/Segmented.svelte';
	import Select from '../ui/Select.svelte';
	import { mediaUrl } from '$lib/mediaUrl';
	import {
		PROFILE_LIMITS,
		isProfileDirty,
		profileCounter,
		profileIssues,
		profilePatch,
		publishedAfterSave,
		trimmedDraft,
		type ProfileDraft
	} from './profileForm';

	const dispatch = createEventDispatcher<{
		openAvatarEditor: void;
		openPaymentHistory: void;
		openPaymentConnections: void;
		openServerDonation: void;
	}>();

	let { passwordChangeRequest = 0 } = $props();
	let nameDesignStudio = $state<{ loadExampleDraft: (example: ProfileArtExample) => void } | null>(null);
	let lastHandledPasswordChangeRequest = $state(0);
	let guideOpen = $state(false);

	const communityName = $derived($currentSavedServer?.effectiveName?.trim() || 'this community');

	// ── The form: drafts against what is published ──
	let draft = $state<ProfileDraft>({ name: '', status: '', bio: '' });
	let published = $state<ProfileDraft>({ name: '', status: '', bio: '' });
	let loadedProfileIdentity = $state('');
	let saving = $state(false);
	let saveError = $state('');
	let savedAt = $state('');
	let showIssues = $state(false);

	const dirty = $derived(isProfileDirty(draft, published));
	const issues = $derived(profileIssues(draft));
	const canSave = $derived(dirty && !saving && Object.keys(issues).length === 0);

	function fromUser(): ProfileDraft {
		return {
			name: $currentUser?.username || '',
			status: $currentUser?.statusMessage || '',
			bio: $currentUser?.bio || ''
		};
	}

	$effect(() => {
		const identity = `${getServerUrl()}:${$currentUser?.dbUserId ?? $currentUser?.id ?? ''}`;
		const incoming = fromUser();
		untrack(() => {
			if (!$currentUser) return;
			if (identity !== loadedProfileIdentity) {
				// A different account or server: start from its published profile.
				loadedProfileIdentity = identity;
				published = incoming;
				draft = { ...incoming };
				saveError = '';
				savedAt = '';
				showIssues = false;
				return;
			}
			// The same account changed elsewhere: follow it unless you are mid-edit.
			if (!saving && !isProfileDirty(draft, published) && isProfileDirty(incoming, published)) {
				published = incoming;
				draft = { ...incoming };
			}
		});
	});

	function discard(): void {
		if (saving) return;
		draft = { ...published };
		saveError = '';
		showIssues = false;
	}

	async function save(): Promise<void> {
		if (saving || !dirty) return;
		if (Object.keys(issues).length) {
			showIssues = true;
			return;
		}
		const submitted = trimmedDraft(draft);
		const patch = profilePatch(submitted, published);
		saving = true;
		saveError = '';
		try {
			await saveProfilePatch({ ...patch });
			published = publishedAfterSave(published, submitted);
			// Keep edits made while the save was in flight; otherwise settle on the trimmed text.
			if (!isProfileDirty(draft, submitted)) draft = { ...published };
			savedAt = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
			showIssues = false;
		} catch (error) {
			saveError = error instanceof Error ? error.message : 'The server did not confirm the save.';
		} finally {
			saving = false;
		}
	}

	function handleFormKeydown(event: KeyboardEvent): void {
		// Ctrl/⌘ Enter saves from any field, including About me.
		if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			void save();
		}
	}

	// ── Presence (applies right away) ──
	let selectedPresence = $state<PresenceState>(getStoredPresence());
	const PRESENCE_OPTIONS: { value: PresenceState; label: string }[] = [
		{ value: 'active', label: 'Online' },
		{ value: 'away', label: 'Away' },
		{ value: 'busy', label: 'Busy' },
		{ value: 'invisible', label: 'Invisible' }
	];
	function changePresence(next: PresenceState): void {
		clearActiveCustomStatusPreset();
		selectedPresence = next;
		selectPresence(next);
	}

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
	const localAccountOptions = $derived(
		otherLocalWabiAccounts.map((account) => ({ value: account.key, label: getLocalWabiAccountDisplayLabel(account) }))
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

	function makeCurrentLocalWabiDefault(): void {
		if (!currentLocalWabiAccountKey) return;
		setDefaultLocalWabiAccount(currentLocalWabiAccountKey);
		linkedWabiImportStatus = `This account is now the default ${brandName} profile on this device.`;
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
				linkedWabiImportStatus = result.errors.join(' ') || 'The import did not finish.';
				return;
			}
			linkedWabiImportStatus = `Copied ${result.importedFields.join(' and ')}.`;
		} finally {
			linkedWabiImporting = false;
		}
	}

	// ── Password (two steps) ──
	let currentPasswordDraft = $state('');
	let newPasswordDraft = $state('');
	let confirmNewPasswordDraft = $state('');
	let currentPasswordInput = $state<HTMLInputElement | null>(null);
	let newPasswordInput = $state<HTMLInputElement | null>(null);
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
		void tick().then(() => newPasswordInput?.focus());
	}

	function backPasswordStep(): void {
		passwordStep = 1;
		passwordError = '';
		passwordSuccess = '';
		void tick().then(() => currentPasswordInput?.focus());
	}

	async function changeOwnPassword(): Promise<void> {
		if (changingPassword) return;
		passwordError = '';
		passwordSuccess = '';
		if (!currentPasswordDraft || !newPasswordDraft || !confirmNewPasswordDraft) {
			passwordError = 'Fill in every field to change your password.';
			return;
		}
		if (newPasswordDraft !== confirmNewPasswordDraft) {
			passwordError = 'The new passwords do not match.';
			return;
		}
		if (newPasswordDraft.length < 8) {
			passwordError = 'Use at least 8 characters for the new password.';
			return;
		}
		const token = getAuthToken();
		if (!token) {
			passwordError = 'Sign in again to change your password.';
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
			passwordSuccess = 'Password changed.';
		} catch (error) {
			passwordError = error instanceof Error ? error.message : 'The password was not changed.';
		} finally {
			changingPassword = false;
		}
	}

	async function focusPasswordChangeForm(): Promise<void> {
		await tick();
		currentPasswordInput?.scrollIntoView({ block: 'center', behavior: 'smooth' });
		currentPasswordInput?.focus();
	}

	$effect(() => {
		if (passwordChangeRequest > lastHandledPasswordChangeRequest) {
			lastHandledPasswordChangeRequest = passwordChangeRequest;
			void focusPasswordChangeForm();
		}
	});

	// ── Pictures: banner and avatar overlay ──
	let bannerUploading = $state(false);
	let overlayUploading = $state(false);
	let avatarRemoving = $state(false);
	let mediaStatus = $state('');
	const decorationsHidden = $derived(!$profileDecorationsVisible);

	// Overlay alignment (per-user scale + X/Y offset), drafted on the preview avatar.
	let overlayAlignMode = $state(false);
	let overlayPendingUrl = $state('');
	let overlayDraftOwner = $state('');
	let overlayDraftScale = $state(1);
	let overlayDraftX = $state(0);
	let overlayDraftY = $state(0);
	let overlayAlignSaving = $state(false);
	let overlayDrag: { pointerId: number; startX: number; startY: number; baseX: number; baseY: number } | null = null;

	function overlayOwner() {
		return `${getServerUrl()}:${$currentUser?.dbUserId ?? $currentUser?.id ?? ''}:${authSessionGeneration(getServerUrl())}`;
	}
	$effect(() => {
		void $activeServerUrl;
		void $currentUser?.id;
		if (overlayDraftOwner && overlayDraftOwner !== overlayOwner()) {
			overlayPendingUrl = '';
			overlayAlignMode = false;
			overlayDraftOwner = '';
			overlayDrag = null;
		}
	});
	const overlayPreviewUser = $derived(
		overlayAlignMode
			? { overlayUrl: overlayPendingUrl || $currentUser?.overlayUrl, overlayScale: overlayDraftScale, overlayOffsetX: overlayDraftX, overlayOffsetY: overlayDraftY }
			: { overlayUrl: $currentUser?.overlayUrl, overlayScale: $currentUser?.overlayScale, overlayOffsetX: $currentUser?.overlayOffsetX, overlayOffsetY: $currentUser?.overlayOffsetY }
	);

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
		mediaStatus = '';
	}

	function cancelOverlayAlign() {
		if (overlayAlignSaving) return;
		mediaStatus = overlayPendingUrl ? 'New overlay discarded. Your published overlay is unchanged.' : 'Overlay position unchanged.';
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
		if (overlayDraftOwner !== overlayOwner()) {
			cancelOverlayAlign();
			mediaStatus = 'Your account changed. Choose the overlay again.';
			return;
		}
		clampOverlayDrafts();
		overlayAlignSaving = true;
		mediaStatus = 'Saving the overlay position…';
		try {
			await saveProfilePatch({ ...(overlayPendingUrl ? { overlayUrl: overlayPendingUrl } : {}), overlayScale: overlayDraftScale, overlayOffsetX: overlayDraftX, overlayOffsetY: overlayDraftY });
			overlayPendingUrl = '';
			mediaStatus = 'Overlay saved.';
			overlayAlignMode = false;
		} catch (error) {
			mediaStatus = error instanceof Error ? error.message : 'The overlay was not saved.';
		} finally {
			overlayAlignSaving = false;
		}
	}

	function onOverlayPointerDown(e: PointerEvent) {
		if (!overlayAlignMode || overlayAlignSaving) return;
		(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
		overlayDrag = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, baseX: overlayDraftX, baseY: overlayDraftY };
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

	/** Arrow keys move the overlay 2px (10 with Shift); + and − scale it. */
	function onOverlayKeydown(e: KeyboardEvent) {
		if (!overlayAlignMode || overlayAlignSaving) return;
		const step = e.shiftKey ? 10 : 2;
		const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
		if (moves[e.key]) {
			e.preventDefault();
			const [dx, dy] = moves[e.key];
			overlayDraftX = Math.min(200, Math.max(-200, overlayDraftX + dx));
			overlayDraftY = Math.min(200, Math.max(-200, overlayDraftY + dy));
		} else if (e.key === '+' || e.key === '=') {
			e.preventDefault();
			nudgeOverlayScale(0.05);
		} else if (e.key === '-') {
			e.preventDefault();
			nudgeOverlayScale(-0.05);
		}
	}

	function onPreviewAvatarClick() {
		if (!overlayAlignMode) dispatch('openAvatarEditor');
	}

	const PROFILE_MEDIA_LIMIT = 10 * 1024 * 1024;
	function validateProfileMedia(file: File, overlay = false) {
		const allowed = overlay ? ['image/png', 'image/gif', 'image/webp'] : ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
		if (!allowed.includes(file.type)) throw new Error(overlay ? 'Choose a PNG, GIF or WebP overlay.' : 'Choose a PNG, JPEG, GIF or WebP banner.');
		if (file.size > PROFILE_MEDIA_LIMIT) throw new Error('Export profile artwork at 10 MiB or less.');
	}

	async function removeAvatar() {
		if (avatarRemoving) return;
		const confirmed = await confirmAction({
			title: 'Remove your profile picture?',
			body: `Members of ${communityName} will see your initial instead.`,
			confirm: 'Remove picture',
			danger: true
		});
		if (!confirmed) return;
		avatarRemoving = true;
		mediaStatus = 'Removing your profile picture…';
		try {
			await saveProfilePatch({ profilePicture: '' });
			mediaStatus = 'Profile picture removed.';
		} catch (error) {
			mediaStatus = error instanceof Error ? error.message : 'Your profile picture was not removed.';
		} finally {
			avatarRemoving = false;
		}
	}

	async function removeProfileMedia(kind: 'banner' | 'overlay') {
		const confirmed = await confirmAction({
			title: kind === 'banner' ? 'Remove your banner?' : 'Remove your avatar overlay?',
			body: kind === 'banner' ? 'Your profile shows a plain band instead.' : 'Your profile picture shows without it.',
			confirm: kind === 'banner' ? 'Remove banner' : 'Remove overlay',
			danger: true
		});
		if (!confirmed) return;
		if (kind === 'banner') bannerUploading = true;
		else overlayUploading = true;
		mediaStatus = kind === 'banner' ? 'Removing your banner…' : 'Removing your overlay…';
		try {
			await saveProfilePatch(kind === 'banner' ? { bannerUrl: '' } : { overlayUrl: '', overlayScale: 1, overlayOffsetX: 0, overlayOffsetY: 0 });
			mediaStatus = kind === 'banner' ? 'Banner removed.' : 'Overlay removed.';
			if (kind === 'overlay') overlayAlignMode = false;
		} catch (error) {
			mediaStatus = error instanceof Error ? error.message : 'The artwork was not removed.';
		} finally {
			if (kind === 'banner') bannerUploading = false;
			else overlayUploading = false;
		}
	}

	async function uploadProfileMedia(file: File): Promise<string> {
		const server = getServerUrl();
		const fd = new FormData();
		fd.append('file', file, file.name || 'artwork.png');
		const res = await fetch(`${server}/api/upload-profile-media`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${getAuthToken()}` },
			body: fd
		});
		const payload = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(typeof payload?.error === 'string' ? payload.error : `The upload did not finish (${res.status}).`);
		const url = typeof payload?.fileUrl === 'string' ? payload.fileUrl : '';
		if (!url) throw new Error('The server did not return the uploaded file.');
		return url;
	}

	async function uploadBanner(file: File) {
		bannerUploading = true;
		mediaStatus = 'Uploading your banner…';
		try {
			validateProfileMedia(file);
			const url = await uploadProfileMedia(file);
			await saveProfilePatch({ bannerUrl: url });
			mediaStatus = 'Banner saved.';
		} catch (e) {
			mediaStatus = e instanceof Error ? e.message : 'The banner was not uploaded.';
		} finally {
			bannerUploading = false;
		}
	}

	async function uploadOverlay(file: File) {
		const server = getServerUrl(), token = getAuthToken(), generation = authSessionGeneration(server);
		overlayUploading = true;
		mediaStatus = 'Uploading your overlay…';
		try {
			validateProfileMedia(file, true);
			const url = await uploadProfileMedia(file);
			if (server !== getServerUrl() || token !== getAuthToken() || generation !== authSessionGeneration(server)) return;
			overlayDraftOwner = overlayOwner();
			overlayPendingUrl = url;
			overlayDraftScale = 1;
			overlayDraftX = 0;
			overlayDraftY = 0;
			overlayAlignMode = true;
			mediaStatus = 'Position the new overlay, then save it. Your published overlay stays until you do.';
		} catch (e) {
			mediaStatus = e instanceof Error ? e.message : 'The overlay was not uploaded.';
		} finally {
			overlayUploading = false;
		}
	}

	async function onBannerFile(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (file) await uploadBanner(file);
		input.value = '';
	}

	async function onOverlayFile(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (file) await uploadOverlay(file);
		input.value = '';
	}

	let bannerInput = $state<HTMLInputElement | null>(null);
	let overlayInput = $state<HTMLInputElement | null>(null);

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

	// ── Preview ──
	const previewName = $derived(draft.name.trim() || $currentUser?.username || 'You');
	const previewHandle = $derived(
		$currentUser?.handle ? `@${$currentUser.handle}` : $currentUser?.dbUserId ? 'Registered account' : 'Local account'
	);
	const previewJoined = $derived(
		$currentUser?.joinedAt
			? new Date($currentUser.joinedAt).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
			: ''
	);
	const presenceWord = $derived(PRESENCE_OPTIONS.find((option) => option.value === selectedPresence)?.label ?? 'Online');
	const identityVars = $derived($inkFor($currentUser?.color));
	const hasBanner = $derived(Boolean($currentUser?.bannerUrl) && !decorationsHidden);
	const mediaBusy = $derived(bannerUploading || overlayUploading || avatarRemoving || overlayAlignSaving);
</script>

<input bind:this={bannerInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" class="hidden-file-input" tabindex="-1" aria-hidden="true" onchange={onBannerFile} />
<input bind:this={overlayInput} type="file" accept="image/png,image/gif,image/webp" class="hidden-file-input" tabindex="-1" aria-hidden="true" onchange={onOverlayFile} />

<div class="w-profile">
	<!-- How members see you: a flat preview, not a second editor. -->
	<section class="w-profile__preview" aria-labelledby="profile-preview-kicker">
		<p class="w-kicker" id="profile-preview-kicker">How others see you</p>
		<div class="w-profile-card" style={identityVars}>
			<div class="w-profile-card__banner" class:has-media={hasBanner} aria-hidden="true">
				{#if hasBanner && $currentUser?.bannerUrl}<ProfileMedia src={mediaUrl($currentUser.bannerUrl)} class="w-profile-card__banner-media" decorative={true} />{/if}
			</div>
			<div class="w-profile-card__body">
				<button
					type="button"
					class="w-profile-card__avatar"
					class:aligning={overlayAlignMode}
					onclick={onPreviewAvatarClick}
					onpointerdown={onOverlayPointerDown}
					onpointermove={onOverlayPointerMove}
					onpointerup={onOverlayPointerUp}
					onpointercancel={onOverlayPointerUp}
					onwheel={onOverlayWheel}
					onkeydown={onOverlayKeydown}
					aria-label={overlayAlignMode ? 'Overlay position. Drag or use the arrow keys to move it; plus and minus change its size.' : 'Change profile picture'}
					aria-describedby={overlayAlignMode ? 'profile-overlay-help' : undefined}
				>
					{#if $currentUser?.profilePicture}
						<ProfileMedia src={mediaUrl($currentUser.profilePicture)} class="w-profile-card__avatar-media" decorative={true} />
					{:else}
						<span class="w-profile-card__initial" aria-hidden="true">{previewName.charAt(0).toUpperCase()}</span>
					{/if}
					{#if ($currentUser?.overlayUrl || overlayPendingUrl) && !decorationsHidden}
						<ProfileDecoration user={overlayPreviewUser} class="w-profile-card__overlay" />
					{/if}
					<span class="w-profile-card__presence" data-presence={selectedPresence} aria-hidden="true"></span>
				</button>
				<div class="w-profile-card__who">
					<p class="w-profile-card__name"><ProfileName username={previewName} font={$currentUser?.usernameFont} color={$currentUser?.color} preview={true} /></p>
					<p class="w-profile-card__handle">{previewHandle}<span aria-hidden="true">{' · '}</span>{presenceWord}</p>
				</div>
				{#if draft.status.trim()}<p class="w-profile-card__status">{draft.status.trim()}</p>{/if}
				{#if draft.bio.trim()}<p class="w-profile-card__bio">{draft.bio.trim()}</p>{/if}
				{#if previewJoined}<p class="w-profile-card__meta">Member since {previewJoined}</p>{/if}
			</div>
		</div>
		{#if overlayAlignMode}
			<div class="w-profile-align" role="group" aria-label="Overlay position">
				<p class="w-profile-align__help" id="profile-overlay-help">Drag the picture above to move the overlay. Scroll, or use − and +, to change its size.</p>
				<div class="w-profile-align__controls">
					<span class="w-profile-align__scale">
						<button type="button" class="w-ibtn w-ibtn--sm w-ibtn--edge" onclick={() => nudgeOverlayScale(-0.05)} aria-label="Make the overlay smaller" disabled={overlayAlignSaving}><Icon name="minus" /></button>
						<span class="w-profile-align__value" aria-live="polite">{Math.round(overlayDraftScale * 100)}%</span>
						<button type="button" class="w-ibtn w-ibtn--sm w-ibtn--edge" onclick={() => nudgeOverlayScale(0.05)} aria-label="Make the overlay larger" disabled={overlayAlignSaving}><Icon name="plus" /></button>
					</span>
					<button type="button" class="w-btn w-btn--sm w-btn--quiet" onclick={resetOverlayAlign} disabled={overlayAlignSaving}>Reset</button>
					<span class="w-profile-align__end">
						<button type="button" class="w-btn w-btn--sm w-btn--quiet" onclick={cancelOverlayAlign} disabled={overlayAlignSaving}>Cancel</button>
						<button type="button" class="w-btn w-btn--sm w-btn--primary" onclick={saveOverlayAlign} disabled={overlayAlignSaving} aria-busy={overlayAlignSaving}>
							{overlayAlignSaving ? 'Saving…' : 'Save overlay'}
						</button>
					</span>
				</div>
			</div>
		{/if}
	</section>

	<!-- The one form: name, status, About me. -->
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<form
		class="settings-block w-profile__form"
		aria-labelledby="profile-about-title"
		onsubmit={(event) => { event.preventDefault(); void save(); }}
		onkeydown={handleFormKeydown}
	>
		<div class="settings-block__head">
			<h3 class="settings-block__title" id="profile-about-title">About you</h3>
			<p class="w-profile__saved" role="status">{#if savedAt && !dirty}Saved {savedAt}{/if}</p>
		</div>
		<p class="settings-block__hint">Members of {communityName} see this next to your messages and on your profile.</p>

		<div class="w-profile-field">
			<label class="w-label" for="profile-display-name">Display name</label>
			<input
				id="profile-display-name"
				class="w-field"
				type="text"
				maxlength={PROFILE_LIMITS.name}
				autocomplete="nickname"
				bind:value={draft.name}
				aria-invalid={showIssues && issues.name ? 'true' : undefined}
				aria-describedby="profile-display-name-foot"
			/>
			<div class="w-field-foot" id="profile-display-name-foot">
				{#if (showIssues || draft.name.trim().length > 0) && issues.name}<span class="w-field-error"><Icon name="alert" />{issues.name}</span>{/if}
				<span class="w-field-count">{profileCounter(draft.name, PROFILE_LIMITS.name)}</span>
			</div>
		</div>

		<div class="w-profile-field">
			<label class="w-label" for="profile-status-message">Status message</label>
			<input
				id="profile-status-message"
				class="w-field"
				type="text"
				maxlength={PROFILE_LIMITS.status}
				placeholder="Out walking until 3"
				bind:value={draft.status}
				aria-invalid={issues.status ? 'true' : undefined}
				aria-describedby="profile-status-message-foot"
			/>
			<div class="w-field-foot" id="profile-status-message-foot">
				{#if issues.status}<span class="w-field-error"><Icon name="alert" />{issues.status}</span>{/if}
				<span class="w-field-count">{profileCounter(draft.status, PROFILE_LIMITS.status)}</span>
			</div>
		</div>

		<div class="w-profile-field">
			<label class="w-label" for="profile-about-me">About me</label>
			<textarea
				id="profile-about-me"
				class="w-field"
				rows="3"
				maxlength={PROFILE_LIMITS.bio}
				placeholder="A line or two about you"
				bind:value={draft.bio}
				aria-invalid={issues.bio ? 'true' : undefined}
				aria-describedby="profile-about-me-foot"
			></textarea>
			<div class="w-field-foot" id="profile-about-me-foot">
				{#if issues.bio}<span class="w-field-error"><Icon name="alert" />{issues.bio}</span>{/if}
				<span class="w-field-count">{profileCounter(draft.bio, PROFILE_LIMITS.bio)}</span>
			</div>
		</div>
	</form>

	<section class="settings-block" aria-labelledby="profile-presence-title">
		<h3 class="settings-block__title" id="profile-presence-title">Presence</h3>
		<div class="w-srows">
			<div class="w-srow">
				<div class="w-srow__text">
					<p class="w-srow__label" id="profile-presence-label">Show me as</p>
					<p class="w-srow__hint">Changes right away. Invisible members appear offline.</p>
				</div>
				<div class="w-srow__control">
					<Segmented labelledby="profile-presence-label" options={PRESENCE_OPTIONS} value={selectedPresence} onchange={(value) => changePresence(value as PresenceState)} />
				</div>
			</div>
		</div>
	</section>

	<section class="settings-block" aria-labelledby="profile-pictures-title">
		<h3 class="settings-block__title" id="profile-pictures-title">Pictures</h3>
		<p class="settings-block__hint">Changes publish when the upload finishes.</p>
		<div class="w-srows">
			<div class="w-srow">
				<div class="w-srow__text">
					<p class="w-srow__label">Profile picture</p>
					<p class="w-srow__hint">Shown beside your messages and in People.</p>
				</div>
				<div class="w-srow__control">
					{#if $currentUser?.profilePicture}<button type="button" class="w-btn w-btn--sm w-btn--quiet" disabled={mediaBusy} onclick={removeAvatar}>Remove</button>{/if}
					<button type="button" class="w-btn w-btn--sm" disabled={mediaBusy} onclick={() => dispatch('openAvatarEditor')}>Change picture</button>
				</div>
			</div>
			<div class="w-srow">
				<div class="w-srow__text">
					<p class="w-srow__label">Banner</p>
					<p class="w-srow__hint">1200 × 400 PNG, JPEG, GIF or WebP, up to 10 MiB.</p>
				</div>
				<div class="w-srow__control">
					{#if $currentUser?.bannerUrl}<button type="button" class="w-btn w-btn--sm w-btn--quiet" disabled={mediaBusy} onclick={() => removeProfileMedia('banner')}>Remove</button>{/if}
					<button type="button" class="w-btn w-btn--sm" disabled={mediaBusy} aria-busy={bannerUploading} onclick={() => bannerInput?.click()}>{bannerUploading ? 'Uploading…' : 'Change banner'}</button>
				</div>
			</div>
			<div class="w-srow">
				<div class="w-srow__text">
					<p class="w-srow__label">Avatar overlay</p>
					<p class="w-srow__hint">A transparent frame drawn over your picture: 512 × 512 PNG, GIF or WebP.</p>
				</div>
				<div class="w-srow__control">
					{#if $currentUser?.overlayUrl && !overlayAlignMode}
						<button type="button" class="w-btn w-btn--sm w-btn--quiet" disabled={mediaBusy} onclick={() => removeProfileMedia('overlay')}>Remove</button>
						<button type="button" class="w-btn w-btn--sm w-btn--quiet" disabled={mediaBusy} onclick={enterOverlayAlign}>Position</button>
					{/if}
					<button type="button" class="w-btn w-btn--sm" disabled={mediaBusy} aria-busy={overlayUploading} onclick={() => overlayInput?.click()}>{overlayUploading ? 'Uploading…' : 'Change overlay'}</button>
				</div>
			</div>
		</div>
		<p class="w-profile__media-status" role="status">{mediaStatus}</p>
		{#if decorationsHidden}
			<p class="w-profile__note">Banners and overlays are hidden on this device (Appearance › Profile decorations), so the preview leaves them out.</p>
		{/if}
		<button type="button" class="w-disclosure" aria-expanded={guideOpen} aria-controls="profile-art-guide" onclick={() => (guideOpen = !guideOpen)}>
			<Icon name="chevRight" />Artwork guide and templates
		</button>
		{#if guideOpen}
			<div class="w-disclosure__body w-profile__guide" id="profile-art-guide">
				<p><strong>Banner:</strong> 1200 × 400 px, 3:1. Keep key artwork inside the template’s safe area; your picture overlaps the lower left and smaller views may crop the edges.</p>
				<p><strong>Avatar overlay:</strong> 512 × 512 px with a transparent center. Check both the rounded-square profile crop and the round crop in messages and People. PNG for still art; GIF or WebP for animation.</p>
				<p><strong>Animation:</strong> a looping GIF or animated WebP at 10 MiB or less; a 3–6 second loop at 12–24 fps is a good start. Choose a calm first frame: people can pause artwork or reduce motion. Video and SVG files are not accepted.</p>
				<p class="w-profile__downloads">
					<a href="/profile-art/banner-guide.svg" download>Banner template (SVG)</a>
					<a href="/profile-art/avatar-overlay-guide.svg" download>Overlay template (SVG)</a>
					<a href="/profile-art/artist-guide.md" download>Full artist guide</a>
				</p>
				<ProfileArtExamples onUseDesign={(example) => nameDesignStudio?.loadExampleDraft(example)} />
			</div>
		{/if}
	</section>

	<section class="settings-block w-profile__studio" aria-label="Name style">
		<UsernameFontCustomizer bind:this={nameDesignStudio} />
	</section>

	{#if $currentUser?.badges?.length}
		<section class="settings-block" aria-labelledby="profile-badges-title">
			<h3 class="settings-block__title" id="profile-badges-title">Badges</h3>
			<div class="w-srows">
				<div class="w-srow">
					<div class="w-srow__text">
						<p class="w-srow__label">Given by admins of {communityName}</p>
						<p class="w-srow__hint">Shown next to your name.</p>
					</div>
					<div class="w-srow__control"><RoleBadge user={$currentUser} size="md" maxBadges={8} /></div>
				</div>
			</div>
		</section>
	{/if}

	<!-- Payment surfaces are left out entirely unless the server permits payments. -->
	{#if $paymentAccessStore.canViewPaymentUi}
		<section class="settings-block" aria-labelledby="profile-payments-title">
			<h3 class="settings-block__title" id="profile-payments-title">Payments</h3>
			<div class="w-srows">
				<div class="w-srow">
					<div class="w-srow__text">
						<p class="w-srow__label">Payment requests</p>
						<p class="w-srow__hint">Requests you created, and the references you saved for them.</p>
					</div>
					<div class="w-srow__control">
						<button type="button" class="w-btn w-btn--sm" onclick={() => dispatch('openPaymentConnections')} disabled={!$currentUser?.dbUserId}>Saved references</button>
						<button type="button" class="w-btn w-btn--sm" onclick={() => dispatch('openPaymentHistory')} disabled={!$currentUser?.dbUserId}>History</button>
					</div>
				</div>
				<div class="w-srow">
					<div class="w-srow__text">
						<p class="w-srow__label">Support {communityName}</p>
						<p class="w-srow__hint">Send a contribution to the people who run this server.</p>
					</div>
					<div class="w-srow__control">
						<button type="button" class="w-btn w-btn--sm" onclick={() => dispatch('openServerDonation')}>Support</button>
					</div>
				</div>
			</div>
		</section>
	{/if}

	{#if $currentUser?.dbUserId}
		<section class="settings-block" aria-labelledby="profile-account-title">
			<h3 class="settings-block__title" id="profile-account-title">Account</h3>
			<div class="w-srows">
				<div class="w-srow w-profile__password">
					<div class="w-srow__text">
						<p class="w-srow__label" id="profile-password-label">Password</p>
						<p class="w-srow__hint">There is no email recovery. If you are locked out, ask an owner or admin of {communityName}.</p>
						{#if mustChangeOwnPassword}
							<p class="w-profile__warn"><span class="w-dot w-dot--warn" aria-hidden="true"></span>You signed in with a temporary password. Change it now.</p>
						{/if}
					</div>
					<div class="w-profile__password-form" role="group" aria-labelledby="profile-password-label">
						{#if passwordStep === 1}
							<label class="w-label" for="profile-current-password">Current password</label>
							<div class="w-profile__inline">
								<input
									id="profile-current-password"
									type="password"
									class="w-field"
									bind:value={currentPasswordDraft}
									bind:this={currentPasswordInput}
									autocomplete="current-password"
									onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); advancePasswordStep(); } }}
								/>
								<button type="button" class="w-btn" onclick={advancePasswordStep}>Continue</button>
							</div>
						{:else}
							<label class="w-label" for="profile-new-password">New password</label>
							<input id="profile-new-password" type="password" class="w-field" bind:this={newPasswordInput} bind:value={newPasswordDraft} autocomplete="new-password" />
							<label class="w-label" for="profile-confirm-password">Repeat new password</label>
							<input id="profile-confirm-password" type="password" class="w-field" bind:value={confirmNewPasswordDraft} autocomplete="new-password" onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void changeOwnPassword(); } }} />
							<div class="w-profile__inline w-profile__inline--end">
								<button type="button" class="w-btn w-btn--quiet" onclick={backPasswordStep}>Back</button>
								<button type="button" class="w-btn" onclick={changeOwnPassword} disabled={changingPassword} aria-busy={changingPassword}>
									{changingPassword ? 'Changing…' : 'Change password'}
								</button>
							</div>
						{/if}
						{#if passwordError}<p class="w-field-error" role="alert"><Icon name="alert" />{passwordError}</p>{/if}
						{#if passwordSuccess}<p class="w-profile__ok" role="status">{passwordSuccess}</p>{/if}
					</div>
				</div>

				<div class="w-srow">
					<div class="w-srow__text">
						<p class="w-srow__label">Default profile on this device</p>
						<p class="w-srow__hint">
							{$defaultLocalWabiAccountStore ? getLocalWabiAccountDisplayLabel($defaultLocalWabiAccountStore) : 'None chosen yet'}. New servers can start from its look.
						</p>
					</div>
					<div class="w-srow__control">
						<button type="button" class="w-btn w-btn--sm" onclick={makeCurrentLocalWabiDefault} disabled={!currentLocalWabiAccountKey || currentLocalWabiAccountIsDefault}>
							{currentLocalWabiAccountIsDefault ? 'This is the default' : 'Make this the default'}
						</button>
					</div>
				</div>

				{#if otherLocalWabiAccounts.length > 0}
					<div class="w-srow">
						<div class="w-srow__text">
							<p class="w-srow__label" id="profile-import-label">Copy your look from another account</p>
							<p class="w-srow__hint">
								{#if linkedWabiImportPreview?.canImport}Copies {linkedWabiImportPreview.importableFields.join(', ')}.{:else}Nothing new to copy from that account.{/if}
							</p>
						</div>
						<div class="w-srow__control">
							<Select ariaLabel="Account to copy from" options={localAccountOptions} bind:value={linkedWabiImportSourceKey} align="end" />
							<button type="button" class="w-btn w-btn--sm" onclick={importProfileFromSelectedLocalWabiAccount} disabled={!linkedWabiImportPreview?.canImport || linkedWabiImporting} aria-busy={linkedWabiImporting}>
								{linkedWabiImporting ? 'Copying…' : 'Copy look'}
							</button>
						</div>
					</div>
				{/if}
			</div>
			{#if linkedWabiImportStatus}<p class="w-profile__media-status" role="status">{linkedWabiImportStatus}</p>{/if}
		</section>
	{/if}

	{#if dirty || saving}
		<div class="w-profile__savebar" role="region" aria-label="Unsaved profile changes">
			{#if saveError}
				<p class="w-profile__savebar-text is-error" role="alert"><Icon name="alert" size={14} />Not saved. {saveError}</p>
			{:else}
				<p class="w-profile__savebar-text"><span class="w-dot w-dot--warn" aria-hidden="true"></span>Unsaved changes</p>
			{/if}
			<button type="button" class="w-btn w-btn--quiet" onclick={discard} disabled={saving}>Discard</button>
			<button type="button" class="w-btn w-btn--primary" onclick={() => void save()} disabled={saving || !dirty} aria-disabled={!canSave} aria-busy={saving}>
				{saving ? 'Saving…' : 'Save'}
			</button>
		</div>
	{/if}
</div>
