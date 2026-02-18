<script lang="ts">
	import { browser } from '$app/environment';
	import { createEventDispatcher, onDestroy, onMount } from 'svelte';
	import { channelMessages, users, currentUser, emojis, updateProfile, assignRole, removeUserRole, roleDefinitions } from '$lib/socket';
	import StorageSettings from './StorageSettings.svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import { playNotificationSound } from '$lib/notifications';
	import { getSocket } from '$lib/socket';
	import { getServerUrl } from '$lib/serverUrl';
	import AvatarEditor from './AvatarEditor.svelte'; // Import the AvatarEditor

	// Theme system
	import { themeStore, currentTheme } from '$lib/theme/themeStore';
	import { THEMES } from '$lib/theme/themes';
	import { saveThemePreferences } from '$lib/theme/themeApi';
	import { saveThemeToLocalStorage } from '$lib/theme/themeManager';
	import ThemeCustomizer from './ThemeCustomizer.svelte';
	import UsernameFontCustomizer from './UsernameFontCustomizer.svelte';
	import UniformFontMode from './UniformFontMode.svelte';
	import {
		getAudioCaptureConstraints,
		getStoredAudioProcessingMode,
		getStoredCallTransportMode,
		getStoredMediaQualityMode,
		getStoredScreenShareQualityPreset,
		getStoredSpatialAudioSettings,
		isSrtGatewayEnabled,
		isTauriRuntime,
		setAudioProcessingMode,
		setCallTransportMode,
		setMediaQualityMode,
		setScreenShareQualityPreset,
		setSpatialAudioDistanceScale,
		setSpatialAudioEnabled,
		setSpatialAudioMasterStrength,
		setSpatialAudioMode,
		setSpatialAudioQuickToggleVisible,
		setSpatialAudioWarningMuted,
		setSrtGatewayEnabled,
		syncMediaRuntimeFromServer,
		type AudioProcessingMode,
		type CallTransportMode,
		type MediaQualityMode,
		type ScreenShareQualityPreset,
		type SpatialAudioMode
	} from '$lib/mediaRuntime';
	import {
		applyCurrentAudioProcessingToLocalTrack,
		audioProcessingRuntimeStatus,
		clearAudioPerformanceFallbackOverride,
		refreshSpatialAudioRuntime,
		spatialAudioRuntimeStatus
	} from '$lib/calling';
	import {
		getStoredAccessibilitySettings,
		updateAccessibilitySettings,
		type RoleColorMode
	} from '$lib/accessibility';

	const dispatch = createEventDispatcher();

	export let isOpen = false;
	type SettingsTab = 'profile' | 'audio' | 'notifications' | 'accessibility' | 'appearance' | 'server' | 'emojis' | 'storage' | 'admin' | 'about';
	let activeSettingsTab: SettingsTab = 'profile';

	let soundEnabled = true;
	let notificationsEnabled = true;
	let micEnabled = true;
	let cameraEnabled = true;
	let suppressEveryoneHereMentions = false;
	let suppressRoleMentions = false;
	let notificationSound = '/sounds/ProjectSound.ogg';
	let notificationVolume = 0.5;
	let mediaQualityMode: MediaQualityMode = 'web-baseline';
	let audioProcessingMode: AudioProcessingMode = 'auto';
	let callTransportMode: CallTransportMode = 'auto';
	let srtGatewayEnabled = false;
	let screenShareQualityPreset: ScreenShareQualityPreset = 'auto';
	let spatialAudioEnabled = false;
	let spatialAudioMode: SpatialAudioMode = 'auto';
	let spatialAudioStrength = 0.85;
	let spatialAudioDistanceScale = 1;
	let spatialAudioWarningsMuted = false;
	let spatialAudioQuickToggleVisible = true;
	let textScale = 1;
	let colorAssistEnabled = false;
	let saturation = 1;
	let contrast = 1;
	let reducedMotion = false;
	let roleColorMode: RoleColorMode = 'full';
	let localAppRuntime = false;
	let micTestStream: MediaStream | null = null;
	let micTestRecorder: MediaRecorder | null = null;
	let micTestAudioContext: AudioContext | null = null;
	let micTestAnalyser: AnalyserNode | null = null;
	let micTestLevelInterval: number | null = null;
	let micTestAudioUrl: string | null = null;
	let micTestLevel = 0;
	let micTestState: 'idle' | 'recording' | 'ready' = 'idle';
	const isDevBuild = import.meta.env.DEV;
	const MEMORY_TELEMETRY_KEY = 'wabi_debug_memory_telemetry';
	let memoryTelemetryEnabled = false;
	let memoryTelemetrySupported = false;
	let memoryTelemetryInterval: number | null = null;
	let memoryUsedMb = 0;
	let memoryTotalMb = 0;
	let memoryLimitMb = 0;
	let memoryUsedPct = 0;

	// Theme saving state
	let savingTheme = false;

	let showClearDataConfirm = false;
	let showClearServerConfirm = false;

	// Profile Picture upload state
	let showAvatarEditor = false;
	let selectedAvatarFile: File | null = null;
	let selectedAvatarPreview: string | null = null;
	let uploadingAvatar = false;
	let displayNameDraft = '';
	let updatingDisplayName = false;

	// Emoji upload state
	let emojiFileInput: HTMLInputElement;
	let emojiName = '';
	let emojiDisplayName = '';
	let emojiArtist = '';
	let emojiCategory = 'custom';
	let emojiType: 'emoji' | 'sticker' = 'emoji';
	let selectedEmojiFile: File | null = null;
	let emojiPreview: string | null = null;
	let uploadingEmoji = false;

	// Bulk emoji upload state
	let bulkEmojiFileInput: HTMLInputElement;
	let bulkEmojiArtist = '';
	let bulkEmojiFiles: { file: File; name: string; displayName: string; preview: string }[] = [];
	let uploadingBulk = false;
	const fallbackRoleLabels: Record<string, string> = {
		owner: 'Owner',
		admin: 'Admin',
		mod: 'Moderator',
		member: 'Member',
		guest: 'Guest'
	};
	$: roleLabelMap = (() => {
		const labels: Record<string, string> = { ...fallbackRoleLabels };
		for (const role of $roleDefinitions) {
			labels[role.roleName] = role.displayName;
		}
		return labels;
	})();

	$: canManageAdmin = $currentUser?.highestRole === 'owner' || $currentUser?.highestRole === 'admin';
	$: sortedAdminUsers = [...$users].sort((a, b) => {
		const aPriority = a.highestRole === 'owner' ? 3 : a.highestRole === 'admin' ? 2 : a.highestRole === 'mod' ? 1 : 0;
		const bPriority = b.highestRole === 'owner' ? 3 : b.highestRole === 'admin' ? 2 : b.highestRole === 'mod' ? 1 : 0;
		if (aPriority !== bPriority) return bPriority - aPriority;
		return a.username.localeCompare(b.username);
	});

	// Load settings from localStorage and enforce server policy
	onMount(() => {
		const accessibilitySettings = getStoredAccessibilitySettings();
		textScale = accessibilitySettings.textScale;
		colorAssistEnabled = accessibilitySettings.colorAssistEnabled;
		saturation = accessibilitySettings.saturation;
		contrast = accessibilitySettings.contrast;
		reducedMotion = accessibilitySettings.reducedMotion;
		roleColorMode = accessibilitySettings.roleColorMode;
		soundEnabled = localStorage.getItem('soundEnabled') !== 'false';
		notificationsEnabled = localStorage.getItem('notificationsEnabled') !== 'false';
		micEnabled = localStorage.getItem('micEnabled') !== 'false';
		cameraEnabled = localStorage.getItem('cameraEnabled') !== 'false';
		suppressEveryoneHereMentions = localStorage.getItem('suppressEveryoneHereMentions') === 'true';
		suppressRoleMentions = localStorage.getItem('suppressRoleMentions') === 'true';
		notificationSound = localStorage.getItem('notificationSound') || '/sounds/ProjectSound.ogg';
		notificationVolume = parseFloat(localStorage.getItem('notificationVolume') || '0.5');
		localAppRuntime = isTauriRuntime();

		// Sync server policy first to prevent race condition with Tauri prefs
		void (async () => {
			await syncMediaRuntimeFromServer();
			// After server sync, load local settings (will be constrained if needed)
			mediaQualityMode = getStoredMediaQualityMode();
			audioProcessingMode = getStoredAudioProcessingMode();
			callTransportMode = getStoredCallTransportMode();
			srtGatewayEnabled = isSrtGatewayEnabled();
			screenShareQualityPreset = getStoredScreenShareQualityPreset();
			const spatial = getStoredSpatialAudioSettings();
			spatialAudioEnabled = spatial.enabled;
			spatialAudioMode = spatial.mode;
			spatialAudioStrength = spatial.masterStrength;
			spatialAudioDistanceScale = spatial.distanceScale;
			spatialAudioWarningsMuted = spatial.warningMuted;
			spatialAudioQuickToggleVisible = spatial.quickToggleVisible;
		})();

		memoryTelemetrySupported = typeof performance !== 'undefined' && Boolean((performance as Performance & { memory?: unknown }).memory);
		if (isDevBuild) {
			memoryTelemetryEnabled = localStorage.getItem(MEMORY_TELEMETRY_KEY) === 'true';
			if (memoryTelemetryEnabled) {
				startMemoryTelemetry();
			}
		}

		displayNameDraft = $currentUser?.username || '';
	});

	$: if (!updatingDisplayName && $currentUser?.username && displayNameDraft === '') {
		displayNameDraft = $currentUser.username;
	}

	onDestroy(() => {
		cleanupMicTest();
		stopMemoryTelemetry();
	});

	function toggleSound() {
		soundEnabled = !soundEnabled;
		localStorage.setItem('soundEnabled', soundEnabled.toString());
	}

	function toggleNotifications() {
		notificationsEnabled = !notificationsEnabled;
		localStorage.setItem('notificationsEnabled', notificationsEnabled.toString());
	}

	function toggleMic() {
		micEnabled = !micEnabled;
		localStorage.setItem('micEnabled', micEnabled.toString());
	}

	function toggleCamera() {
		cameraEnabled = !cameraEnabled;
		localStorage.setItem('cameraEnabled', cameraEnabled.toString());
	}

	function toggleSuppressEveryoneHereMentions() {
		suppressEveryoneHereMentions = !suppressEveryoneHereMentions;
		localStorage.setItem('suppressEveryoneHereMentions', suppressEveryoneHereMentions.toString());
	}

	function toggleSuppressRoleMentions() {
		suppressRoleMentions = !suppressRoleMentions;
		localStorage.setItem('suppressRoleMentions', suppressRoleMentions.toString());
	}

	function userHasRole(user: { roles?: string[]; highestRole?: string }, role: 'admin' | 'mod' | 'owner'): boolean {
		return user.highestRole === role || (user.roles || []).includes(role);
	}

	function isProtectedOwner(user: { highestRole?: string }): boolean {
		return user.highestRole === 'owner';
	}

	function canManageTargetUser(user: { id: string; dbUserId?: number; highestRole?: string }): boolean {
		if (!canManageAdmin) return false;
		if (!user.dbUserId) return false;
		if (!$currentUser || user.id === $currentUser.id) return false;
		if (isProtectedOwner(user)) return false;
		return true;
	}

	function getRoleLabel(roleName?: string): string {
		if (!roleName) return roleLabelMap.member;
		return roleLabelMap[roleName] || roleName;
	}

	function promoteUser(user: { dbUserId?: number }, role: 'admin' | 'mod') {
		if (!user.dbUserId) return;
		assignRole(user.dbUserId, role);
	}

	function removeRoleFromUser(user: { dbUserId?: number }, role: 'admin' | 'mod') {
		if (!user.dbUserId) return;
		removeUserRole(user.dbUserId, role);
	}

	function resetUserToMember(user: { dbUserId?: number }) {
		if (!user.dbUserId) return;
		removeUserRole(user.dbUserId, 'admin');
		removeUserRole(user.dbUserId, 'mod');
	}

	function updateMediaQualityMode(mode: MediaQualityMode) {
		mediaQualityMode = mode;
		setMediaQualityMode(mode);
	}

	function updateAudioProcessingMode(mode: AudioProcessingMode) {
		audioProcessingMode = mode;
		setAudioProcessingMode(mode);
		clearAudioPerformanceFallbackOverride();
		void applyCurrentAudioProcessingToLocalTrack();
	}

	function cleanupMicTest() {
		if (micTestLevelInterval !== null) {
			clearInterval(micTestLevelInterval);
			micTestLevelInterval = null;
		}
		if (micTestRecorder && micTestRecorder.state !== 'inactive') {
			micTestRecorder.stop();
		}
		micTestRecorder = null;
		if (micTestStream) {
			micTestStream.getTracks().forEach(track => track.stop());
			micTestStream = null;
		}
		if (micTestAudioContext) {
			void micTestAudioContext.close().catch(() => undefined);
			micTestAudioContext = null;
		}
		micTestAnalyser = null;
		micTestLevel = 0;
	}

	async function runMicTest() {
		cleanupMicTest();
		if (micTestAudioUrl) {
			URL.revokeObjectURL(micTestAudioUrl);
			micTestAudioUrl = null;
		}

		const chunks: Blob[] = [];
		micTestState = 'recording';

		try {
			micTestStream = await navigator.mediaDevices.getUserMedia({
				audio: getAudioCaptureConstraints(audioProcessingMode),
				video: false
			});

			micTestAudioContext = new AudioContext();
			const source = micTestAudioContext.createMediaStreamSource(micTestStream);
			micTestAnalyser = micTestAudioContext.createAnalyser();
			micTestAnalyser.fftSize = 1024;
			source.connect(micTestAnalyser);
			const data = new Uint8Array(micTestAnalyser.frequencyBinCount);
			micTestLevelInterval = window.setInterval(() => {
				if (!micTestAnalyser) return;
				micTestAnalyser.getByteTimeDomainData(data);
				let sum = 0;
				for (let i = 0; i < data.length; i += 1) {
					const n = (data[i] - 128) / 128;
					sum += n * n;
				}
				const rms = Math.sqrt(sum / data.length);
				micTestLevel = Math.min(1, rms * 8);
			}, 80);

			micTestRecorder = new MediaRecorder(micTestStream);
			micTestRecorder.ondataavailable = (event) => {
				if (event.data.size > 0) chunks.push(event.data);
			};
			micTestRecorder.onstop = () => {
				const blob = new Blob(chunks, { type: micTestRecorder?.mimeType || 'audio/webm' });
				micTestAudioUrl = URL.createObjectURL(blob);
				micTestState = 'ready';
				cleanupMicTest();
			};
			micTestRecorder.start();
			setTimeout(() => {
				if (micTestRecorder && micTestRecorder.state === 'recording') {
					micTestRecorder.stop();
				}
			}, 4000);
		} catch (error) {
			console.error('Mic test failed:', error);
			micTestState = 'idle';
			cleanupMicTest();
			alert('Mic test failed. Please check microphone permissions.');
		}
	}

	function updateCallTransportMode(mode: CallTransportMode) {
		callTransportMode = mode;
		setCallTransportMode(mode);
	}

	function toggleSrtGateway() {
		if (!localAppRuntime) return;
		srtGatewayEnabled = !srtGatewayEnabled;
		setSrtGatewayEnabled(srtGatewayEnabled);
	}

	function updateScreenShareQualityPreset(preset: ScreenShareQualityPreset) {
		screenShareQualityPreset = preset;
		setScreenShareQualityPreset(preset);
	}

	function sampleMemoryTelemetry() {
		const mem = (performance as Performance & {
			memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
		}).memory;
		if (!mem) return;
		memoryUsedMb = mem.usedJSHeapSize / (1024 * 1024);
		memoryTotalMb = mem.totalJSHeapSize / (1024 * 1024);
		memoryLimitMb = mem.jsHeapSizeLimit / (1024 * 1024);
		memoryUsedPct = memoryTotalMb > 0 ? (memoryUsedMb / memoryTotalMb) * 100 : 0;
	}

	function startMemoryTelemetry() {
		if (!isDevBuild || !memoryTelemetrySupported) return;
		stopMemoryTelemetry();
		sampleMemoryTelemetry();
		memoryTelemetryInterval = window.setInterval(sampleMemoryTelemetry, 2000);
	}

	function stopMemoryTelemetry() {
		if (memoryTelemetryInterval !== null) {
			clearInterval(memoryTelemetryInterval);
			memoryTelemetryInterval = null;
		}
	}

	function toggleMemoryTelemetry() {
		memoryTelemetryEnabled = !memoryTelemetryEnabled;
		localStorage.setItem(MEMORY_TELEMETRY_KEY, memoryTelemetryEnabled ? 'true' : 'false');
		if (memoryTelemetryEnabled) {
			startMemoryTelemetry();
		} else {
			stopMemoryTelemetry();
		}
	}

	function toggleSpatialAudio() {
		spatialAudioEnabled = !spatialAudioEnabled;
		setSpatialAudioEnabled(spatialAudioEnabled);
		refreshSpatialAudioRuntime();
	}

	function updateSpatialAudioMode(mode: SpatialAudioMode) {
		spatialAudioMode = mode;
		setSpatialAudioMode(mode);
		refreshSpatialAudioRuntime();
	}

	function updateSpatialAudioStrength(value: number) {
		spatialAudioStrength = value;
		setSpatialAudioMasterStrength(value);
		refreshSpatialAudioRuntime();
	}

	function updateSpatialAudioDistanceScale(value: number) {
		spatialAudioDistanceScale = value;
		setSpatialAudioDistanceScale(value);
		refreshSpatialAudioRuntime();
	}

	function toggleSpatialWarningsMuted() {
		spatialAudioWarningsMuted = !spatialAudioWarningsMuted;
		setSpatialAudioWarningMuted(spatialAudioWarningsMuted);
		refreshSpatialAudioRuntime();
	}

	function toggleSpatialQuickToggleVisible() {
		spatialAudioQuickToggleVisible = !spatialAudioQuickToggleVisible;
		setSpatialAudioQuickToggleVisible(spatialAudioQuickToggleVisible);
		refreshSpatialAudioRuntime();
	}

	// Handle theme change
	async function handleThemeChange(themeId: string) {
		try {
			savingTheme = true;
			themeStore.setThemeId(themeId);

			// Check if user is registered
			const isRegistered = !!localStorage.getItem('authToken');

			if (isRegistered) {
				// Save to server for registered users
				await saveThemePreferences({ theme_id: themeId });
			} else {
				// Save to localStorage for guests
				saveThemeToLocalStorage(themeId);
			}
		} catch (error) {
			console.error('[Settings] Failed to save theme:', error);
			alert('Failed to save theme preferences. Please try again.');
		} finally {
			savingTheme = false;
		}
	}

	function updateNotificationSound(sound: string) {
		notificationSound = sound;
		localStorage.setItem('notificationSound', sound);
	}

	function updateNotificationVolume(volume: number) {
		notificationVolume = volume;
		localStorage.setItem('notificationVolume', volume.toString());
	}

	function testNotificationSound() {
		playNotificationSound();
	}

	function updateTextScale(value: number) {
		const next = updateAccessibilitySettings({ textScale: value });
		textScale = next.textScale;
	}

	function resetTextScale() {
		updateTextScale(1);
	}

	function toggleColorAssistEnabled() {
		const next = updateAccessibilitySettings({ colorAssistEnabled: !colorAssistEnabled });
		colorAssistEnabled = next.colorAssistEnabled;
	}

	function updateSaturation(value: number) {
		const next = updateAccessibilitySettings({ saturation: value });
		saturation = next.saturation;
	}

	function updateContrast(value: number) {
		const next = updateAccessibilitySettings({ contrast: value });
		contrast = next.contrast;
	}

	function toggleReducedMotion() {
		const next = updateAccessibilitySettings({ reducedMotion: !reducedMotion });
		reducedMotion = next.reducedMotion;
	}

	function updateRoleColorMode(mode: RoleColorMode) {
		const next = updateAccessibilitySettings({ roleColorMode: mode });
		roleColorMode = next.roleColorMode;
	}

	function resetAccessibilityVisuals() {
		const next = updateAccessibilitySettings({
			colorAssistEnabled: false,
			saturation: 1,
			contrast: 1,
			reducedMotion: false,
			roleColorMode: 'full'
		});
		colorAssistEnabled = next.colorAssistEnabled;
		saturation = next.saturation;
		contrast = next.contrast;
		reducedMotion = next.reducedMotion;
		roleColorMode = next.roleColorMode;
	}

	function exportData() {
		const data = {
			channelMessages: $channelMessages,
			users: $users,
			currentUser: $currentUser,
			exportedAt: new Date().toISOString()
		};

		const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `chat-export-all-channels-${Date.now()}.json`;
		a.click();
		URL.revokeObjectURL(url);
	}

	async function requestNotificationPermission() {
		if (!('Notification' in window)) {
			alert('This browser does not support notifications');
			return;
		}

		if (Notification.permission === 'granted') {
			alert('Notifications are already enabled!');
			return;
		}

		const permission = await Notification.requestPermission();
		if (permission === 'granted') {
			notificationsEnabled = true;
			localStorage.setItem('notificationsEnabled', 'true');
			new Notification('Community Chat', {
				body: 'Notifications enabled! You\'ll be notified of new messages.',
				icon: '/icon-192.png'
			});
		} else {
			notificationsEnabled = false;
			localStorage.setItem('notificationsEnabled', 'false');
		}
	}

	function clearAllData() {
		showClearDataConfirm = true;
	}

	function confirmClearData() {
		channelMessages.set({ general: [] });
		localStorage.clear();
		alert('All data cleared.');
		showClearDataConfirm = false;
	}

	async function clearServerMessages() {
		showClearServerConfirm = true;
	}

	async function handleEmojiFileSelect(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];

		if (!file) return;

		// Check if it's an image
		if (!file.type.startsWith('image/')) {
			alert('Please select an image file (PNG, GIF, JPG, etc.)');
			return;
		}

		// Check file size (2MB limit)
		if (file.size > 2 * 1024 * 1024) {
			alert('File too large! Maximum size is 2MB');
			return;
		}

		selectedEmojiFile = file;

		// Generate preview
		const reader = new FileReader();
		reader.onload = (e) => {
			emojiPreview = e.target?.result as string;
		};
		reader.readAsDataURL(file);
	}

	async function uploadEmoji() {
		if (!selectedEmojiFile || !emojiName.trim()) {
			alert('Please select a file and enter an emoji name');
			return;
		}

		uploadingEmoji = true;

		try {
			const serverUrl = getServerUrl();

			// Upload the file
			const formData = new FormData();
			formData.append('file', selectedEmojiFile);
			formData.append('name', emojiName.trim());
			formData.append('displayName', emojiDisplayName.trim());
			formData.append('artist', emojiArtist.trim());
			formData.append('category', emojiCategory);
			formData.append('type', emojiType);

			// Get auth token from localStorage
			const authToken = localStorage.getItem('authToken');
			const headers: HeadersInit = {};
			if (authToken) {
				headers['Authorization'] = `Bearer ${authToken}`;
			}

			const response = await fetch(`${serverUrl}/api/emoji/upload`, {
				method: 'POST',
				headers,
				body: formData
			});

			if (!response.ok) {
				throw new Error('Upload failed');
			}

			const result = await response.json();
			const uploadedType = emojiType;

			// Emit socket event to notify all clients
			const socket = getSocket();
			socket?.emit('emoji-added', result.emoji);

			// Reset form
			emojiName = '';
			emojiDisplayName = '';
			emojiArtist = '';
			emojiCategory = 'custom';
			emojiType = 'emoji';
			selectedEmojiFile = null;
			emojiPreview = null;
			if (emojiFileInput) emojiFileInput.value = '';

			alert(`${uploadedType === 'sticker' ? 'Sticker' : 'Emoji'} "${result.emoji.displayName || result.emoji.name}" uploaded successfully!`);
		} catch (error) {
			console.error('Emoji upload error:', error);
			alert('Failed to upload emoji. Please try again.');
		} finally {
			uploadingEmoji = false;
		}
	}

	function deleteEmoji(emojiName: string) {
		if (!confirm(`Delete emoji ":${emojiName}:"?`)) return;

		const socket = getSocket();
		socket?.emit('delete-emoji', emojiName);
	}

	async function handleBulkEmojiFileSelect(event: Event) {
		const input = event.target as HTMLInputElement;
		const files = Array.from(input.files || []);

		if (files.length === 0) return;

		// Filter only image files
		const imageFiles = files.filter(f => f.type.startsWith('image/'));

		if (imageFiles.length === 0) {
			alert('No valid image files selected');
			return;
		}

		// Check file sizes
		for (const file of imageFiles) {
			if (file.size > 2 * 1024 * 1024) {
				alert(`File "${file.name}" is too large! Maximum size is 2MB`);
				return;
			}
		}

		// Generate previews and auto-name from filename
		const filesWithPreviews = await Promise.all(
			imageFiles.map(async (file) => {
				const preview = await new Promise<string>((resolve) => {
					const reader = new FileReader();
					reader.onload = (e) => resolve(e.target?.result as string);
					reader.readAsDataURL(file);
				});

				// Auto-generate name from filename (remove extension, sanitize)
				const baseName = file.name.replace(/\.[^/.]+$/, '');
				const autoName = baseName
					.toLowerCase()
					.replace(/[^a-z0-9_]/g, '_') // Replace non-alphanumeric with underscore
					.replace(/_+/g, '_') // Replace multiple underscores with single
					.replace(/^_|_$/g, ''); // Remove leading/trailing underscores

				const displayName = baseName
					.replace(/[_-]+/g, ' ')
					.replace(/\s+/g, ' ')
					.trim();

				return { file, name: autoName, displayName, preview };
			})
		);

		bulkEmojiFiles = filesWithPreviews;
	}

	async function uploadBulkEmojis() {
		if (bulkEmojiFiles.length === 0) {
			alert('No files selected');
			return;
		}

		// Check for empty names
		const emptyNames = bulkEmojiFiles.filter(f => !f.name.trim());
		if (emptyNames.length > 0) {
			alert('All emojis must have a name');
			return;
		}

		uploadingBulk = true;
		let successCount = 0;
		let failCount = 0;

		try {
			const serverUrl = getServerUrl();

			// Get auth token from localStorage
			const authToken = localStorage.getItem('authToken');
			const headers: HeadersInit = {};
			if (authToken) {
				headers['Authorization'] = `Bearer ${authToken}`;
			}

			for (const item of bulkEmojiFiles) {
				try {
					const formData = new FormData();
					formData.append('file', item.file);
					formData.append('name', item.name.trim());
					formData.append('displayName', item.displayName.trim());
					formData.append('artist', bulkEmojiArtist.trim());
					formData.append('category', emojiCategory);
					formData.append('type', emojiType);

					const response = await fetch(`${serverUrl}/api/emoji/upload`, {
						method: 'POST',
						headers,
						body: formData
					});

					if (!response.ok) {
						const error = await response.json();
						console.error(`Failed to upload ${item.name}:`, error);
						failCount++;
						continue;
					}

					const result = await response.json();

					// Emit socket event to notify all clients
					const socket = getSocket();
					socket?.emit('emoji-added', result.emoji);

					successCount++;
				} catch (error) {
					console.error(`Error uploading ${item.name}:`, error);
					failCount++;
				}
			}

			// Reset form
			bulkEmojiFiles = [];
			bulkEmojiArtist = '';
			if (bulkEmojiFileInput) bulkEmojiFileInput.value = '';

			alert(`Upload complete!\n\u2705 ${successCount} successful\n\u274C ${failCount} failed`);
		} catch (error) {
			console.error('Bulk upload error:', error);
			alert('Failed to upload emojis. Please try again.');
		} finally {
			uploadingBulk = false;
		}
	}

	function removeBulkEmoji(index: number) {
		bulkEmojiFiles = bulkEmojiFiles.filter((_, i) => i !== index);
	}

	async function confirmClearServer() {

		try {
			const serverUrl = getServerUrl();

			// Get auth token from localStorage
			const authToken = localStorage.getItem('authToken');
			const headers: HeadersInit = {
				'Content-Type': 'application/json'
			};
			if (authToken) {
				headers['Authorization'] = `Bearer ${authToken}`;
			}

			const response = await fetch(`${serverUrl}/api/clear-messages`, {
				method: 'POST',
				headers
			});

			const result = await response.json();

			if (result.success) {
				// Also clear local data
				channelMessages.set({ general: [] });
				alert('All server messages have been deleted successfully!');
			} else {
				alert('Failed to clear server messages: ' + (result.error || 'Unknown error'));
			}
		} catch (error) {
			console.error('Error clearing server messages:', error);
			alert('Failed to clear server messages. Check console for details.');
		}
		showClearServerConfirm = false;
	}

	function closeModal() {
		cleanupMicTest();
		isOpen = false;
	}

	function handleLogout() {
		closeModal();
		dispatch('logout');
	}

	function handleAvatarSelected(event: CustomEvent<{ file: File; dataUrl: string }>) {
		selectedAvatarFile = event.detail.file;
		selectedAvatarPreview = event.detail.dataUrl;
		uploadProfilePicture();
	}

	async function uploadProfilePicture() {
		if (!selectedAvatarFile) {
			alert('No image selected for upload.');
			return;
		}

		uploadingAvatar = true;

		try {
			const serverUrl = getServerUrl();

			const formData = new FormData();
			formData.append('profilePicture', selectedAvatarFile);

			// Get auth token from localStorage
			const authToken = localStorage.getItem('authToken');
			const headers: HeadersInit = {};
			if (authToken) {
				headers['Authorization'] = `Bearer ${authToken}`;
			}

			const response = await fetch(`${serverUrl}/api/upload-profile-picture`, {
				method: 'POST',
				headers,
				body: formData
			});

			if (!response.ok) {
				throw new Error('Failed to upload profile picture.');
			}

			const result = await response.json();
			if (result.profilePictureUrl) {
				updateProfile(undefined, result.profilePictureUrl);
				alert('Profile picture updated successfully!');
			} else {
				throw new Error('No profile picture URL returned.');
			}
		} catch (error) {
			console.error('Error uploading profile picture:', error);
			alert('Failed to upload profile picture. Please try again.');
		} finally {
			uploadingAvatar = false;
			selectedAvatarFile = null;
			selectedAvatarPreview = null;
		}
	}

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
		updateProfile(undefined, undefined, undefined, nextName, (response) => {
			updatingDisplayName = false;
			if (!response.success) {
				alert(response.error || 'Failed to update display name.');
			}
		});
	}
</script>

{#if isOpen}
	<div
		class="modal-overlay"
		role="button"
		tabindex="0"
		on:click={closeModal}
		on:keydown={(event) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				closeModal();
			}
		}}
	>
		<div
			class="modal-content"
			role="button"
			tabindex="0"
			on:click|stopPropagation
			on:keydown|stopPropagation={(event) => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
				}
			}}
		>
			<div class="modal-header">
				<h2>
				<svg class="header-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
				Settings
			</h2>
				<button class="close-btn" on:click={closeModal}>&#x2715;</button>
			</div>

			<div class="settings-layout">
				<div class="settings-tabs">
					<button class="settings-tab" class:active={activeSettingsTab === 'profile'} on:click={() => activeSettingsTab = 'profile'}>Profile</button>
					<button class="settings-tab" class:active={activeSettingsTab === 'audio'} on:click={() => activeSettingsTab = 'audio'}>Audio and Video</button>
					<button class="settings-tab" class:active={activeSettingsTab === 'notifications'} on:click={() => activeSettingsTab = 'notifications'}>Notifications</button>
					<button class="settings-tab" class:active={activeSettingsTab === 'accessibility'} on:click={() => activeSettingsTab = 'accessibility'}>Accessibility</button>
					<button class="settings-tab" class:active={activeSettingsTab === 'appearance'} on:click={() => activeSettingsTab = 'appearance'}>Appearance</button>
					<button class="settings-tab" class:active={activeSettingsTab === 'server'} on:click={() => activeSettingsTab = 'server'}>Server</button>
					<button class="settings-tab" class:active={activeSettingsTab === 'emojis'} on:click={() => activeSettingsTab = 'emojis'}>Emojis</button>
					<button class="settings-tab" class:active={activeSettingsTab === 'storage'} on:click={() => activeSettingsTab = 'storage'}>Storage</button>
					{#if canManageAdmin}
						<button class="settings-tab" class:active={activeSettingsTab === 'admin'} on:click={() => activeSettingsTab = 'admin'}>Admin</button>
					{/if}
					<button class="settings-tab" class:active={activeSettingsTab === 'about'} on:click={() => activeSettingsTab = 'about'}>About</button>
					<div class="settings-tabs-spacer"></div>
					<button class="settings-tab logout-tab" on:click={handleLogout}>Logout</button>
				</div>

				<div class="settings-content">
					{#if activeSettingsTab === 'profile'}
						<div class="settings-section">
							<h3>Display Name</h3>
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
							<h3>Profile Picture</h3>
							<div class="pfp-upload-section">
								<div class="current-pfp">
									{#if $currentUser?.profilePicture}
										<img src={$currentUser.profilePicture} alt="Current PFP" class="pfp-current-img" />
									{:else}
										<div class="pfp-placeholder" style="background-color: var(--accent);">
											{$currentUser?.username?.charAt(0).toUpperCase() || '?'}
										</div>
									{/if}
								</div>
								<div class="pfp-upload-form">
									<button class="pfp-select-btn" on:click={() => showAvatarEditor = true}>
										Change Profile Picture
									</button>
									{#if uploadingAvatar}
										<p>Uploading...</p>
									{/if}
								</div>
							</div>
						</div>
						<div class="settings-section">
							<UsernameFontCustomizer />
						</div>

					{:else if activeSettingsTab === 'audio'}
						<div class="settings-section">
							<h3>Audio and Video</h3>
							<div class="setting-item">
								<div class="setting-info">
									<span class="setting-label">Sound Effects</span>
									<span class="setting-description">Play sounds for messages and notifications</span>
								</div>
								<button class="toggle-btn" class:active={soundEnabled} on:click={toggleSound}>
									{#if soundEnabled}
										<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path></svg>
									{:else}
										<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>
									{/if}
								</button>
							</div>
							<div class="setting-item">
								<div class="setting-info">
									<span class="setting-label">Microphone</span>
									<span class="setting-description">Enable microphone for voice calls</span>
								</div>
								<button class="toggle-btn" class:active={micEnabled} on:click={toggleMic}>
									{#if micEnabled}
										<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>
									{:else}
										<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path><path d="M17 16.95A7 7 0 0 1 5 12m14 0a7 7 0 0 1-13.46 3.4"></path></svg>
									{/if}
								</button>
							</div>
							<div class="setting-item">
								<div class="setting-info">
									<span class="setting-label">Camera</span>
									<span class="setting-description">Enable camera for video calls</span>
								</div>
								<button class="toggle-btn" class:active={cameraEnabled} on:click={toggleCamera}>
									{cameraEnabled ? 'On' : 'Off'}
								</button>
							</div>
							<div class="media-quality-notice" role="note">
								<div class="notice-title">Call Quality Runtime Notice</div>
								<div class="notice-body">
									{#if localAppRuntime}
										You are running the Local App runtime. Enhanced audio/video tuning is available, including optional SRT gateway controls.
									{:else}
										You are running Web runtime. Calls use compatibility-first media settings. For best audio quality, use the Local App.
									{/if}
								</div>

								<div class="quality-mode-row">
									<label for="audio-processing-mode">Audio Processing</label>
									<select
										id="audio-processing-mode"
										class="theme-select"
										value={audioProcessingMode}
										on:change={(e) => updateAudioProcessingMode(e.currentTarget.value as AudioProcessingMode)}
									>
										<option value="auto">Automatic (Recommended)</option>
										<option value="dsp">DSP (Low CPU)</option>
										<option value="rnn">RNN / Native Suppression</option>
										<option value="studio">Studio / Raw</option>
									</select>
								</div>
								{#if $audioProcessingRuntimeStatus.fallbackActive || $audioProcessingRuntimeStatus.reason}
									<div class="runtime-note">
										Effective mode: <strong>{$audioProcessingRuntimeStatus.effective.toUpperCase()}</strong>
										{#if $audioProcessingRuntimeStatus.reason === 'performance_guard'}
											(performance fallback)
										{:else if $audioProcessingRuntimeStatus.reason === 'native_not_supported'}
											(native suppression not supported on this runtime)
										{/if}
									</div>
								{/if}

								<div class="setting-item">
									<div class="setting-info">
										<span class="setting-label">Spatial Audio</span>
										<span class="setting-description">Position call participants in stereo/3D space.</span>
									</div>
									<button class="toggle-btn" class:active={spatialAudioEnabled} on:click={toggleSpatialAudio}>
										{spatialAudioEnabled ? 'ON' : 'OFF'}
									</button>
								</div>

								<div class="quality-mode-row">
									<label for="spatial-audio-mode">Spatial Rendering</label>
									<select
										id="spatial-audio-mode"
										class="theme-select"
										value={spatialAudioMode}
										on:change={(e) => updateSpatialAudioMode(e.currentTarget.value as SpatialAudioMode)}
										disabled={!spatialAudioEnabled}
									>
										<option value="auto">Auto (Recommended)</option>
										<option value="pan_distance">Stereo Pan + Distance</option>
										<option value="full_3d">Full 3D (HRTF)</option>
										<option value="off">Off</option>
									</select>
								</div>

								<div class="setting-item-full">
									<div class="setting-info">
										<span class="setting-label">Spatial Strength</span>
										<span class="setting-description">{Math.round(spatialAudioStrength * 100)}%</span>
									</div>
									<input
										type="range"
										min="0"
										max="1"
										step="0.05"
										bind:value={spatialAudioStrength}
										on:input={(e) => updateSpatialAudioStrength(parseFloat(e.currentTarget.value))}
										class="volume-slider"
										disabled={!spatialAudioEnabled}
									/>
								</div>

								<div class="setting-item-full">
									<div class="setting-info">
										<span class="setting-label">Spatial Distance Scale</span>
										<span class="setting-description">{spatialAudioDistanceScale.toFixed(2)}x</span>
									</div>
									<input
										type="range"
										min="0.4"
										max="4"
										step="0.1"
										bind:value={spatialAudioDistanceScale}
										on:input={(e) => updateSpatialAudioDistanceScale(parseFloat(e.currentTarget.value))}
										class="volume-slider"
										disabled={!spatialAudioEnabled}
									/>
								</div>

								<div class="setting-item">
									<div class="setting-info">
										<span class="setting-label">Mute Spatial Warnings</span>
										<span class="setting-description">Hide one-time fallback notices during calls.</span>
									</div>
									<button class="toggle-btn" class:active={spatialAudioWarningsMuted} on:click={toggleSpatialWarningsMuted}>
										{spatialAudioWarningsMuted ? 'ON' : 'OFF'}
									</button>
								</div>

								<div class="setting-item">
									<div class="setting-info">
										<span class="setting-label">Show In-Call Spatial Toggle</span>
										<span class="setting-description">Display quick enable/disable button in call controls.</span>
									</div>
									<button class="toggle-btn" class:active={spatialAudioQuickToggleVisible} on:click={toggleSpatialQuickToggleVisible}>
										{spatialAudioQuickToggleVisible ? 'ON' : 'OFF'}
									</button>
								</div>

								{#if $spatialAudioRuntimeStatus.active || $spatialAudioRuntimeStatus.fallbackReason}
									<div class="runtime-note">
										Spatial runtime: <strong>{$spatialAudioRuntimeStatus.effectiveMode.toUpperCase()}</strong>
										{#if $spatialAudioRuntimeStatus.fallbackReason}
											({$spatialAudioRuntimeStatus.fallbackReason.replace('_', ' ')})
										{/if}
									</div>
								{/if}

								<div class="setting-item-full">
									<div class="setting-info">
										<span class="setting-label">Mic Test</span>
										<span class="setting-description">Record 4 seconds with the selected audio mode, then play it back.</span>
									</div>
									<button
										class="action-btn"
										on:click={runMicTest}
										disabled={micTestState === 'recording'}
									>
										{micTestState === 'recording' ? 'Recording...' : 'Record 4s Sample'}
									</button>
									<div class="volume-slider" aria-label="Mic input level">
										<div style="height: 8px; border-radius: 6px; background: var(--bg-secondary); overflow: hidden;">
											<div style="height: 100%; width: {Math.round(micTestLevel * 100)}%; background: var(--accent); transition: width 80ms linear;"></div>
										</div>
									</div>
									{#if micTestAudioUrl}
										<audio src={micTestAudioUrl} controls></audio>
									{/if}
								</div>

								<div class="quality-mode-row">
									<label for="media-quality-mode">Media Quality Mode</label>
									<select
										id="media-quality-mode"
										class="theme-select"
										value={mediaQualityMode}
										on:change={(e) => updateMediaQualityMode(e.currentTarget.value as MediaQualityMode)}
									>
										<option value="web-baseline">Web Baseline</option>
										<option value="local-enhanced" disabled={!localAppRuntime}>Local App Enhanced</option>
									</select>
								</div>

								<div class="quality-mode-row">
									<label for="screen-share-quality">Screen Share Resolution</label>
									<select
										id="screen-share-quality"
										class="theme-select"
										value={screenShareQualityPreset}
										on:change={(e) => updateScreenShareQualityPreset(e.currentTarget.value as ScreenShareQualityPreset)}
									>
										<option value="auto">Auto (Recommended)</option>
										<option value="1080p">1080p</option>
										<option value="720p">720p</option>
										<option value="480p">480p</option>
										<option value="144p-mobile">144p (Mobile / Low data)</option>
									</select>
								</div>

								<div class="quality-mode-row">
									<label for="call-transport-mode">Call Transport Strategy</label>
									<select
										id="call-transport-mode"
										class="theme-select"
										value={callTransportMode}
										on:change={(e) => updateCallTransportMode(e.currentTarget.value as CallTransportMode)}
									>
										<option value="auto">Auto (Fallback Enabled)</option>
										<option value="p2p-only">P2P/TURN Only</option>
										<option value="sfu-preferred">SFU Preferred (Fallback to P2P)</option>
									</select>
								</div>

								<div class="setting-item">
									<div class="setting-info">
										<span class="setting-label">SRT Gateway (Beta)</span>
										<span class="setting-description">Requires Local App + self-hosted media gateway. Browser-only calls do not use SRT directly.</span>
									</div>
									<button class="toggle-btn" class:active={srtGatewayEnabled} on:click={toggleSrtGateway} disabled={!localAppRuntime}>
										{srtGatewayEnabled ? 'ON' : 'OFF'}
									</button>
								</div>

								{#if !localAppRuntime && browser}
									<p class="runtime-note">Tip: install the Local App (Tauri) to unlock enhanced call quality mode.</p>
								{/if}
							</div>
						</div>

					{:else if activeSettingsTab === 'notifications'}
						<div class="settings-section">
							<h3>Notifications</h3>
							<div class="setting-item">
								<div class="setting-info">
									<span class="setting-label">Desktop Notifications</span>
									<span class="setting-description">Get notified when you receive new messages</span>
								</div>
								<button class="action-btn" class:active={notificationsEnabled} on:click={requestNotificationPermission}>
									{notificationsEnabled ? 'Enabled' : 'Enable'}
								</button>
							</div>

							<div class="setting-item">
								<div class="setting-info">
									<span class="setting-label">Suppress @everyone, @here, and @all</span>
									<span class="setting-description">Do not notify when broad mentions are used</span>
								</div>
								<button class="toggle-btn" class:active={suppressEveryoneHereMentions} on:click={toggleSuppressEveryoneHereMentions}>
									{suppressEveryoneHereMentions ? 'ON' : 'OFF'}
								</button>
							</div>

							<div class="setting-item">
								<div class="setting-info">
									<span class="setting-label">Suppress All Role @mentions</span>
									<span class="setting-description">Do not notify when role mentions are used</span>
								</div>
								<button class="toggle-btn" class:active={suppressRoleMentions} on:click={toggleSuppressRoleMentions}>
									{suppressRoleMentions ? 'ON' : 'OFF'}
								</button>
							</div>

							<div class="setting-item-full">
								<div class="setting-info">
									<span class="setting-label">
										<svg class="setting-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
										Notification Sound
									</span>
									<span class="setting-description">Choose which sound to play for notifications</span>
								</div>
								<div class="sound-options">
									<button
										class="sound-option"
										class:active={notificationSound === '/sounds/ProjectSound.ogg'}
										on:click={() => updateNotificationSound('/sounds/ProjectSound.ogg')}
									>
										ProjectSound.ogg
									</button>
								</div>
								<button class="test-sound-btn" on:click={testNotificationSound}>
									Test Sound
								</button>
							</div>

							<div class="setting-item-full">
								<div class="setting-info">
									<span class="setting-label">Notification Volume</span>
									<span class="setting-description">Adjust the volume of notification sounds ({Math.round(notificationVolume * 100)}%)</span>
								</div>
								<input
									type="range"
									min="0"
									max="1"
									step="0.05"
									bind:value={notificationVolume}
									on:input={(e) => updateNotificationVolume(parseFloat(e.currentTarget.value))}
									class="volume-slider"
								/>
							</div>
						</div>

					{:else if activeSettingsTab === 'accessibility'}
						<div class="settings-section">
							<h3>Accessibility</h3>
							<div class="setting-item-full">
								<div class="setting-info">
									<span class="setting-label">Text Size</span>
									<span class="setting-description">Scale interface text size ({Math.round(textScale * 100)}%)</span>
								</div>
								<input
									type="range"
									min="0.85"
									max="1.35"
									step="0.05"
									bind:value={textScale}
									on:input={(e) => updateTextScale(parseFloat(e.currentTarget.value))}
									class="volume-slider"
								/>
								<div class="font-scale-presets">
									<button type="button" class="sound-option" class:active={Math.abs(textScale - 0.9) < 0.01} on:click={() => updateTextScale(0.9)}>Small</button>
									<button type="button" class="sound-option" class:active={Math.abs(textScale - 1) < 0.01} on:click={() => updateTextScale(1)}>Default</button>
									<button type="button" class="sound-option" class:active={Math.abs(textScale - 1.15) < 0.01} on:click={() => updateTextScale(1.15)}>Large</button>
									<button type="button" class="sound-option" class:active={Math.abs(textScale - 1.3) < 0.01} on:click={() => updateTextScale(1.3)}>XL</button>
									<button type="button" class="sound-option" on:click={resetTextScale}>Reset Text Size</button>
								</div>
							</div>

							<div class="setting-item">
								<div class="setting-info">
									<span class="setting-label">Color Assist</span>
									<span class="setting-description">Enable saturation/contrast filters for color accessibility tuning</span>
								</div>
								<button class="toggle-btn" class:active={colorAssistEnabled} on:click={toggleColorAssistEnabled}>
									{colorAssistEnabled ? 'ON' : 'OFF'}
								</button>
							</div>

							<div class="setting-item-full">
								<div class="setting-info">
									<span class="setting-label">Saturation</span>
									<span class="setting-description">{Math.round(saturation * 100)}%</span>
								</div>
								<input
									type="range"
									min="0.6"
									max="1.8"
									step="0.05"
									bind:value={saturation}
									on:input={(e) => updateSaturation(parseFloat(e.currentTarget.value))}
									class="volume-slider"
									disabled={!colorAssistEnabled}
								/>
							</div>

							<div class="setting-item-full">
								<div class="setting-info">
									<span class="setting-label">Contrast</span>
									<span class="setting-description">{Math.round(contrast * 100)}%</span>
								</div>
								<input
									type="range"
									min="0.8"
									max="1.4"
									step="0.05"
									bind:value={contrast}
									on:input={(e) => updateContrast(parseFloat(e.currentTarget.value))}
									class="volume-slider"
									disabled={!colorAssistEnabled}
								/>
							</div>

							<div class="setting-item">
								<div class="setting-info">
									<span class="setting-label">Reduce Motion</span>
									<span class="setting-description">Minimize animations and transitions</span>
								</div>
								<button class="toggle-btn" class:active={reducedMotion} on:click={toggleReducedMotion}>
									{reducedMotion ? 'ON' : 'OFF'}
								</button>
							</div>

							<div class="setting-item">
								<div class="setting-info">
									<span class="setting-label">Role Color Display</span>
									<span class="setting-description">Control how role colors are shown on usernames</span>
								</div>
								<select
									class="theme-select"
									value={roleColorMode}
									on:change={(e) => updateRoleColorMode(e.currentTarget.value as RoleColorMode)}
								>
									<option value="full">Full color in names</option>
									<option value="dot">Dot/badge only</option>
									<option value="off">Off</option>
								</select>
							</div>

							<div class="setting-item-full">
								<button type="button" class="action-btn" on:click={resetAccessibilityVisuals}>Reset Accessibility Visuals</button>
							</div>
						</div>

					{:else if activeSettingsTab === 'appearance'}
						<div class="settings-section">
							<h3>Appearance</h3>
							<div class="setting-item">
								<div class="setting-info">
									<span class="setting-label">Theme</span>
									<span class="setting-description">Choose your preferred theme</span>
								</div>
								<select
									class="theme-select"
									value={$themeStore.themeId}
									on:change={(e) => handleThemeChange(e.currentTarget.value)}
									disabled={savingTheme}
								>
									{#each Object.values(THEMES) as theme}
										<option value={theme.id}>
											{theme.name}
										</option>
									{/each}
								</select>
							</div>
							{#if savingTheme}
								<div class="save-indicator">
									<span class="spinner">...</span> Saving theme...
								</div>
							{/if}

							<div class="customizer-container">
								<ThemeCustomizer />
							</div>

							<div class="customizer-container">
								<UniformFontMode />
							</div>
						</div>

					{:else if activeSettingsTab === 'server'}
						<div class="settings-section">
							<h3>Server Management</h3>
							<div class="setting-item">
								<div class="setting-info">
									<span class="setting-label">Clear All Server Messages</span>
									<span class="setting-description">Delete all messages from the server for all users (cannot be undone)</span>
								</div>
								<button class="action-btn danger" on:click={clearServerMessages}>
									Clear Server
								</button>
							</div>
						</div>

					{:else if activeSettingsTab === 'emojis'}
						<div class="settings-section">
							<h3>Custom Emojis</h3>
							<div class="emoji-upload-form">
								<input
									type="file"
									bind:this={emojiFileInput}
									on:change={handleEmojiFileSelect}
									accept="image/*"
									style="display: none;"
								/>

								{#if emojiPreview}
									<div class="emoji-preview">
										<img src={emojiPreview} alt="Preview" />
									</div>
								{/if}

								<button class="emoji-select-btn" on:click={() => emojiFileInput?.click()}>
									{emojiPreview ? 'Change Image' : 'Select Image'}
								</button>

								<input
									type="text"
									bind:value={emojiName}
									placeholder="Shortcode (e.g., tabi_wave)"
									maxlength="30"
									class="emoji-name-input"
								/>

								<input
									type="text"
									bind:value={emojiDisplayName}
									placeholder="Display name (e.g., Tabi Wave)"
									maxlength="60"
									class="emoji-name-input"
								/>

								<input
									type="text"
									bind:value={emojiArtist}
									placeholder="Artist / pack creator (e.g., Tabi)"
									maxlength="60"
									class="emoji-name-input"
								/>

								<select bind:value={emojiType} class="emoji-category-select">
									<option value="emoji">Emoji</option>
									<option value="sticker">Sticker</option>
								</select>

								<select bind:value={emojiCategory} class="emoji-category-select">
									<option value="custom">Custom</option>
									<option value="animated">Animated</option>
									<option value="art">Art</option>
									<option value="memes">Memes</option>
								</select>

								<button
									class="emoji-upload-btn"
									on:click={uploadEmoji}
									disabled={uploadingEmoji || !selectedEmojiFile || !emojiName.trim()}
								>
									{uploadingEmoji ? 'Uploading...' : 'Upload Emoji'}
								</button>

								<p class="emoji-hint">Supports PNG, GIF (animated), JPG. Max 2MB.</p>
							</div>

							<div class="emoji-upload-form bulk">
								<h4>Bulk Upload</h4>
								<input
									type="file"
									bind:this={bulkEmojiFileInput}
									on:change={handleBulkEmojiFileSelect}
									accept="image/*"
									multiple
									style="display: none;"
								/>

								<button class="emoji-select-btn" on:click={() => bulkEmojiFileInput?.click()}>
									Select Multiple Images
								</button>

								<input
									type="text"
									bind:value={bulkEmojiArtist}
									placeholder="Artist / pack creator for this batch (e.g., Tabi)"
									maxlength="60"
									class="emoji-name-input"
								/>

								<select bind:value={emojiType} class="emoji-category-select">
									<option value="emoji">Emoji</option>
									<option value="sticker">Sticker</option>
								</select>

								{#if bulkEmojiFiles.length > 0}
									<div class="bulk-emoji-list">
										<p class="bulk-count">{bulkEmojiFiles.length} file(s) selected</p>
										{#each bulkEmojiFiles as item, index (index)}
											<div class="bulk-emoji-item">
												<img src={item.preview} alt="Preview" class="bulk-preview" />
												<input
													type="text"
													bind:value={item.name}
													placeholder="emoji_name"
													maxlength="30"
													class="bulk-name-input"
												/>
												<input
													type="text"
													bind:value={item.displayName}
													placeholder="Display name"
													maxlength="60"
													class="bulk-name-input"
												/>
												<button
													class="bulk-remove-btn"
													on:click={() => removeBulkEmoji(index)}
													title="Remove"
												>
													×
												</button>
											</div>
										{/each}
										<button
											class="emoji-upload-btn"
											on:click={uploadBulkEmojis}
											disabled={uploadingBulk || bulkEmojiFiles.length === 0}
										>
											{uploadingBulk ? 'Uploading...' : `Upload ${bulkEmojiFiles.length} ${emojiType === 'sticker' ? 'Sticker' : 'Emoji'}${bulkEmojiFiles.length > 1 ? 's' : ''}`}
										</button>
									</div>
								{/if}

								<p class="emoji-hint">Set shortcode + display names for search. Artist metadata is searchable in picker.</p>
							</div>

							<div class="emoji-list">
								<h4>Your Custom Emojis ({$emojis.filter(e => e.isCustom).length})</h4>
								<div class="emoji-grid-list">
									{#each $emojis.filter(e => e.isCustom) as emoji (emoji.id)}
										<div class="emoji-item">
											<img src={emoji.url} alt={emoji.name} class="emoji-thumb" />
											<div class="emoji-item-meta">
												<span class="emoji-item-name">:{emoji.name}:</span>
												{#if emoji.displayName}
													<span class="emoji-item-sub">{emoji.displayName}</span>
												{/if}
												{#if emoji.artist}
													<span class="emoji-item-sub">by {emoji.artist}</span>
												{/if}
											</div>
											<button
												class="emoji-delete-btn"
												on:click={() => deleteEmoji(emoji.name)}
												title="Delete emoji"
											>
												X
											</button>
										</div>
									{/each}
								</div>
							</div>
						</div>

					{:else if activeSettingsTab === 'storage'}
						<div class="settings-section">
							<StorageSettings />
						</div>

					{:else if activeSettingsTab === 'admin'}
						<div class="settings-section">
							<h3>Admin Panel</h3>
							<p class="admin-help">Manage live user roles from here or from user right-click menus.</p>
							<div class="admin-user-list">
								{#each sortedAdminUsers as user (user.id)}
									<div class="admin-user-item">
										<div class="admin-user-meta">
											<span class="admin-user-name">{user.username}</span>
											<span class="admin-role-badge">{getRoleLabel(user.highestRole || 'member')}</span>
											{#if !user.dbUserId}
												<span class="admin-guest-badge">{getRoleLabel('guest')} session</span>
											{/if}
										</div>
										<div class="admin-user-actions">
											<button
												class="action-btn"
												disabled={!canManageTargetUser(user) || userHasRole(user, 'admin')}
												on:click={() => promoteUser(user, 'admin')}
											>
												Make Admin
											</button>
											<button
												class="action-btn"
												disabled={!canManageTargetUser(user) || !userHasRole(user, 'admin')}
												on:click={() => removeRoleFromUser(user, 'admin')}
											>
												Remove Admin
											</button>
											<button
												class="action-btn"
												disabled={!canManageTargetUser(user) || userHasRole(user, 'mod')}
												on:click={() => promoteUser(user, 'mod')}
											>
												Make Mod
											</button>
											<button
												class="action-btn"
												disabled={!canManageTargetUser(user) || !userHasRole(user, 'mod')}
												on:click={() => removeRoleFromUser(user, 'mod')}
											>
												Remove Mod
											</button>
											<button
												class="action-btn danger"
												disabled={!canManageTargetUser(user) || (!userHasRole(user, 'admin') && !userHasRole(user, 'mod'))}
												on:click={() => resetUserToMember(user)}
											>
												Reset to Member
											</button>
										</div>
									</div>
								{/each}
							</div>
						</div>

					{:else if activeSettingsTab === 'about'}
						<div class="settings-section">
							<h3>About</h3>
							<div class="about-info">
								<p><strong>Wabi Chat</strong></p>
								<p>Privacy-first ephemeral chat. No tracking. No data collection.</p>
								<p>Server stores nothing permanently. You control your data.</p>
								<p class="version">Version 1.0.0</p>
							</div>
							{#if isDevBuild}
								<div class="setting-item">
									<div class="setting-info">
										<span class="setting-label">Debug Memory Telemetry</span>
										<span class="setting-description">DEV only: samples browser JS heap every 2s.</span>
									</div>
									<button class="toggle-btn" class:active={memoryTelemetryEnabled} on:click={toggleMemoryTelemetry} disabled={!memoryTelemetrySupported}>
										{memoryTelemetryEnabled ? 'ON' : 'OFF'}
									</button>
								</div>
								{#if memoryTelemetryEnabled && memoryTelemetrySupported}
									<div class="runtime-note">
										Heap Used: <strong>{memoryUsedMb.toFixed(1)} MB</strong> /
										Total: <strong>{memoryTotalMb.toFixed(1)} MB</strong> /
										Limit: <strong>{memoryLimitMb.toFixed(0)} MB</strong>
										({memoryUsedPct.toFixed(1)}%)
									</div>
								{:else if !memoryTelemetrySupported}
									<div class="runtime-note">Telemetry unavailable on this runtime.</div>
								{/if}
							{/if}
						</div>
					{/if}
				</div>
			</div>
		</div>
	</div>
{/if}

<AvatarEditor bind:isOpen={showAvatarEditor} on:change={handleAvatarSelected} />

<ConfirmDialog
	isOpen={showClearDataConfirm}
	title="Clear Local Data"
	message="Are you sure you want to clear all chat data? This cannot be undone."
	confirmText="Clear Data"
	variant="danger"
	onConfirm={confirmClearData}
	onCancel={() => showClearDataConfirm = false}
/>

<ConfirmDialog
	isOpen={showClearServerConfirm}
	title="Clear Server Messages"
	message="Are you sure you want to delete ALL messages from the server? This will clear messages for all users and cannot be undone!"
	confirmText="Delete All"
	variant="danger"
	onConfirm={confirmClearServer}
	onCancel={() => showClearServerConfirm = false}
/>

<style>
	.modal-overlay {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background: rgba(0, 0, 0, 0.7);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
		backdrop-filter: blur(4px);
	}

	.modal-content {
		background: var(--bg-secondary);
		border-radius: 12px;
		width: 90%;
		max-width: 800px;
		max-height: 80vh;
		overflow: hidden;
		box-shadow: none;
		display: flex;
		flex-direction: column;
	}

	.modal-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 1.5rem;
		border-bottom: 1px solid var(--border);
		position: sticky;
		top: 0;
		background: var(--bg-secondary);
		z-index: 1;
	}

	.modal-header h2 {
		margin: 0;
		font-size: 1.5rem;
		color: var(--text-primary);
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.header-icon {
		width: 28px;
		height: 28px;
		stroke: currentColor;
		stroke-width: 2;
		flex-shrink: 0;
	}

	.setting-icon {
		width: 18px;
		height: 18px;
		stroke: currentColor;
		stroke-width: 2;
		display: inline;
		margin-right: 0.5rem;
	}

	.close-btn {
		background: transparent;
		border: none;
		font-size: 1.5rem;
		cursor: pointer;
		color: var(--text-secondary);
		padding: 0.25rem 0.5rem;
		transition: all 0.2s;
	}

	.close-btn:hover {
		color: var(--text-primary);
		transform: scale(1.1);
	}

	.settings-layout {
		display: flex;
		flex: 1;
		min-height: 0;
	}

	.settings-tabs {
		width: 180px;
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		padding: 0.5rem;
		border-right: 1px solid var(--border);
		background: var(--bg-tertiary);
		overflow-y: auto;
	}

	.settings-tabs-spacer {
		flex: 1;
	}

	.settings-tab {
		display: block;
		width: 100%;
		padding: 0.625rem 0.75rem;
		background: transparent;
		border: none;
		border-left: 3px solid transparent;
		border-radius: 0 6px 6px 0;
		color: var(--text-secondary);
		font-size: 0.875rem;
		font-weight: 500;
		text-align: left;
		cursor: pointer;
		transition: all 0.15s;
	}

	.settings-tab:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.settings-tab.active {
		background: rgba(var(--accent-rgb), 0.15);
		border-left-color: var(--accent);
		color: var(--text-primary);
	}

	.settings-tab.logout-tab {
		margin-top: 0.5rem;
		color: #ff7575;
	}

	.settings-tab.logout-tab:hover {
		background: rgba(255, 87, 87, 0.15);
		color: #ff9d9d;
	}

	.settings-content {
		padding: 1.5rem;
		display: flex;
		flex-direction: column;
		gap: 2rem;
		flex: 1;
		overflow-y: auto;
		min-height: 0;
	}

	.settings-section {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.settings-section h3 {
		margin: 0;
		font-size: 1.1rem;
		color: var(--text-primary);
		font-weight: 600;
	}

	.setting-item {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 1rem;
		background: var(--bg-tertiary);
		border-radius: 8px;
		transition: all 0.2s;
	}

	.setting-item:hover {
		background: var(--bg-hover);
	}

	.setting-info {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		flex: 1;
	}

	.setting-label {
		font-size: 0.95rem;
		font-weight: 500;
		color: var(--text-primary);
	}

	.setting-description {
		font-size: 0.8rem;
		color: var(--text-secondary);
	}

	.toggle-btn {
		background: var(--bg-secondary);
		border: none;
		border-radius: 8px;
		padding: 0.5rem 1rem;
		font-size: 1.2rem;
		cursor: pointer;
		transition: all 0.2s;
		min-width: 60px;
	}

	.toggle-btn:hover {
		transform: scale(1.05);
		border-color: var(--primary);
	}

	.toggle-btn.active {
		background: var(--primary);
		border-color: var(--primary);
	}

	.theme-select {
		background: var(--bg-secondary);
		color: var(--text-primary);
		border: 1px solid var(--ui-bg-light);
		border-radius: 8px;
		padding: 0.5rem 1rem;
		font-size: 0.9rem;
		cursor: pointer;
		transition: all 0.2s;
		min-width: 180px;
	}

	.theme-select:hover {
		border-color: var(--accent-hex);
	}

	.theme-select:focus {
		outline: none;
		border-color: var(--accent-hex);
		box-shadow: 0 0 0 2px rgba(var(--accent-rgb), 0.2);
	}

	.theme-select:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.save-indicator {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0;
		color: var(--text-secondary);
		font-size: 0.85rem;
	}

	.spinner {
		animation: spin 1s linear infinite;
	}

	@keyframes spin {
		from { transform: rotate(0deg); }
		to { transform: rotate(360deg); }
	}

	.customizer-container {
		margin-top: 1.5rem;
		padding-top: 1.5rem;
		border-top: 1px solid rgba(var(--accent-rgb), 0.1);
	}

	.action-buttons {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.action-btn {
		padding: 0.875rem 1.25rem;
		border-radius: 8px;
		border: none;
		font-size: 0.95rem;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.2s;
		text-align: left;
	}

	.action-btn.export {
		background: var(--color-info);
		color: white;
	}

	.action-btn.export:hover {
		background: var(--color-info-hover);
		transform: translateY(-2px);
	}

	.action-btn.import {
		background: var(--color-success);
		color: white;
	}

	.action-btn.import:hover {
		background: var(--color-success-hover);
		transform: translateY(-2px);
	}

	.action-btn.danger {
		background: var(--color-danger);
		color: white;
	}

	.action-btn.danger:hover {
		background: var(--color-danger-hover);
		transform: translateY(-2px);
	}

	.admin-help {
		margin: 0 0 0.75rem;
		color: var(--text-secondary);
		font-size: 0.85rem;
	}

	.admin-user-list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.admin-user-item {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.625rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-secondary);
	}

	.admin-user-meta {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}

	.admin-user-name {
		font-weight: 600;
		color: var(--text-primary);
	}

	.admin-role-badge,
	.admin-guest-badge {
		font-size: 0.68rem;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		padding: 0.15rem 0.4rem;
		border-radius: 999px;
		border: 1px solid var(--border);
		color: var(--text-secondary);
	}

	.admin-guest-badge {
		background: rgba(255, 193, 7, 0.12);
		border-color: rgba(255, 193, 7, 0.35);
	}

	.admin-user-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}

	.about-info {
		padding: 1rem;
		background: var(--bg-tertiary);
		border-radius: 8px;
	}

	.about-info p {
		margin: 0.5rem 0;
		color: var(--text-secondary);
	}

	.about-info p strong {
		color: var(--text-primary);
		font-size: 1.1rem;
	}

	.version {
		font-size: 0.85rem;
		color: var(--text-tertiary);
		margin-top: 1rem !important;
	}

	.media-quality-notice {
		margin-top: 1rem;
		padding: 0.9rem;
		border-radius: 8px;
		border: 1px solid rgba(var(--accent-rgb), 0.25);
		background: rgba(var(--accent-rgb), 0.08);
		display: flex;
		flex-direction: column;
		gap: 0.65rem;
	}

	.notice-title {
		font-weight: 700;
		color: var(--text-primary);
	}

	.notice-body {
		font-size: 0.85rem;
		color: var(--text-secondary);
		line-height: 1.4;
	}

	.quality-mode-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.quality-mode-row label {
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.runtime-note {
		margin: 0;
		font-size: 0.78rem;
		color: var(--text-tertiary);
	}

		/* Notification Sound Settings */
		.setting-item-full {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 1rem;
		background: var(--bg-tertiary);
		border-radius: 8px;
	}

	.sound-options {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.font-scale-presets {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.sound-option {
		padding: 0.5rem 1rem;
		background: var(--bg-secondary);
		border: 2px solid transparent;
		border-radius: 6px;
		color: var(--text-primary);
		font-size: 0.875rem;
		cursor: pointer;
		transition: all 0.2s;
	}

	.sound-option:hover {
		background: var(--bg-primary);
		border-color: var(--accent);
	}

	.sound-option.active {
		background: var(--accent);
		color: white;
		border-color: var(--accent);
	}

	.test-sound-btn {
		padding: 0.75rem 1rem;
		background: var(--primary);
		border: none;
		border-radius: 6px;
		color: white;
		font-size: 0.875rem;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.2s;
		align-self: flex-start;
	}

	.test-sound-btn:hover {
		background: var(--primary-hover);
		transform: translateY(-2px);
	}

	.volume-slider {
		width: 100%;
		height: 6px;
		border-radius: 3px;
		background: var(--bg-secondary);
		outline: none;
		-webkit-appearance: none;
		appearance: none;
	}

	.volume-slider::-webkit-slider-thumb {
		-webkit-appearance: none;
		appearance: none;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: var(--accent);
		cursor: pointer;
		transition: all 0.2s;
	}

	.volume-slider::-webkit-slider-thumb:hover {
		transform: scale(1.2);
		background: var(--primary);
	}

	.volume-slider::-moz-range-thumb {
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: var(--accent);
		cursor: pointer;
		border: none;
		transition: all 0.2s;
	}

	.volume-slider::-moz-range-thumb:hover {
		transform: scale(1.2);
		background: var(--primary);
	}

	/* Profile Picture Upload Styles */
	.pfp-upload-section {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 1.5rem;
		padding: 1rem;
		background: var(--bg-tertiary);
		border-radius: 8px;
	}

	.current-pfp {
		flex-shrink: 0;
	}

	.pfp-current-img {
		width: 80px;
		height: 80px;
		border-radius: 50%;
		object-fit: cover;
		border: 3px solid var(--accent);
	}

	.pfp-placeholder {
		width: 80px;
		height: 80px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 2rem;
		font-weight: bold;
		color: white;
	}

	.pfp-upload-form {
		flex: 1;
		display: flex;
		flex-direction: column;
		justify-content: center;
		align-items: flex-start;
		gap: 0.75rem;
		min-height: 80px;
	}

	.pfp-preview {
		text-align: center;
	}

	.pfp-preview img {
		width: 60px;
		height: 60px;
		border-radius: 50%;
		object-fit: cover;
		border: 2px solid var(--accent);
	}

	.pfp-select-btn,
	.pfp-upload-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0.75rem;
		border-radius: 8px;
		border: none;
		font-weight: 600;
		cursor: pointer;
		transition: all 0.2s;
	}

	.pfp-select-btn {
		background: var(--bg-secondary);
		color: var(--text-primary);
	}

	.pfp-select-btn:hover {
		background: var(--bg-primary);
	}

	.pfp-upload-btn {
		background: var(--accent);
		color: white;
	}

	.pfp-upload-btn:hover:not(:disabled) {
		opacity: 0.9;
	}

	.pfp-upload-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.pfp-hint {
		font-size: 0.8rem;
		color: var(--text-secondary);
		margin: 0;
	}

	/* Banner Upload Styles */
	.banner-upload-section {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		padding: 1rem;
		background: var(--bg-tertiary);
		border-radius: 8px;
	}

	.current-banner {
		width: 100%;
		max-width: 600px;
	}

	.current-banner img {
		width: 100%;
		height: auto;
		display: block;
		border-radius: 8px;
		border: 2px solid var(--border);
	}

	.banner-preview {
		width: 100%;
		max-width: 600px;
	}

	.banner-preview img {
		width: 100%;
		height: auto;
		display: block;
		border-radius: 8px;
		border: 2px solid var(--accent);
	}

	.banner-label {
		font-size: 0.75rem;
		color: var(--text-secondary);
		margin-top: 0.25rem;
		margin-bottom: 0;
	}

	.banner-upload-form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	/* Status Selector Styles */
	.status-selector {
		display: flex;
		gap: 0.75rem;
		padding: 1rem;
		background: var(--bg-tertiary);
		border-radius: 8px;
		flex-wrap: wrap;
	}

	.status-btn {
		flex: 1;
		min-width: 100px;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		padding: 0.75rem 1rem;
		background: var(--bg-secondary);
		border: 2px solid transparent;
		border-radius: 8px;
		color: var(--text-primary);
		font-weight: 500;
		cursor: pointer;
		transition: all 0.2s;
	}

	.status-btn:hover {
		background: var(--bg-primary);
		border-color: var(--accent);
	}

	.status-btn.active {
		background: var(--accent);
		color: white;
		border-color: var(--accent);
	}

	.status-dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		display: inline-block;
	}

	/* Emoji Upload Styles */
	.emoji-upload-form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		padding: 1rem;
		background: var(--bg-tertiary);
		border-radius: 8px;
		margin-bottom: 1.5rem;
	}

	.emoji-preview {
		text-align: center;
		padding: 1rem;
		background: var(--bg-primary);
		border-radius: 8px;
	}

	.emoji-preview img {
		max-width: 128px;
		max-height: 128px;
		object-fit: contain;
	}

	.emoji-select-btn,
	.emoji-upload-btn {
		padding: 0.75rem;
		border-radius: 8px;
		border: none;
		font-weight: 600;
		cursor: pointer;
		transition: all 0.2s;
	}

	.emoji-select-btn {
		background: var(--bg-secondary);
		color: var(--text-primary);
	}

	.emoji-select-btn:hover {
		background: var(--bg-primary);
	}

	.emoji-upload-btn {
		background: var(--accent);
		color: white;
	}

	.emoji-upload-btn:hover:not(:disabled) {
		opacity: 0.9;
		transform: translateY(-1px);
	}

	.emoji-upload-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.emoji-name-input,
	.emoji-category-select {
		padding: 0.75rem;
		border-radius: 8px;
		border: 1px solid var(--border);
		background: var(--bg-primary);
		color: var(--text-primary);
		font-size: 1rem;
	}

	.emoji-hint {
		font-size: 0.875rem;
		color: var(--text-secondary);
		text-align: center;
		margin: 0;
	}

	.emoji-list h4 {
		margin: 0 0 1rem 0;
		color: var(--text-primary);
	}

	.emoji-grid-list {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
		gap: 0.75rem;
	}

	.emoji-item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.75rem;
		background: var(--bg-tertiary);
		border-radius: 8px;
		position: relative;
	}

	.emoji-item-meta {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		min-width: 0;
	}

	.emoji-thumb {
		width: 32px;
		height: 32px;
		object-fit: contain;
		flex-shrink: 0;
	}

	.emoji-item-name {
		font-size: 0.875rem;
		font-family: monospace;
		color: var(--text-primary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.emoji-item-sub {
		font-size: 0.72rem;
		color: var(--text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.emoji-delete-btn {
		background: none;
		border: none;
		font-size: 1.1rem;
		cursor: pointer;
		padding: 0.25rem;
		opacity: 0.6;
		transition: opacity 0.2s;
	}

	.emoji-delete-btn:hover {
		opacity: 1;
	}

	/* Bulk Upload Styles */
	.emoji-upload-form.bulk {
		background: var(--bg-secondary);
		border: 2px dashed var(--border);
	}

	.emoji-upload-form.bulk h4 {
		margin: 0 0 1rem 0;
		color: var(--text-primary);
	}

	.bulk-emoji-list {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		margin-top: 1rem;
	}

	.bulk-count {
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--text-primary);
		margin: 0;
	}

	.bulk-emoji-item {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.75rem;
		padding: 0.75rem;
		background: var(--bg-tertiary);
		border-radius: 8px;
	}

	.bulk-preview {
		width: 48px;
		height: 48px;
		object-fit: contain;
		flex-shrink: 0;
		background: var(--bg-primary);
		border-radius: 4px;
	}

	.bulk-name-input {
		flex: 1 1 180px;
		padding: 0.5rem;
		border-radius: 4px;
		border: 1px solid var(--border);
		background: var(--bg-primary);
		color: var(--text-primary);
		font-size: 0.875rem;
		font-family: monospace;
	}

	.bulk-remove-btn {
		background: none;
		border: none;
		color: var(--text-secondary);
		font-size: 1.25rem;
		cursor: pointer;
		padding: 0.25rem 0.5rem;
		opacity: 0.6;
		transition: opacity 0.2s;
	}

	.bulk-remove-btn:hover {
		opacity: 1;
		color: var(--color-danger);
	}

	@media (max-width: 768px) {
		.modal-overlay {
			align-items: flex-end;
		}

		.modal-content {
			width: 100%;
			max-width: 100%;
			height: calc(100dvh - env(safe-area-inset-top, 0px));
			max-height: calc(100dvh - env(safe-area-inset-top, 0px));
			border-radius: 14px 14px 0 0;
		}

		.settings-layout {
			flex-direction: column;
		}

		.settings-tabs {
			width: 100%;
			position: sticky;
			top: 0;
			flex-direction: row;
			overflow-x: auto;
			-webkit-overflow-scrolling: touch;
			border-right: none;
			border-bottom: 1px solid var(--border);
			padding: 0.375rem;
			gap: 0.25rem;
			z-index: 1;
			background: var(--bg-tertiary);
		}

		.settings-tabs-spacer {
			display: none;
		}

		.settings-tab {
			border-left: none;
			border-bottom: 3px solid transparent;
			border-radius: 6px 6px 0 0;
			padding: 0.5rem 0.75rem;
			white-space: nowrap;
			font-size: 0.8rem;
			text-align: center;
		}

		.settings-tab.active {
			border-left-color: transparent;
			border-bottom-color: var(--accent);
		}

		.settings-tab.logout-tab {
			margin-top: 0;
			margin-left: auto;
		}

		.settings-content {
			padding: 1rem;
			padding-bottom: calc(1rem + env(safe-area-inset-bottom, 0px));
		}
	}
</style>

