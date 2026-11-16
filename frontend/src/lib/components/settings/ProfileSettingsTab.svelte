<script lang="ts">
	import { _ } from '$lib/i18n';
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
		profileSaveCause,
		profileSaveFailure,
		profileSaveUnconfirmed,
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
	// The name style studio has its own save, so it waits behind a closed disclosure and the
	// page's one form stays About you. It stays mounted while closed, so its draft survives.
	let nameStyleOpen = $state(false);

	const communityName = $derived($currentSavedServer?.effectiveName?.trim() || $_('profile_settings.this_community'));

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

	// A failure note belongs to the attempt it describes: the next edit clears it.
	$effect(() => {
		void draft.name;
		void draft.status;
		void draft.bio;
		untrack(() => {
			if (!saving) saveError = '';
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
			console.warn('[Profile] save failed:', error);
			saveError = profileSaveFailure(error);
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
		{ value: 'active', label: $_('user.status.online') },
		{ value: 'away', label: $_('user.status.away') },
		{ value: 'busy', label: $_('profile_settings.presence_busy') },
		{ value: 'invisible', label: $_('user.status.invisible') }
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
		linkedWabiImportStatus = $_('profile_settings.default_set', { values: { brand: brandName } });
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
				linkedWabiImportStatus = result.errors.join(' ') || $_('profile_settings.import_failed');
				return;
			}
			linkedWabiImportStatus = $_('profile_settings.copied', { values: { fields: result.importedFields.join(' and ') } });
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
			passwordError = $_('profile_settings.err_enter_current');
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
			passwordError = $_('profile_settings.err_fill_all');
			return;
		}
		if (newPasswordDraft !== confirmNewPasswordDraft) {
			passwordError = $_('profile_settings.err_mismatch');
			return;
		}
		if (newPasswordDraft.length < 8) {
			passwordError = $_('profile_settings.err_too_short');
			return;
		}
		const token = getAuthToken();
		if (!token) {
			passwordError = $_('profile_settings.err_sign_in_again');
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
			passwordSuccess = $_('profile_settings.password_changed');
		} catch (error) {
			passwordError = error instanceof Error ? error.message : $_('profile_settings.password_not_changed');
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
		mediaStatus = overlayPendingUrl ? $_('profile_settings.overlay_discarded') : $_('profile_settings.overlay_unchanged');
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
			mediaStatus = $_('profile_settings.err_account_changed');
			return;
		}
		clampOverlayDrafts();
		overlayAlignSaving = true;
		mediaStatus = $_('profile_settings.overlay_saving');
		try {
			await saveProfilePatch({ ...(overlayPendingUrl ? { overlayUrl: overlayPendingUrl } : {}), overlayScale: overlayDraftScale, overlayOffsetX: overlayDraftX, overlayOffsetY: overlayDraftY });
			overlayPendingUrl = '';
			mediaStatus = $_('profile_settings.overlay_saved');
			overlayAlignMode = false;
		} catch (error) {
			mediaStatus = mediaFailure(error, $_('profile_settings.overlay_not_saved'));
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
	/** A failure this tab already words for people; anything else is logged and summarised. */
	class MediaProblem extends Error {}
	function mediaFailure(error: unknown, lead: string): string {
		if (error instanceof MediaProblem) return error.message;
		console.warn('[Profile] picture change failed:', error);
		if (profileSaveUnconfirmed(error)) return $_('profile_settings.server_unconfirmed', { values: { cause: profileSaveCause(error) } });
		return $_('profile_settings.media_failure_format', { values: { lead, cause: profileSaveCause(error) ?? $_('profile_settings.try_again') } });
	}
	function validateProfileMedia(file: File, overlay = false) {
		const allowed = overlay ? ['image/png', 'image/gif', 'image/webp'] : ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
		if (!allowed.includes(file.type)) throw new MediaProblem(overlay ? $_('profile_settings.err_overlay_type') : $_('profile_settings.err_banner_type'));
		if (file.size > PROFILE_MEDIA_LIMIT) throw new MediaProblem($_('profile_settings.err_artwork_size'));
	}

	async function removeAvatar() {
		if (avatarRemoving) return;
		const confirmed = await confirmAction({
			title: $_('profile_settings.remove_picture_title'),
			body: $_('profile_settings.remove_picture_body', { values: { community: communityName } }),
			confirm: $_('profile_settings.remove_picture_confirm'),
			danger: true
		});
		if (!confirmed) return;
		avatarRemoving = true;
		mediaStatus = $_('profile_settings.removing_picture');
		try {
			await saveProfilePatch({ profilePicture: '' });
			mediaStatus = $_('profile_settings.picture_removed');
		} catch (error) {
			mediaStatus = mediaFailure(error, $_('profile_settings.picture_not_removed'));
		} finally {
			avatarRemoving = false;
		}
	}

	async function removeProfileMedia(kind: 'banner' | 'overlay') {
		const confirmed = await confirmAction({
			title: kind === 'banner' ? $_('profile_settings.remove_banner_title') : $_('profile_settings.remove_overlay_title'),
			body: kind === 'banner' ? $_('profile_settings.remove_banner_body') : $_('profile_settings.remove_overlay_body'),
			confirm: kind === 'banner' ? $_('profile_settings.remove_banner_confirm') : $_('profile_settings.remove_overlay_confirm'),
			danger: true
		});
		if (!confirmed) return;
		if (kind === 'banner') bannerUploading = true;
		else overlayUploading = true;
		mediaStatus = kind === 'banner' ? $_('profile_settings.removing_banner') : $_('profile_settings.removing_overlay');
		try {
			await saveProfilePatch(kind === 'banner' ? { bannerUrl: '' } : { overlayUrl: '', overlayScale: 1, overlayOffsetX: 0, overlayOffsetY: 0 });
			mediaStatus = kind === 'banner' ? $_('profile_settings.banner_removed') : $_('profile_settings.overlay_removed');
			if (kind === 'overlay') overlayAlignMode = false;
		} catch (error) {
			mediaStatus = mediaFailure(error, kind === 'banner' ? $_('profile_settings.banner_not_removed') : $_('profile_settings.overlay_not_removed'));
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
		if (!res.ok) {
			console.warn('[Profile] upload refused:', res.status, payload?.error);
			throw new MediaProblem(res.status === 413 ? $_('profile_settings.file_too_large') : $_('profile_settings.upload_unfinished'));
		}
		const url = typeof payload?.fileUrl === 'string' ? payload.fileUrl : '';
		if (!url) throw new MediaProblem($_('profile_settings.upload_unfinished'));
		return url;
	}

	async function uploadBanner(file: File) {
		bannerUploading = true;
		mediaStatus = $_('profile_settings.uploading_banner');
		try {
			validateProfileMedia(file);
			const url = await uploadProfileMedia(file);
			await saveProfilePatch({ bannerUrl: url });
			mediaStatus = $_('profile_settings.banner_saved');
		} catch (e) {
			mediaStatus = mediaFailure(e, $_('profile_settings.banner_not_saved'));
		} finally {
			bannerUploading = false;
		}
	}

	async function uploadOverlay(file: File) {
		const server = getServerUrl(), token = getAuthToken(), generation = authSessionGeneration(server);
		overlayUploading = true;
		mediaStatus = $_('profile_settings.uploading_overlay');
		try {
			validateProfileMedia(file, true);
			const url = await uploadProfileMedia(file);
			if (server !== getServerUrl() || token !== getAuthToken() || generation !== authSessionGeneration(server)) {
				// The account changed mid-upload: drop the file and its "Uploading…" note.
				mediaStatus = '';
				return;
			}
			overlayDraftOwner = overlayOwner();
			overlayPendingUrl = url;
			overlayDraftScale = 1;
			overlayDraftX = 0;
			overlayDraftY = 0;
			overlayAlignMode = true;
			mediaStatus = $_('profile_settings.overlay_position_prompt');
		} catch (e) {
			mediaStatus = mediaFailure(e, $_('profile_settings.overlay_not_uploaded'));
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

	/** "Use design" in the artwork guide opens the name style studio, then loads the example. */
	async function useExampleDesign(example: ProfileArtExample): Promise<void> {
		nameStyleOpen = true;
		await tick();
		nameDesignStudio?.loadExampleDraft(example);
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
		$currentUser?.handle ? `@${$currentUser.handle}` : $currentUser?.dbUserId ? $_('profile_settings.registered_account') : $_('profile_settings.local_account')
	);
	const previewJoined = $derived(
		$currentUser?.joinedAt
			? new Date($currentUser.joinedAt).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
			: ''
	);
	const presenceWord = $derived(PRESENCE_OPTIONS.find((option) => option.value === selectedPresence)?.label ?? $_('user.status.online'));
	const identityVars = $derived($inkFor($currentUser?.color));
	const hasBanner = $derived(Boolean($currentUser?.bannerUrl) && !decorationsHidden);
	const mediaBusy = $derived(bannerUploading || overlayUploading || avatarRemoving || overlayAlignSaving);
</script>

<input bind:this={bannerInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" class="hidden-file-input" tabindex="-1" aria-hidden="true" onchange={onBannerFile} />
<input bind:this={overlayInput} type="file" accept="image/png,image/gif,image/webp" class="hidden-file-input" tabindex="-1" aria-hidden="true" onchange={onOverlayFile} />

<div class="w-profile">
	<!-- How members see you: a flat preview, not a second editor. -->
	<section class="w-profile__preview" aria-labelledby="profile-preview-kicker">
		<p class="w-kicker" id="profile-preview-kicker">{$_('profile_settings.preview_kicker')}</p>
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
					aria-label={overlayAlignMode ? $_('profile_settings.overlay_position_aria') : $_('profile_settings.change_picture_aria')}
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
				{#if previewJoined}<p class="w-profile-card__meta">{$_('profile_settings.member_since', { values: { date: previewJoined } })}</p>{/if}
			</div>
		</div>
		{#if overlayAlignMode}
			<div class="w-profile-align" role="group" aria-label={$_('profile_settings.overlay_position_group')}>
				<p class="w-profile-align__help" id="profile-overlay-help">{$_('profile_settings.overlay_help')}</p>
				<div class="w-profile-align__controls">
					<span class="w-profile-align__scale">
						<button type="button" class="w-ibtn w-ibtn--sm w-ibtn--edge" onclick={() => nudgeOverlayScale(-0.05)} aria-label={$_('profile_settings.overlay_smaller')} disabled={overlayAlignSaving}><Icon name="minus" /></button>
						<span class="w-profile-align__value" aria-live="polite">{Math.round(overlayDraftScale * 100)}%</span>
						<button type="button" class="w-ibtn w-ibtn--sm w-ibtn--edge" onclick={() => nudgeOverlayScale(0.05)} aria-label={$_('profile_settings.overlay_larger')} disabled={overlayAlignSaving}><Icon name="plus" /></button>
					</span>
					<button type="button" class="w-btn w-btn--sm w-btn--quiet" onclick={resetOverlayAlign} disabled={overlayAlignSaving}>{$_('admin.actions.reset')}</button>
					<span class="w-profile-align__end">
						<button type="button" class="w-btn w-btn--sm w-btn--quiet" onclick={cancelOverlayAlign} disabled={overlayAlignSaving}>{$_('common.cancel')}</button>
						<button type="button" class="w-btn w-btn--sm w-btn--primary" onclick={saveOverlayAlign} disabled={overlayAlignSaving} aria-busy={overlayAlignSaving}>
							{overlayAlignSaving ? $_('profile_settings.saving') : $_('profile_settings.save_overlay')}
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
			<h3 class="settings-block__title" id="profile-about-title">{$_('profile_settings.about_you')}</h3>
			<p class="w-profile__saved" role="status">{#if savedAt && !dirty}{$_('locality.saved_at', { values: { time: savedAt } })}{/if}</p>
		</div>
		<p class="settings-block__hint">{$_('profile_settings.members_see', { values: { community: communityName } })}</p>

		<div class="w-profile-field">
			<label class="w-label" for="profile-display-name">{$_('settings.sections.display_name')}</label>
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
			<label class="w-label" for="profile-status-message">{$_('profile_settings.status_message')}</label>
			<input
				id="profile-status-message"
				class="w-field"
				type="text"
				maxlength={PROFILE_LIMITS.status}
				placeholder={$_('profile_settings.placeholder_status')}
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
			<label class="w-label" for="profile-about-me">{$_('user.popout.about_me')}</label>
			<textarea
				id="profile-about-me"
				class="w-field"
				rows="3"
				maxlength={PROFILE_LIMITS.bio}
				placeholder={$_('profile_settings.placeholder_bio')}
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
		<h3 class="settings-block__title" id="profile-presence-title">{$_('shell.you.presence')}</h3>
		<div class="w-srows">
			<div class="w-srow">
				<div class="w-srow__text">
					<p class="w-srow__label" id="profile-presence-label">{$_('profile_settings.show_me_as')}</p>
					<p class="w-srow__hint">{$_('profile_settings.presence_hint')}</p>
				</div>
				<div class="w-srow__control">
					<Segmented labelledby="profile-presence-label" options={PRESENCE_OPTIONS} value={selectedPresence} onchange={(value) => changePresence(value as PresenceState)} />
				</div>
			</div>
		</div>
	</section>

	<section class="settings-block" aria-labelledby="profile-pictures-title">
		<h3 class="settings-block__title" id="profile-pictures-title">{$_('profile_settings.pictures')}</h3>
		<p class="settings-block__hint">{$_('profile_settings.pictures_hint')}</p>
		<div class="w-srows">
			<div class="w-srow">
				<div class="w-srow__text">
					<p class="w-srow__label">{$_('settings.sections.profile_picture')}</p>
					<p class="w-srow__hint">{$_('profile_settings.profile_picture_hint')}</p>
				</div>
				<div class="w-srow__control">
					{#if $currentUser?.profilePicture}<button type="button" class="w-btn w-btn--sm w-btn--quiet" disabled={mediaBusy} onclick={removeAvatar}>{$_('profile_settings.remove')}</button>{/if}
					<button type="button" class="w-btn w-btn--sm" disabled={mediaBusy} onclick={() => dispatch('openAvatarEditor')}>{$_('profile_settings.change_picture')}</button>
				</div>
			</div>
			<div class="w-srow">
				<div class="w-srow__text">
					<p class="w-srow__label">{$_('profile_settings.banner')}</p>
					<p class="w-srow__hint">{$_('profile_settings.banner_hint')}</p>
				</div>
				<div class="w-srow__control">
					{#if $currentUser?.bannerUrl}<button type="button" class="w-btn w-btn--sm w-btn--quiet" disabled={mediaBusy} onclick={() => removeProfileMedia('banner')}>{$_('profile_settings.remove')}</button>{/if}
					<button type="button" class="w-btn w-btn--sm" disabled={mediaBusy} aria-busy={bannerUploading} onclick={() => bannerInput?.click()}>{bannerUploading ? $_('wb.uploading') : $_('profile_settings.change_banner')}</button>
				</div>
			</div>
			<div class="w-srow">
				<div class="w-srow__text">
					<p class="w-srow__label">{$_('profile_settings.avatar_overlay')}</p>
					<p class="w-srow__hint">{$_('profile_settings.overlay_hint')}</p>
				</div>
				<div class="w-srow__control">
					{#if $currentUser?.overlayUrl && !overlayAlignMode}
						<button type="button" class="w-btn w-btn--sm w-btn--quiet" disabled={mediaBusy} onclick={() => removeProfileMedia('overlay')}>{$_('profile_settings.remove')}</button>
						<button type="button" class="w-btn w-btn--sm w-btn--quiet" disabled={mediaBusy} onclick={enterOverlayAlign}>{$_('wb.lock_position')}</button>
					{/if}
					<button type="button" class="w-btn w-btn--sm" disabled={mediaBusy} aria-busy={overlayUploading} onclick={() => overlayInput?.click()}>{overlayUploading ? $_('wb.uploading') : $_('profile_settings.change_overlay')}</button>
				</div>
			</div>
		</div>
		<p class="w-profile__media-status" role="status">{mediaStatus}</p>
		{#if decorationsHidden}
			<p class="w-profile__note">{$_('profile_settings.media_hidden_note')}</p>
		{/if}
		<button type="button" class="w-disclosure" aria-expanded={guideOpen} aria-controls="profile-art-guide" onclick={() => (guideOpen = !guideOpen)}>
			<Icon name="chevRight" />{$_('profile_settings.artwork_guide')}
		</button>
		{#if guideOpen}
			<div class="w-disclosure__body w-profile__guide" id="profile-art-guide">
				<p><strong>{$_('profile_settings.guide_banner_label')}</strong> {$_('profile_settings.guide_banner_body')}</p>
				<p><strong>{$_('profile_settings.guide_overlay_label')}</strong> {$_('profile_settings.guide_overlay_body')}</p>
				<p><strong>{$_('profile_settings.guide_anim_label')}</strong> {$_('profile_settings.guide_anim_body')}</p>
				<p class="w-profile__downloads">
					<a href="/profile-art/banner-guide.svg" download>{$_('profile_settings.download_banner')}</a>
					<a href="/profile-art/avatar-overlay-guide.svg" download>{$_('profile_settings.download_overlay')}</a>
					<a href="/profile-art/artist-guide.md" download>{$_('profile_settings.download_guide')}</a>
				</p>
				<ProfileArtExamples onUseDesign={useExampleDesign} />
			</div>
		{/if}
	</section>

	<section class="settings-block w-profile__studio" aria-labelledby="profile-name-style-title">
		<h3 class="settings-block__title" id="profile-name-style-title">{$_('profile_settings.name_style_heading')}</h3>
		<p class="settings-block__hint">{$_('profile_settings.name_style_hint')}</p>
		<button type="button" class="w-disclosure" aria-expanded={nameStyleOpen} aria-controls="profile-name-style" onclick={() => (nameStyleOpen = !nameStyleOpen)}>
			<Icon name="chevRight" />{$_('profile_settings.design_name')}
		</button>
		<div class="w-disclosure__body w-profile__studio-body" id="profile-name-style" hidden={!nameStyleOpen}>
			<UsernameFontCustomizer bind:this={nameDesignStudio} />
		</div>
	</section>

	{#if $currentUser?.badges?.length}
		<section class="settings-block" aria-labelledby="profile-badges-title">
			<h3 class="settings-block__title" id="profile-badges-title">{$_('profile_settings.badges_heading')}</h3>
			<div class="w-srows">
				<div class="w-srow">
					<div class="w-srow__text">
						<p class="w-srow__label">{$_('profile_settings.badges_given', { values: { community: communityName } })}</p>
						<p class="w-srow__hint">{$_('profile_settings.badges_hint')}</p>
					</div>
					<div class="w-srow__control"><RoleBadge user={$currentUser} size="md" maxBadges={8} /></div>
				</div>
			</div>
		</section>
	{/if}

	<!-- Payment surfaces are left out entirely unless the server permits payments. -->
	{#if $paymentAccessStore.canViewPaymentUi}
		<section class="settings-block" aria-labelledby="profile-payments-title">
			<h3 class="settings-block__title" id="profile-payments-title">{$_('profile_settings.payments_heading')}</h3>
			<div class="w-srows">
				<div class="w-srow">
					<div class="w-srow__text">
						<p class="w-srow__label">{$_('profile_settings.payment_requests')}</p>
						<p class="w-srow__hint">{$_('profile_settings.payment_requests_hint')}</p>
					</div>
					<div class="w-srow__control">
						<button type="button" class="w-btn w-btn--sm" onclick={() => dispatch('openPaymentConnections')} disabled={!$currentUser?.dbUserId}>{$_('profile_settings.saved_references')}</button>
						<button type="button" class="w-btn w-btn--sm" onclick={() => dispatch('openPaymentHistory')} disabled={!$currentUser?.dbUserId}>{$_('profile_settings.history')}</button>
					</div>
				</div>
				<div class="w-srow">
					<div class="w-srow__text">
						<p class="w-srow__label">{$_('profile_settings.support_community', { values: { community: communityName } })}</p>
						<p class="w-srow__hint">{$_('profile_settings.support_hint')}</p>
					</div>
					<div class="w-srow__control">
						<button type="button" class="w-btn w-btn--sm" onclick={() => dispatch('openServerDonation')}>{$_('profile_settings.support')}</button>
					</div>
				</div>
			</div>
		</section>
	{/if}

	{#if $currentUser?.dbUserId}
		<section class="settings-block" aria-labelledby="profile-account-title">
			<h3 class="settings-block__title" id="profile-account-title">{$_('settings.groups.account')}</h3>
			<div class="w-srows">
				<div class="w-srow w-profile__password">
					<div class="w-srow__text">
						<p class="w-srow__label" id="profile-password-label">{$_('login.auth.password_placeholder')}</p>
						<p class="w-srow__hint">{$_('profile_settings.no_email_recovery', { values: { community: communityName } })}</p>
						{#if mustChangeOwnPassword}
							<p class="w-profile__warn"><span class="w-dot w-dot--warn" aria-hidden="true"></span>{$_('profile_settings.temp_password_warn')}</p>
						{/if}
					</div>
					<div class="w-profile__password-form" role="group" aria-labelledby="profile-password-label">
						{#if passwordStep === 1}
							<label class="w-label" for="profile-current-password">{$_('profile_settings.current_password')}</label>
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
								<button type="button" class="w-btn" onclick={advancePasswordStep}>{$_('profile_settings.continue')}</button>
							</div>
						{:else}
							<label class="w-label" for="profile-new-password">{$_('profile_settings.new_password')}</label>
							<input id="profile-new-password" type="password" class="w-field" bind:this={newPasswordInput} bind:value={newPasswordDraft} autocomplete="new-password" />
							<label class="w-label" for="profile-confirm-password">{$_('profile_settings.repeat_new_password')}</label>
							<input id="profile-confirm-password" type="password" class="w-field" bind:value={confirmNewPasswordDraft} autocomplete="new-password" onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void changeOwnPassword(); } }} />
							<div class="w-profile__inline w-profile__inline--end">
								<button type="button" class="w-btn w-btn--quiet" onclick={backPasswordStep}>{$_('login.wizard.back')}</button>
								<button type="button" class="w-btn" onclick={changeOwnPassword} disabled={changingPassword} aria-busy={changingPassword}>
									{changingPassword ? $_('profile_settings.changing') : $_('profile_settings.change_password')}
								</button>
							</div>
						{/if}
						{#if passwordError}<p class="w-field-error" role="alert"><Icon name="alert" />{passwordError}</p>{/if}
						{#if passwordSuccess}<p class="w-profile__ok" role="status">{passwordSuccess}</p>{/if}
					</div>
				</div>

				<div class="w-srow">
					<div class="w-srow__text">
						<p class="w-srow__label">{$_('profile_settings.default_profile_heading')}</p>
						<p class="w-srow__hint">
							{$defaultLocalWabiAccountStore ? getLocalWabiAccountDisplayLabel($defaultLocalWabiAccountStore) : $_('profile_settings.none_chosen')}. {$_('profile_settings.new_servers_look')}
						</p>
					</div>
					<div class="w-srow__control">
						<button type="button" class="w-btn w-btn--sm" onclick={makeCurrentLocalWabiDefault} disabled={!currentLocalWabiAccountKey || currentLocalWabiAccountIsDefault}>
							{currentLocalWabiAccountIsDefault ? $_('profile_settings.this_is_default') : $_('profile_settings.make_default')}
						</button>
					</div>
				</div>

				{#if otherLocalWabiAccounts.length > 0}
					<div class="w-srow">
						<div class="w-srow__text">
							<p class="w-srow__label" id="profile-import-label">{$_('profile_settings.copy_look_heading')}</p>
							<p class="w-srow__hint">
								{#if linkedWabiImportPreview?.canImport}{$_('profile_settings.copies', { values: { fields: linkedWabiImportPreview.importableFields.join(', ') } })}{:else}{$_('profile_settings.nothing_to_copy')}{/if}
							</p>
						</div>
						<div class="w-srow__control">
							<Select ariaLabel={$_('profile_settings.copy_from_aria')} options={localAccountOptions} bind:value={linkedWabiImportSourceKey} align="end" />
							<button type="button" class="w-btn w-btn--sm" onclick={importProfileFromSelectedLocalWabiAccount} disabled={!linkedWabiImportPreview?.canImport || linkedWabiImporting} aria-busy={linkedWabiImporting}>
								{linkedWabiImporting ? $_('profile_settings.copying') : $_('profile_settings.copy_look')}
							</button>
						</div>
					</div>
				{/if}
			</div>
			{#if linkedWabiImportStatus}<p class="w-profile__media-status" role="status">{linkedWabiImportStatus}</p>{/if}
		</section>
	{/if}

	{#if dirty || saving}
		<div class="w-profile__savebar" role="region" aria-label={$_('profile_settings.unsaved_region_aria')}>
			{#if saveError}
				<p class="w-profile__savebar-text is-error" role="alert"><Icon name="alert" size={14} />{saveError} {$_('profile_settings.edits_still_here')}</p>
			{:else}
				<p class="w-profile__savebar-text"><span class="w-dot w-dot--warn" aria-hidden="true"></span>{$_('common.unsaved_changes')}</p>
			{/if}
			<button type="button" class="w-btn w-btn--quiet" onclick={discard} disabled={saving}>{$_('common.discard')}</button>
			<button type="button" class="w-btn w-btn--primary" onclick={() => void save()} disabled={saving || !dirty} aria-disabled={!canSave} aria-busy={saving}>
				{saving ? $_('profile_settings.saving') : $_('common.save')}
			</button>
		</div>
	{/if}
</div>
