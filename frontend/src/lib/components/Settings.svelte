<script lang="ts">
	import { browser } from '$app/environment';
	import { createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
	import { get } from 'svelte/store';
	import {
		_ as t,
		availableLocales,
		currentLocale,
		setAppLocale,
		learningModeEnabled,
		learningTargetPercent,
		setLearningModeEnabled,
		setLearningTargetPercent
	} from '$lib/i18n';
	import {
		channelMessages,
		users,
		currentUser,
		emojis,
		updateProfile,
		assignRole,
		removeUserRole,
		roleDefinitions,
		channels
	} from '$lib/socket';
	import type { Emoji, Message } from '$lib/socket';
	import { chatStorage } from '$lib/storage';
	import StorageSettings from './StorageSettings.svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import PaymentConnectionsModal from './PaymentConnectionsModal.svelte';
	import PaymentHistoryModal from './PaymentHistoryModal.svelte';
	import ServerDonationModal from './ServerDonationModal.svelte';
	import PaymentSheet from './PaymentSheet.svelte';
	import LineDm from './plugins/LineDm.svelte';
	import {
		getDefaultCustomSynthRingtonePreset,
		playCallRingtone,
		playNotificationSound,
		sanitizeCustomSynthRingtonePreset,
		stopCallRingtone,
		type CustomSynthRingtonePreset,
		type CustomSynthWaveform
	} from '$lib/notifications';
	import { getSocket } from '$lib/socket';
	import { subscribePaymentRealtimeEvent } from '$lib/paymentRealtime';
	import {
		formatMinorAmount as formatPaymentMinorAmount,
		minorToMajorInput as minorAmountToInput,
		parseMajorAmountInput as parsePaymentMajorAmount
	} from '$lib/paymentAmounts';
	import { getServerUrl } from '$lib/serverUrl';
	import AvatarEditor from './AvatarEditor.svelte'; // Import the AvatarEditor
	import {
		approveAdminRelay,
		deleteAdminRelay,
		createAdminOfflineDonation,
		adminClearUserLoginLockout,
		getAdminCommunityNodeAccessPolicy,
		getAdminCommunityNodeAnnouncementsPolicy,
		getAdminPaymentDonationConfig,
		listAdminPaymentDonationAudit,
		listAdminRelays,
		listAdminOfflineDonations,
		listPaymentProviders,
		adminResetUserPassword,
		changePassword,
		getAdminUploadLimits,
		refundAdminPaymentDonation,
		saveAdminCommunityNodeAccessPolicy,
		saveAdminPaymentDonationConfig,
		saveAdminCommunityNodeAnnouncementsPolicy,
		getUserSettings,
		saveAdminUploadLimits,
		saveUserSettings,
		voidAdminOfflineDonation,
		type CommunityNodeAccessPolicy,
		type CommunityNodeAllowedUser,
		type PaymentDonationConfig,
		type PaymentDonationLedgerEntry,
		type OfflineDonationLedgerEntry,
		type AdminRelayNode,
		type PaymentMethodCapability,
		type PaymentProviderCapability,
		type CommunityNodeAnnouncementsPolicy,
		type UploadRoleTier,
		type UploadLimitConfig
	} from '$lib/api';
	import {
		DESKTOP_HELPER_PROFILE_KEY,
		desktopHelperState,
		syncDesktopHelperService,
		type DesktopHelperProfileMode
	} from '$lib/desktopHelper';
	import {
		directionsAssistSettings,
		requestDirectionsGpsPermission,
		setDirectionsGpsEnabled
	} from '$lib/directionsAssist';
	import {
		getBusinessSyncMode,
		setBusinessSyncMode,
		sync as syncBusinessData,
		hasPendingRemoteBusinessUpdate
	} from '$lib/business/sync';

	// Theme system
	import { themeStore, currentTheme } from '$lib/theme/themeStore';
	import { THEMES } from '$lib/theme/themes';
	import { saveThemePreferences } from '$lib/theme/themeApi';
	import { saveThemeToLocalStorage } from '$lib/theme/themeManager';
	import ThemeCustomizer from './ThemeCustomizer.svelte';
	import UsernameFontCustomizer from './UsernameFontCustomizer.svelte';
	import UniformFontMode from './UniformFontMode.svelte';
	import { layoutStore } from '$lib/layoutStore';
	import {
		applyHomeExperienceMode,
		getStoredHomeExperienceMode,
		setStoredHomeExperienceMode,
		type HomeExperienceMode
	} from '$lib/homeExperience';
	import {
		getAudioCaptureConstraints,
		getBoosterRelayEffectiveMode,
		getBoosterRelayRequestedMode,
		isTauriRuntime,
		loadEffectiveMediaSettingsSnapshot,
		setAudioProcessingMode,
		setCallMuteBehavior,
		setCallRecordingStemMode,
		setCallTransportMode,
		setMediaQualityMode,
		setScreenShareQualityPreset,
		setScreenShareBitrateKbps,
		setSpatialAudioDistanceScale,
		setSpatialAudioEnabled,
		setSpatialAudioMasterStrength,
		setSpatialAudioMode,
		setSpatialAudioQuickToggleVisible,
		setSpatialAudioWarningMuted,
		setSrtGatewayEnabled,
		getPreferredMicDeviceId,
		setPreferredMicDeviceId,
		getPreferredCameraDeviceId,
		setPreferredCameraDeviceId,
		type AudioProcessingMode,
		type BoosterRelayMode,
		type CallMuteBehavior,
		type CallRecordingStemMode,
		type CallTransportMode,
		type MediaQualityMode,
		type ServerMediaRuntimeResponse,
		type ScreenShareQualityPreset,
		type SpatialAudioMode
	} from '$lib/mediaRuntime';
	import {
		applyCurrentAudioProcessingToLocalTrack,
		audioProcessingRuntimeStatus,
		callTransportState,
		clearAudioPerformanceFallbackOverride,
		refreshLocalAudioMuteState,
		refreshSpatialAudioRuntime,
		spatialAudioDiagnostics,
		spatialAudioRuntimeStatus
	} from '$lib/calling';
	import { refreshCallRecordingMix } from '$lib/callRecording';
	import {
		getStoredAccessibilitySettings,
		updateAccessibilitySettings,
		type RoleColorMode,
		type ChatAvatarMode,
		type MessageDensity,
		type DeletionCountdownMode
	} from '$lib/accessibility';
	import {
		getStoredAnimationPassSettings,
		updateAnimationPassSettings,
		type AnimationPassPreset,
		type AnimationPassLevel
	} from '$lib/animationPass';
	import { getTauriPlatform } from '$lib/tauri-platform';
	import {
		isExperimentalStdbCallEnabled,
		setExperimentalStdbCallEnabled
	} from '$lib/experimentalStdbCalls';
	import type { VideoCompressionPresetId } from '$lib/video/videoCompressor';
	import {
		getDefaultVideoCompressionPreset,
		getVideoCompressionPresetOptions,
		getVideoCompressionRuntimeProfile,
		isVideoCompressionEnabled,
		setDefaultVideoCompressionPreset,
		setVideoCompressionEnabled,
		type VideoCompressionPresetOption,
		type VideoCompressionRuntime
	} from '$lib/video/videoCompressionSettings';
	import {
		addChatAlias,
		chatAliasesStore,
		chatFilterStore,
		customQuoteSettingsStore,
		removeChatAlias,
		resetCustomQuoteTemplate,
		setChatFilterSettings,
		setCustomQuoteTemplate,
		updateChatAlias,
		type ChatAliasEntry,
		type ChatFilterMode
	} from '$lib/chatEnhancements';
	import {
		composerEnhancementSettingsStore,
		setCharCounterEnabled,
		setSpellCheckEnabled,
		setSplitLargeMessagesEnabled,
		setSplitLargeMessagesChunkSize,
		setWriteUpperCaseEnabled
	} from '$lib/composerEnhancements';
	import {
		displayEnhancementSettingsStore,
		clearMutedChannelIds,
		setBetterSearchPageEnabled,
		setGoogleSearchReplaceEnabled,
		setBetterFriendListEnabled,
		setBetterNsfwTagEnabled,
		setClickableMentionsEnabled,
		setCustomStatusPresetsEnabled,
		setEmojiStatisticsEnabled,
		setFriendNotificationsEnabled,
		setFriendNotificationsTrackedOnly,
		setHideMutedCategoriesEnabled,
		setLastMessageDateEnabled,
		setLocalNicknamesEnabled,
		setMessageUtilitiesEnabled,
		setPersonalPinsEnabled,
		setQuickMentionEnabled,
		setReadAllNotificationsButtonEnabled,
		setRemoveNicknamesEnabled,
		setRevealAllSpoilersEnabled,
		setRevealAllSpoilersMinRole,
		setServerCounterEnabled,
		setShowConnectionsEnabled,
		setSpotifyControlsEnabled,
		setStaffTagEnabled,
		setTimestampDisplayMode,
		setTopRoleEverywhereEnabled,
		setUserNotesEnabled,
		type RevealAllSpoilersMinRole,
		type TimestampDisplayMode
	} from '$lib/displayEnhancements';
	import {
		clearAllTrackedPersonStatusAlerts,
		trackedStatusAlertPersonCountStore
	} from '$lib/peopleTracker';
	import {
		exportUnicodeEmojiPreferences,
		importUnicodeEmojiPreferences,
		resetUnicodeEmojiTelemetry,
		setUnicodeEmojiConversionEnabled,
		setUnicodeEmojiDefaultSourceEnabled,
		setUnicodeEmojiOpenmojiSourceEnabled,
		unicodeEmojiTelemetryStore,
		unicodeEmojiSettingsStore
	} from '$lib/unicodeEmojis';
	import {
		gifCaptionerSettingsStore,
		setGifCaptionerCaptionStyle,
		setGifCaptionerDedicatedCaptionFieldEnabled,
		setGifCaptionerEnabled,
		type GifCaptionStylePreset
	} from '$lib/gifCaptionerSettings';
	import {
		setZipPreviewEnabled,
		setZipPreviewInlinePreviewEnabled,
		zipPreviewSettingsStore
	} from '$lib/zip/zipPreviewSettings';
	import {
		getReverseImageSearchProvider,
		setReverseImageSearchProvider,
		type ReverseImageSearchProvider
	} from '$lib/imageUtilities';
	import {
		getCustomSearchEngineTemplate,
		getSearchEngineProvider,
		setCustomSearchEngineTemplate,
		setSearchEngineProvider,
		type SearchEngineProvider
	} from '$lib/searchEngineJump';
	import { clearAllLocalNicknames, localNicknamesStore } from '$lib/localNicknames';
	import {
		defaultLocalWabiAccountStore,
		getLocalWabiAccountDisplayLabel,
		getLocalWabiAccountKey,
		getSuggestedLocalWabiImportSourceAccount,
		localWabiAccountListStore,
		markLocalWabiImportPromptHandled,
		setDefaultLocalWabiAccount,
		type LocalWabiAccountRecord
	} from '$lib/localWabiAccounts';
	import {
		applyLocalWabiProfileImport,
		getLocalWabiProfileImportPreview,
		type LocalWabiProfileImportPreview
	} from '$lib/localWabiProfileImport';
	import { uploadProfilePictureFile } from '$lib/profilePictureUpload';
	import {
		MAX_CUSTOM_QUICK_REACTION_EMOJIS,
		addQuickReactionCustomEmojiId,
		clearQuickReactionCustomEmojiIds,
		quickReactionSettingsStore,
		removeQuickReactionCustomEmojiId,
		setQuickReactionsEnabled
	} from '$lib/quickReactions';
	import {
		getQuickReactionClickShare,
		quickReactionTelemetryStore,
		resetQuickReactionTelemetry
	} from '$lib/quickReactionTelemetry';
	import { clearPinnedDms, pinnedDmIdsStore } from '$lib/pinDms';
	import { clearAllPersonalPins, personalPinsStore } from '$lib/personalPins';
	import { clearAuthSession, getAuthToken } from '$lib/authSession';
	import {
		MAX_CUSTOM_STATUS_PRESETS,
		addCustomStatusPreset,
		customStatusPresetsStore,
		removeCustomStatusPreset,
		resetCustomStatusPresetsToDefaults,
		setActiveCustomStatusPreset,
		type CustomStatusPresetPresence
	} from '$lib/customStatusPresets';
	import {
		setTimedThemeModeDarkThemeId,
		setTimedThemeModeDayStartHour,
		setTimedThemeModeEnabled,
		setTimedThemeModeLightThemeId,
		setTimedThemeModeNightStartHour,
		timedThemeModeSettingsStore
	} from '$lib/timedThemeMode';

	const dispatch = createEventDispatcher();
	const MB = 1024 * 1024;
	const GIF_CAPTIONER_MAX_CAPTION_LENGTH = 280;

	export let isOpen = false;
	export let requestedPaymentSurface: 'connections' | null = null;
	export let requestedPasswordChangeRequest = 0;
	type SettingsTab = 'profile' | 'audio' | 'notifications' | 'accessibility' | 'appearance' | 'server' | 'addons' | 'emojis' | 'storage' | 'admin' | 'about';
	type CallRingtoneMode = 'classic-bell' | 'soft-chime' | 'pulse' | 'custom-synth' | 'custom-audio';
	const CALL_RINGTONE_OPTIONS: Array<{ value: CallRingtoneMode; label: string }> = [
		{ value: 'classic-bell', label: 'Classic Bell' },
		{ value: 'soft-chime', label: 'Soft Chime' },
		{ value: 'pulse', label: 'Pulse' },
		{ value: 'custom-synth', label: 'Custom Synth' },
		{ value: 'custom-audio', label: 'Custom Audio' }
	];
	const CUSTOM_SYNTH_WAVEFORM_OPTIONS: Array<{ value: CustomSynthWaveform; label: string }> = [
		{ value: 'sine', label: 'Sine' },
		{ value: 'triangle', label: 'Triangle' },
		{ value: 'square', label: 'Square' },
		{ value: 'sawtooth', label: 'Sawtooth' }
	];
	let activeSettingsTab: SettingsTab = 'profile';
	let lastHandledRequestedPasswordChangeRequest = 0;

	let soundEnabled = true;
	let notificationsEnabled = true;
	let micEnabled = true;
	let cameraEnabled = true;
	let suppressEveryoneHereMentions = false;
	let suppressRoleMentions = false;
	let notificationPreviewEnabled = false;
	let notificationSound = '/sounds/ProjectSound.ogg';
	let notificationSoundLabel = 'ProjectSound.ogg';
	let notificationVolume = 0.5;
	let callRingtoneMode: CallRingtoneMode = 'classic-bell';
	let callRingtoneLabel = 'Classic Bell';
	let callRingtoneVolume = 0.65;
	let callRingtoneCustomSynth: CustomSynthRingtonePreset = getDefaultCustomSynthRingtonePreset();
	let mediaQualityMode: MediaQualityMode = 'web-baseline';
	let audioProcessingMode: AudioProcessingMode = 'auto';
	let callTransportMode: CallTransportMode = 'auto';
	let callMuteBehavior: CallMuteBehavior = 'mute-local-input';
	let callRecordingStemMode: CallRecordingStemMode = 'mixed-only';
	let srtGatewayEnabled = false;
	let screenShareQualityPreset: ScreenShareQualityPreset = 'auto';
	let screenShareBitrateKbps = 0;
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
	let animationPassEnabled = true;
	let animationPassPreset: AnimationPassPreset = 'slip';
	let animationPassLevel: AnimationPassLevel = 'balanced';
	let animationPassDurationMultiplier = 1;
	let roleColorMode: RoleColorMode = 'full';
	let ownMessagesOnRight = false;
	let homeExperienceMode: HomeExperienceMode = 'community';
	let chatAvatarMode: ChatAvatarMode = 'all';
	let tabShadeStrength = 0.06;
	let appChromeOpacity = 1;
	let videoCompressionEnabled = true;
	let videoCompressionRuntime: VideoCompressionRuntime = 'desktop';
	let videoCompressionRuntimeLabel = 'Desktop';
	let videoCompressionPresetOptions: VideoCompressionPresetOption[] =
		getVideoCompressionPresetOptions('desktop');
	let selectedVideoCompressionPresetOption: VideoCompressionPresetOption | null = null;
	let defaultVideoCompressionPreset: VideoCompressionPresetId = 'balanced_720p';
	let messageDensity: MessageDensity = 'cozy';
	let chatFontScale = 1;
	let deletionCountdownMode: DeletionCountdownMode = 'static';
	let clickableSendEnabled = true;
	let localAppRuntime = false;
	let desktopLocalAppRuntime = false;
	let experimentalStdbCallsEnabled = false;
	let micTestStream: MediaStream | null = null;
	let micTestRecorder: MediaRecorder | null = null;
	let micTestAudioContext: AudioContext | null = null;
	let audioInputDevices: MediaDeviceInfo[] = [];
	let videoInputDevices: MediaDeviceInfo[] = [];
	let selectedMicDeviceId = '';
	let selectedCameraDeviceId = '';
	let mediaRuntimeSnapshot: ServerMediaRuntimeResponse | null = null;
	let boosterRelayRequestedMode: BoosterRelayMode = 'off';
	let boosterRelayEffectiveMode: BoosterRelayMode = 'off';
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
	let selectedLocale = 'en';
	let uiLearningModeEnabled = false;
	let uiLearningTargetPercent = 100;
	let addonsImportInput: HTMLInputElement;
	let addonsPackageInput: HTMLInputElement;
	let notificationSoundInput: HTMLInputElement;
	let callRingtoneInput: HTMLInputElement;
	let callRingtoneSynthImportInput: HTMLInputElement;
	let callRingtonePreviewTimeout: number | null = null;
	let callRingtoneSynthEditorExpanded = false;
	type AddonRuntimeSide = 'frontend' | 'backend';
	interface DetectedAddon {
		id: string;
		name: string;
		version: string;
		source: string;
		side: AddonRuntimeSide;
	}
	interface PluginApiRecord {
		id?: string;
		name?: string;
		version?: string;
		signerKeyId?: string | null;
		frontendEntry?: string | null;
		backendEntry?: string | null;
		hasFrontend?: boolean;
		hasBackend?: boolean;
	}
	let frontendAddons: DetectedAddon[] = [];
	let backendAddons: DetectedAddon[] = [];
	let addonsLastDetectedAt = '';
	let addonsLoading = false;
	let addonInstallLoading = false;
	let addonInstallStatus = '';
	let addonsImportPreview: { importedAt?: string; frontend?: unknown[]; backend?: unknown[] } | null = null;
	const frontendAddonModules = import.meta.glob('./plugins/*.svelte');
	const TRANSLATOR_SETTINGS_KEY = 'addon.translator_assist.settings';
	type TranslatorModelId = 'libretranslate-local' | 'libretranslate-public';
	const TRANSLATOR_MODEL_OPTIONS: Array<{ id: TranslatorModelId; label: string; providerUrl: string }> = [
		{ id: 'libretranslate-local', label: 'LibreTranslate (Local)', providerUrl: 'http://127.0.0.1:5000/translate' },
		{ id: 'libretranslate-public', label: 'LibreTranslate (Public)', providerUrl: 'https://libretranslate.com/translate' }
	];
	let translatorModel: TranslatorModelId = 'libretranslate-local';
	let translatorTargetLang = 'en';
	let translatorSettingsSavedAt = '';
	let translatorAddonDetected = false;
	let reverseImageSearchProvider: ReverseImageSearchProvider = 'google_lens';
	let searchEngineProvider: SearchEngineProvider = 'brave';
	let searchEngineCustomTemplate = 'https://search.brave.com/search?q={query}';
	const SEARCH_ENGINE_CUSTOM_TEMPLATE_PLACEHOLDER = 'https://example.com/search?q={query}';
	const SEARCH_ENGINE_CUSTOM_QUERY_TOKEN = '{query}';
	let spellCheckEnabled = true;
	let charCounterEnabled = true;
	let splitLargeMessagesEnabled = false;
	let splitLargeMessagesChunkSize = 2000;
	let splitLargeMessagesInputMaxLength = 20000;
	let writeUpperCaseEnabled = false;
	let clickableMentionsEnabled = true;
	let timestampDisplayMode: TimestampDisplayMode = 'compact';
	let revealAllSpoilersEnabled = true;
	let revealAllSpoilersMinRole: RevealAllSpoilersMinRole = 'member';
	let betterSearchPageEnabled = true;
	let googleSearchReplaceEnabled = true;
	let hideMutedCategoriesEnabled = false;
	let readAllNotificationsButtonEnabled = true;
	let spotifyControlsEnabled = true;
	let localNicknamesEnabled = true;
	let serverCounterEnabled = true;
	let betterNsfwTagEnabled = true;
	let customStatusPresetsEnabled = true;
	let quickMentionEnabled = true;
	let personalPinsEnabled = true;
	let lastMessageDateEnabled = true;
	let showConnectionsEnabled = true;
	let userNotesEnabled = true;
	let friendNotificationsEnabled = false;
	let friendNotificationsTrackedOnly = true;
	let messageUtilitiesEnabled = true;
	let betterFriendListEnabled = true;
	let emojiStatisticsEnabled = true;
	let removeNicknamesEnabled = false;
	let staffTagEnabled = true;
	let topRoleEverywhereEnabled = true;
	let timedThemeModeEnabled = false;
	let timedThemeDayStartHour = 7;
	let timedThemeNightStartHour = 19;
	let timedThemeLightThemeId = 'light';
	let timedThemeDarkThemeId = 'dark';
	let customStatusPresetLabelDraft = '';
	let customStatusPresetNoteDraft = '';
	let customStatusPresetPresenceDraft: CustomStatusPresetPresence = 'active';
	let customStatusPresetsStatus = '';
	let unicodeEmojisEnabled = false;
	let unicodeConvertDefaultEnabled = true;
	let unicodeConvertOpenmojiEnabled = true;
	let unicodeEmojisPrefsStatus = '';
	let gifCaptionerEnabled = true;
	let gifCaptionerDedicatedFieldEnabled = false;
	let gifCaptionerCaptionStyle: GifCaptionStylePreset = 'plain';
	let zipPreviewEnabled = true;
	let zipPreviewInlineEnabled = true;
	let quickReactionsEnabled = true;
	let quickReactionCustomEmojiIdDraft = '';
	let quickReactionSettingsStatus = '';
	let quickReactionClickShare: number | null = null;
	let quickReactionCustomEmojiEntries: Emoji[] = [];
	let emojiStatsCategories: Array<{ category: string; count: number }> = [];
	let mutedChannelCount = 0;
	let localNicknameCount = 0;
	let pinnedDmConversationCount = 0;
	let chatAliasTriggerDraft = '';
	let chatAliasReplacementDraft = '';
	let quoteTemplateDraft = '';
	let personalPinCount = 0;
	type AddonSectionId = 'dms' | 'chat' | 'search' | 'navigation' | 'identity' | 'notifications' | 'media' | 'appearance' | 'utilities';
	interface LocalAddonControlMeta {
		label: string;
		section: AddonSectionId;
		terms: string[];
		isAvailable?: () => boolean;
	}
	const ADDON_SECTION_ORDER: AddonSectionId[] = ['dms', 'chat', 'search', 'navigation', 'identity', 'notifications', 'media', 'appearance', 'utilities'];
	const ADDON_SECTION_LABELS: Record<AddonSectionId, string> = {
		dms: 'DMs',
		chat: 'Chat',
		search: 'Search',
		navigation: 'Navigation',
		identity: 'Identity',
		notifications: 'Notifications',
		media: 'Media',
		appearance: 'Appearance',
		utilities: 'Utilities'
	};
	const LOCAL_ADDON_CONTROL_META: Record<string, LocalAddonControlMeta> = {
		translator_addon: {
			label: 'Translator Assist',
			section: 'utilities',
			terms: ['translate', 'translation', 'language', 'libretranslate'],
			isAvailable: () => translatorAddonDetected
		},
		line_dm: {
			label: 'LINE DM',
			section: 'dms',
			terms: ['line', 'direct message', 'wallpaper', 'background', 'preset']
		},
		chat_aliases: {
			label: 'ChatAliases',
			section: 'utilities',
			terms: ['alias', 'slash', 'command', 'replacement']
		},
		chat_filter: {
			label: 'ChatFilter',
			section: 'utilities',
			terms: ['filter', 'blocked terms', 'censor', 'hide']
		},
		custom_quoter: {
			label: 'CustomQuoter',
			section: 'utilities',
			terms: ['quote', 'template', 'copy quote', 'format']
		},
		image_utilities: {
			label: 'ImageUtilities',
			section: 'media',
			terms: ['image', 'reverse image search', 'lens', 'bing', 'tineye', 'yandex']
		},
		spellcheck: {
			label: 'SpellCheck',
			section: 'chat',
			terms: ['spellcheck', 'spelling', 'composer']
		},
		char_counter: {
			label: 'CharCounter',
			section: 'chat',
			terms: ['character count', 'counter', 'composer']
		},
		split_large_messages: {
			label: 'SplitLargeMessages',
			section: 'chat',
			terms: ['split', 'long messages', 'chunk size', 'composer']
		},
		write_upper_case: {
			label: 'WriteUpperCase',
			section: 'chat',
			terms: ['capitalize', 'sentence case', 'auto-capitalization']
		},
		clickable_mentions: {
			label: 'ClickableMentions',
			section: 'chat',
			terms: ['mentions', 'usernames', 'popout']
		},
		complete_timestamps: {
			label: 'CompleteTimestamps',
			section: 'chat',
			terms: ['timestamp', 'date', 'time']
		},
		reveal_all_spoilers: {
			label: 'RevealAllSpoilers',
			section: 'chat',
			terms: ['spoilers', 'reveal', 'moderation']
		},
		better_search_page: {
			label: 'BetterSearchPage',
			section: 'search',
			terms: ['search results', 'sticky controls', 'matches']
		},
		google_search_replace: {
			label: 'GoogleSearchReplace',
			section: 'search',
			terms: ['search on web', 'browser search', 'search engine', 'brave', 'duckduckgo', 'bing', 'google']
		},
		hide_muted_categories: {
			label: 'HideMutedCategories',
			section: 'navigation',
			terms: ['muted channels', 'sidebar', 'channel list']
		},
		read_all_notifications_button: {
			label: 'ReadAllNotificationsButton',
			section: 'navigation',
			terms: ['clear unread', 'notifications', 'sidebar']
		},
		server_counter: {
			label: 'ServerCounter',
			section: 'navigation',
			terms: ['workspace count', 'channel counter', 'sidebar']
		},
		better_nsfw_tag: {
			label: 'BetterNsfwTag',
			section: 'navigation',
			terms: ['nsfw', 'warning tag', 'channel list']
		},
		custom_status_presets: {
			label: 'CustomStatusPresets',
			section: 'identity',
			terms: ['presence', 'status', 'preset', 'sidebar']
		},
		message_utilities: {
			label: 'MessageUtilities',
			section: 'chat',
			terms: ['message actions', 'hover actions', 'quick tools']
		},
		quick_mention: {
			label: 'QuickMention',
			section: 'chat',
			terms: ['mention', 'message actions', 'quick action']
		},
		personal_pins: {
			label: 'PersonalPins',
			section: 'chat',
			terms: ['pins', 'messages', 'local pins']
		},
		last_message_date: {
			label: 'LastMessageDate',
			section: 'identity',
			terms: ['last message', 'timestamp', 'popout']
		},
		show_connections: {
			label: 'ShowConnections',
			section: 'identity',
			terms: ['profile', 'connections', 'links', 'handles']
		},
		user_notes: {
			label: 'UserNotes',
			section: 'identity',
			terms: ['notes', 'private notes', 'profile']
		},
		friend_notifications: {
			label: 'FriendNotifications',
			section: 'notifications',
			terms: ['presence alerts', 'desktop notifications', 'friends']
		},
		better_friend_list: {
			label: 'BetterFriendList',
			section: 'navigation',
			terms: ['friend list', 'sort', 'filter', 'right panel']
		},
		emoji_statistics: {
			label: 'EmojiStatistics',
			section: 'media',
			terms: ['emoji', 'inventory', 'statistics', 'categories']
		},
		remove_nicknames: {
			label: 'RemoveNicknames',
			section: 'identity',
			terms: ['nicknames', 'account names', 'display names']
		},
		local_nicknames: {
			label: 'LocalNicknames',
			section: 'identity',
			terms: ['nicknames', 'private nicknames', 'display names']
		},
		spotify_controls: {
			label: 'SpotifyControls',
			section: 'media',
			terms: ['spotify', 'music', 'track', 'playlist']
		},
		staff_tag: {
			label: 'StaffTag',
			section: 'identity',
			terms: ['staff', 'moderator', 'admin', 'role']
		},
		top_role_everywhere: {
			label: 'TopRoleEverywhere',
			section: 'identity',
			terms: ['top role', 'badge', 'role']
		},
		timed_theme_mode: {
			label: 'TimedLightDarkMode',
			section: 'appearance',
			terms: ['theme', 'light mode', 'dark mode', 'schedule']
		},
		unicode_emojis: {
			label: 'UnicodeEmojis',
			section: 'chat',
			terms: ['emoji', 'unicode', 'shortcode', 'openmoji']
		},
		gif_captioner: {
			label: 'GifCaptioner',
			section: 'media',
			terms: ['gif', 'caption', 'media']
		},
		zip_preview: {
			label: 'ZipPreview',
			section: 'media',
			terms: ['zip', 'archive', 'preview', 'attachments']
		},
		more_quick_reacts: {
			label: 'MoreQuickReacts',
			section: 'media',
			terms: ['quick reacts', 'reactions', 'emoji shortcuts']
		},
		pin_dms: {
			label: 'PinDMs',
			section: 'dms',
			terms: ['pin dms', 'pinned conversations', 'direct messages']
		}
	};
	let addonSearchQuery = '';
	let addonSearchTokens: string[] = [];
	let activeAddonSection: AddonSectionId | null = 'dms';
	let visibleLocalAddonControlCount = 0;
	let availableLocalAddonControlCount = 0;

	function tokenizeAddonSearchQuery(value: string): string[] {
		return value
			.toLowerCase()
			.trim()
			.split(/\s+/)
			.filter(Boolean);
	}

	function localAddonControlAvailable(controlId: string): boolean {
		const meta = LOCAL_ADDON_CONTROL_META[controlId];
		if (!meta) return false;
		return meta.isAvailable ? meta.isAvailable() : true;
	}

	function localAddonControlMatches(controlId: string): boolean {
		const meta = LOCAL_ADDON_CONTROL_META[controlId];
		if (!meta || !localAddonControlAvailable(controlId)) return false;
		if (addonSearchTokens.length === 0) return true;
		const haystack = `${meta.label} ${ADDON_SECTION_LABELS[meta.section]} ${meta.terms.join(' ')}`.toLowerCase();
		return addonSearchTokens.every((token) => haystack.includes(token));
	}

	function addonSectionHasMatches(section: AddonSectionId): boolean {
		return Object.entries(LOCAL_ADDON_CONTROL_META).some(([controlId, meta]) => meta.section === section && localAddonControlMatches(controlId));
	}

	function addonSectionMatchCount(section: AddonSectionId): number {
		return Object.entries(LOCAL_ADDON_CONTROL_META).filter(([controlId, meta]) => meta.section === section && localAddonControlMatches(controlId)).length;
	}

	function isAddonSectionOpen(section: AddonSectionId): boolean {
		if (addonSearchTokens.length > 0) {
			return addonSectionHasMatches(section);
		}
		return activeAddonSection === section;
	}

	function toggleAddonSection(section: AddonSectionId): void {
		activeAddonSection = activeAddonSection === section ? null : section;
	}

	function clearAddonSearchQuery(): void {
		addonSearchQuery = '';
	}

	$: addonSearchTokens = tokenizeAddonSearchQuery(addonSearchQuery);
	$: availableLocalAddonControlCount = Object.keys(LOCAL_ADDON_CONTROL_META).filter((controlId) => localAddonControlAvailable(controlId)).length;
	$: visibleLocalAddonControlCount = Object.keys(LOCAL_ADDON_CONTROL_META).filter((controlId) => localAddonControlMatches(controlId)).length;

	function resolveVideoCompressionRuntimeScope(): VideoCompressionRuntime {
		if (!isTauriRuntime()) return 'desktop';
		const runtime = getTauriPlatform();
		if (runtime === 'android' || runtime === 'ios' || runtime === 'desktop') {
			return runtime;
		}
		return 'desktop';
	}

	function applyVideoCompressionRuntimePreferences(): void {
		videoCompressionRuntime = resolveVideoCompressionRuntimeScope();
		const profile = getVideoCompressionRuntimeProfile(videoCompressionRuntime);
		videoCompressionRuntimeLabel = profile.label;
		videoCompressionPresetOptions = getVideoCompressionPresetOptions(videoCompressionRuntime);
		const storedPreset = getDefaultVideoCompressionPreset(videoCompressionRuntime);
		const presetAllowed = videoCompressionPresetOptions.some((option) => option.id === storedPreset);
		const resolvedPreset = presetAllowed ? storedPreset : profile.recommendedPreset;
		defaultVideoCompressionPreset = resolvedPreset;
		if (resolvedPreset !== storedPreset) {
			setDefaultVideoCompressionPreset(resolvedPreset, videoCompressionRuntime);
		}
	}

	// Profile Picture upload state
	let showAvatarEditor = false;
	let selectedAvatarFile: File | null = null;
	let selectedAvatarPreview: string | null = null;
	let uploadingAvatar = false;
	let displayNameDraft = '';
	let updatingDisplayName = false;
	let currentLocalWabiAccountKey = '';
	let currentLocalWabiAccountIsDefault = false;
	let otherLocalWabiAccounts: LocalWabiAccountRecord[] = [];
	let linkedWabiImportPreview: LocalWabiProfileImportPreview | null = null;
	let linkedWabiImportSourceKey = '';
	let linkedWabiImportStatus = '';
	let linkedWabiImporting = false;
	let currentPasswordDraft = '';
	let newPasswordDraft = '';
	let confirmNewPasswordDraft = '';
	let currentPasswordInput: HTMLInputElement | null = null;
	let mustChangeOwnPassword = false;
	let changingPassword = false;
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
	let adminDonationConfigLoaded = false;
	let adminDonationConfigLoading = false;
	let adminDonationConfigSaving = false;
	let adminDonationAuditLoaded = false;
	let adminDonationAuditLoading = false;
	let adminDonationRefundingIntentId = '';
	let adminDonationAudit: PaymentDonationLedgerEntry[] = [];
	let adminRelayRosterLoaded = false;
	let adminRelayRosterLoading = false;
	let adminRelayApproveBusyId: number | null = null;
	let adminRelayDeleteBusyId: number | null = null;
	let adminRelayRoster: AdminRelayNode[] = [];
	let communityNodeAccessLoaded = false;
	let communityNodeAccessLoading = false;
	let communityNodeAccessSaving = false;
	let communityNodeAccessStatus = '';
	let communityNodeWhitelistSelectedUserId = '';
	let communityNodeWhitelistUsernameInput = '';
	let communityNodeWhitelistPendingUsernames: string[] = [];
	let communityNodeAccess: CommunityNodeAccessPolicy = {
		mode: 'open',
		allowedUsers: []
	};
	let communityNodeAnnouncementsLoaded = false;
	let communityNodeAnnouncementsLoading = false;
	let communityNodeAnnouncementsSaving = false;
	let communityNodeAnnouncementsStatus = '';
	let communityNodeAnnouncements: CommunityNodeAnnouncementsPolicy = {
		enabled: false,
		channelId: null,
		onlineTemplate: '[{node}] is now online and helping this server. Thank you, {user}.',
		offlineTemplate: '[{node}] went offline.'
	};
	let adminOfflineDonationAuditLoaded = false;
	let adminOfflineDonationAuditLoading = false;
	let adminOfflineDonationSaving = false;
	let adminOfflineDonationVoidingSettlementId = '';
	let adminOfflineDonationAudit: OfflineDonationLedgerEntry[] = [];
	let offlineDonationAmountInput = '10.00';
	let offlineDonationCurrency = 'USD';
	let offlineDonationDonorLabel = '';
	let offlineDonationDescription = '';
	let lastHandledRequestedPaymentSurface: 'connections' | null = null;
	let adminDonationConfig: PaymentDonationConfig = {
		enabled: false,
		providerPluginId: null,
		methodId: null,
		currency: 'USD',
		countryCode: null,
		suggestedAmountsMinor: [500, 1000, 2500],
		headline: 'Support This Server',
		description: 'Contribute to server hosting and maintenance.'
	};
	let donationSuggestedAmountsInput = '5, 10, 25';
	let paymentProviderCapabilities: PaymentProviderCapability[] = [];
	let paymentProviderCapabilitiesLoaded = false;
	interface DonationPrefillPayload {
		amountInput: string;
		providerPluginId: string;
		methodId: string;
		currency: string;
		countryCode: string | null;
		description: string;
		metadata: Record<string, unknown>;
	}
	let desktopHelperProfileName = '';
	let desktopHelperProfileMode: DesktopHelperProfileMode = 'off';
	let desktopHelperProfileStatus = '';
	let directionsGpsEnabled = false;
	let directionsGpsStatus = '';

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
	$: communityAnnouncementChannelOptions = $channels.filter(
		(channel) => channel.type === 'text' || channel.type === 'public' || channel.type === 'thread_public' || channel.type === 'thread_private'
	);
	$: communityNodeWhitelistCandidates = sortedAdminUsers.filter(
		(user) =>
			typeof user.dbUserId === 'number' &&
			!communityNodeAccess.allowedUsers.some((entry) => entry.userId === user.dbUserId)
	);
	$: if ($desktopHelperState?.message && desktopLocalAppRuntime) {
		desktopHelperProfileStatus = $desktopHelperState.message;
	}
	$: if (canManageAdmin && activeSettingsTab === 'admin' && !adminDonationConfigLoaded) {
		void loadAdminDonationConfig();
	}
	$: if (canManageAdmin && activeSettingsTab === 'admin' && !adminDonationAuditLoaded) {
		void loadAdminDonationAudit();
	}
	$: if (canManageAdmin && activeSettingsTab === 'admin' && !adminRelayRosterLoaded) {
		void loadAdminRelayRoster();
	}
	$: if (canManageAdmin && activeSettingsTab === 'admin' && !communityNodeAccessLoaded) {
		void loadCommunityNodeAccessPolicy();
	}
	$: if (canManageAdmin && activeSettingsTab === 'admin' && !communityNodeAnnouncementsLoaded) {
		void loadCommunityNodeAnnouncementsPolicy();
	}
	$: if (canManageAdmin && activeSettingsTab === 'admin' && !adminOfflineDonationAuditLoaded) {
		void loadAdminOfflineDonationAudit();
	}
	$: adminDonationSelectedProvider =
		paymentProviderCapabilities.find((provider) => provider.pluginId === adminDonationConfig.providerPluginId) || null;
	$: adminDonationMethods = adminDonationSelectedProvider?.methods || [];
	$: adminDonationSelectedMethod =
		adminDonationMethods.find((method) => method.id === adminDonationConfig.methodId) || null;
	$: adminDonationCurrencyOptions = getDonationRouteOptions(
		adminDonationSelectedProvider?.currencies || [],
		adminDonationSelectedMethod?.currencies || []
	);
	$: adminDonationCountryOptions = getDonationRouteOptions(
		adminDonationSelectedProvider?.countries || [],
		adminDonationSelectedMethod?.countries || []
	);
	$: donationRoutePreviewReady = Boolean(
		adminDonationConfig.enabled &&
		adminDonationConfig.providerPluginId &&
		adminDonationConfig.methodId
	);
	$: if (adminDonationSelectedProvider || adminDonationConfig.providerPluginId === null) {
		reconcileAdminDonationRouteSelection();
	}
	$: if (!isOpen) {
		lastHandledRequestedPaymentSurface = null;
	}
	$: if (isOpen && requestedPaymentSurface === 'connections' && lastHandledRequestedPaymentSurface !== requestedPaymentSurface) {
		paymentConnectionsOpen = true;
		lastHandledRequestedPaymentSurface = requestedPaymentSurface;
	}
	$: if (isOpen && requestedPasswordChangeRequest > lastHandledRequestedPasswordChangeRequest) {
		lastHandledRequestedPasswordChangeRequest = requestedPasswordChangeRequest;
		activeSettingsTab = 'profile';
		void focusPasswordChangeForm();
	}
	$: selectedVideoCompressionPresetOption =
		videoCompressionPresetOptions.find((option) => option.id === defaultVideoCompressionPreset) || null;
	$: sortedAdminUsers = [...$users].sort((a, b) => {
		const aPriority = a.highestRole === 'owner' ? 3 : a.highestRole === 'admin' ? 2 : a.highestRole === 'mod' ? 1 : 0;
		const bPriority = b.highestRole === 'owner' ? 3 : b.highestRole === 'admin' ? 2 : b.highestRole === 'mod' ? 1 : 0;
		if (aPriority !== bPriority) return bPriority - aPriority;
		return a.username.localeCompare(b.username);
	});
	const uploadRoleOrder: UploadRoleTier[] = ['new', 'trusted', 'moderator', 'admin', 'owner'];
	const uploadRoleLabels: Record<UploadRoleTier, string> = {
		new: 'New',
		trusted: 'Trusted',
		moderator: 'Moderator',
		admin: 'Admin',
		owner: 'Owner'
	};
	let uploadLimitConfig: UploadLimitConfig = {
		perRoleBytes: { new: 10 * MB, trusted: 1024 * MB, moderator: 30 * 1024 * MB, admin: null, owner: null },
		globalUploadCapBytes: null
	};
	let uploadLimitInputs: Record<UploadRoleTier, string> = {
		new: '10',
		trusted: '1024',
		moderator: '30720',
		admin: '',
		owner: ''
	};
	let globalUploadLimitInput = '';
	let loadingUploadLimits = false;
	let savingUploadLimits = false;
	let uploadLimitsLoaded = false;
	let businessSyncMode: 'manual' | 'auto' = 'manual';
	let businessSyncInFlight = false;
	let businessSyncStatus = '';

	function isCallRingtoneMode(value: string | null): value is CallRingtoneMode {
		return CALL_RINGTONE_OPTIONS.some(option => option.value === value);
	}

	function getCallRingtonePresetLabel(mode: CallRingtoneMode): string {
		return CALL_RINGTONE_OPTIONS.find(option => option.value === mode)?.label || 'Classic Bell';
	}

	function getResolvedCallRingtoneLabel(mode: CallRingtoneMode): string {
		if (mode === 'custom-audio') {
			return localStorage.getItem('callRingtoneLabel') || 'Custom audio';
		}
		if (mode === 'custom-synth') {
			return callRingtoneCustomSynth.name?.trim() || 'Custom Synth';
		}
		return getCallRingtonePresetLabel(mode);
	}

	function saveCallRingtoneCustomSynth(): void {
		const sanitized = sanitizeCustomSynthRingtonePreset(callRingtoneCustomSynth);
		callRingtoneCustomSynth = sanitized;
		localStorage.setItem('callRingtoneCustomSynth', JSON.stringify(sanitized));
		if (callRingtoneMode === 'custom-synth') {
			callRingtoneLabel = getResolvedCallRingtoneLabel('custom-synth');
		}
	}

	function loadStoredCallRingtoneCustomSynth(): CustomSynthRingtonePreset {
		const raw = localStorage.getItem('callRingtoneCustomSynth');
		if (!raw) return getDefaultCustomSynthRingtonePreset();
		try {
			return sanitizeCustomSynthRingtonePreset(JSON.parse(raw));
		} catch (error) {
			console.warn('[Settings] Failed to parse custom synth ringtone preset:', error);
			return getDefaultCustomSynthRingtonePreset();
		}
	}

	function getCallRingtoneCustomSynthSummary(): string {
		const secondaryTone = callRingtoneCustomSynth.secondaryToneHz > 0
			? ` + ${Math.round(callRingtoneCustomSynth.secondaryToneHz)}Hz`
			: '';
		return `${callRingtoneCustomSynth.name} | ${callRingtoneCustomSynth.waveform} | ${Math.round(callRingtoneCustomSynth.primaryToneHz)}Hz${secondaryTone}`;
	}

	function getBoosterRelayModeLabel(mode: BoosterRelayMode): string {
		switch (mode) {
			case 'turn-only':
				return 'TURN only';
			case 'turn-sfu':
				return 'TURN + SFU';
			case 'turn-sfu-gateway':
				return 'TURN + SFU + Gateway';
			default:
				return 'Off';
		}
	}

	function getBoosterRelayComponentsSummary(runtime: ServerMediaRuntimeResponse | null): string {
		const components = runtime?.media?.boosterRelay?.components;
		if (!components) return 'No booster relay components advertised.';
		return [
			`TURN ${components.turnConfigured ? 'ready' : 'off'}`,
			`SFU ${components.sfuConfigured ? 'ready' : 'off'}`,
			`Gateway ${
				components.gatewayConfigured
					? components.gatewayHealthy && components.gatewayMediaPlaneReady
						? 'ready'
						: 'starting'
					: 'off'
			}`
		].join(' | ');
	}

	function getBoosterRelaySelfAdvertisementSummary(runtime: ServerMediaRuntimeResponse | null): string {
		const advertisement = runtime?.media?.boosterRelay?.selfAdvertisement;
		if (!advertisement) return 'Self-advertised relay node: unknown.';
		if (!advertisement.advertised) {
			return 'Self-advertised relay node: not registered.';
		}
		const location = advertisement.url || '(missing URL)';
		const relayId = advertisement.relayId ? `, ID ${advertisement.relayId}` : '';
		return `Self-advertised relay node: ${advertisement.status || 'unknown'} at ${location}${relayId}.`;
	}

	$: boosterRelayRequestedMode = getBoosterRelayRequestedMode(mediaRuntimeSnapshot);
	$: boosterRelayEffectiveMode = getBoosterRelayEffectiveMode(mediaRuntimeSnapshot);
	// Load settings from localStorage and enforce server policy
	onMount(() => {
		selectedLocale = $currentLocale || 'en';
		const accessibilitySettings = getStoredAccessibilitySettings();
		const animationSettings = getStoredAnimationPassSettings();
		textScale = accessibilitySettings.textScale;
		colorAssistEnabled = accessibilitySettings.colorAssistEnabled;
		saturation = accessibilitySettings.saturation;
		contrast = accessibilitySettings.contrast;
		reducedMotion = accessibilitySettings.reducedMotion;
		animationPassEnabled = animationSettings.enabled;
		animationPassPreset = animationSettings.preset;
		animationPassLevel = animationSettings.level;
		animationPassDurationMultiplier = animationSettings.durationMultiplier;
		roleColorMode = accessibilitySettings.roleColorMode;
		ownMessagesOnRight = accessibilitySettings.ownMessagesOnRight;
		homeExperienceMode = getStoredHomeExperienceMode();
		chatAvatarMode = accessibilitySettings.chatAvatarMode;
		tabShadeStrength = accessibilitySettings.tabShadeStrength;
		appChromeOpacity = accessibilitySettings.appChromeOpacity;
		messageDensity = accessibilitySettings.messageDensity;
		chatFontScale = accessibilitySettings.chatFontScale;
		deletionCountdownMode = accessibilitySettings.deletionCountdownMode;
		clickableSendEnabled = accessibilitySettings.clickableSendEnabled;
		localAppRuntime = isTauriRuntime();
		desktopLocalAppRuntime = getTauriPlatform() === 'desktop';
		experimentalStdbCallsEnabled = isExperimentalStdbCallEnabled();
		videoCompressionEnabled = isVideoCompressionEnabled();
		applyVideoCompressionRuntimePreferences();
		soundEnabled = localStorage.getItem('soundEnabled') !== 'false';
		notificationsEnabled = localStorage.getItem('notificationsEnabled') !== 'false';
		micEnabled = localStorage.getItem('micEnabled') !== 'false';
		cameraEnabled = localStorage.getItem('cameraEnabled') !== 'false';
		suppressEveryoneHereMentions = localStorage.getItem('suppressEveryoneHereMentions') === 'true';
		suppressRoleMentions = localStorage.getItem('suppressRoleMentions') === 'true';
		notificationPreviewEnabled = localStorage.getItem('notificationPreviewEnabled') === 'true';
		notificationSound = localStorage.getItem('notificationSound') || '/sounds/ProjectSound.ogg';
		notificationSoundLabel =
			notificationSound === '/sounds/ProjectSound.ogg'
				? 'ProjectSound.ogg'
				: localStorage.getItem('notificationSoundLabel') || 'Custom sound';
		notificationVolume = parseFloat(localStorage.getItem('notificationVolume') || '0.5');
		callRingtoneCustomSynth = loadStoredCallRingtoneCustomSynth();
		const storedCallRingtoneMode = localStorage.getItem('callRingtoneMode');
		callRingtoneMode = isCallRingtoneMode(storedCallRingtoneMode) ? storedCallRingtoneMode : 'classic-bell';
		callRingtoneLabel = getResolvedCallRingtoneLabel(callRingtoneMode);
		const storedCallRingtoneVolume = parseFloat(localStorage.getItem('callRingtoneVolume') || '0.65');
		callRingtoneVolume = Number.isFinite(storedCallRingtoneVolume)
			? Math.min(1, Math.max(0, storedCallRingtoneVolume))
			: 0.65;
		reverseImageSearchProvider = getReverseImageSearchProvider();
		searchEngineProvider = getSearchEngineProvider();
		searchEngineCustomTemplate = getCustomSearchEngineTemplate();
		businessSyncMode = getBusinessSyncMode();
		selectedMicDeviceId = getPreferredMicDeviceId() || '';
		selectedCameraDeviceId = getPreferredCameraDeviceId() || '';
		void loadMediaDevices();

		// Load effective media settings through one path so local prefs and server policy
		// are resolved consistently before the UI reflects them.
		void (async () => {
			const mediaSettings = await loadEffectiveMediaSettingsSnapshot();
			mediaQualityMode = mediaSettings.qualityMode;
			audioProcessingMode = mediaSettings.audioProcessingMode;
			callTransportMode = mediaSettings.callTransportMode;
			callMuteBehavior = mediaSettings.callMuteBehavior;
			callRecordingStemMode = mediaSettings.callRecordingStemMode;
			mediaRuntimeSnapshot = mediaSettings.runtime;
			srtGatewayEnabled = mediaSettings.srtGatewayEnabled;
			screenShareQualityPreset = mediaSettings.screenShareQualityPreset;
			screenShareBitrateKbps = mediaSettings.screenShareBitrateKbps;
			spatialAudioEnabled = mediaSettings.spatialAudio.enabled;
			spatialAudioMode = mediaSettings.spatialAudio.mode;
			spatialAudioStrength = mediaSettings.spatialAudio.masterStrength;
			spatialAudioDistanceScale = mediaSettings.spatialAudio.distanceScale;
			spatialAudioWarningsMuted = mediaSettings.spatialAudio.warningMuted;
			spatialAudioQuickToggleVisible = mediaSettings.spatialAudio.quickToggleVisible;
		})();

		memoryTelemetrySupported = typeof performance !== 'undefined' && Boolean((performance as Performance & { memory?: unknown }).memory);
		if (isDevBuild) {
			memoryTelemetryEnabled = localStorage.getItem(MEMORY_TELEMETRY_KEY) === 'true';
			if (memoryTelemetryEnabled) {
				startMemoryTelemetry();
			}
		}

		displayNameDraft = $currentUser?.username || '';
		if (browser) {
			try {
				const rawHelperProfile = localStorage.getItem(DESKTOP_HELPER_PROFILE_KEY);
				if (rawHelperProfile) {
					const parsed = JSON.parse(rawHelperProfile) as {
						name?: string;
						mode?: DesktopHelperProfileMode;
					};
					desktopHelperProfileName = typeof parsed.name === 'string' ? parsed.name : '';
					desktopHelperProfileMode =
						parsed.mode === 'files-only' || parsed.mode === 'desktop-assist' ? parsed.mode : 'off';
				}
			} catch {
				desktopHelperProfileName = '';
				desktopHelperProfileMode = 'off';
			}
			desktopHelperProfileStatus = get(desktopHelperState).message || desktopHelperProfileStatus;
		}
		directionsGpsEnabled = get(directionsAssistSettings).gpsEnabled;
		quoteTemplateDraft = get(customQuoteSettingsStore).template;
		loadTranslatorAddonSettings();
		saveTranslatorAddonSettings();
		const authToken = getAuthToken();
		if (authToken) {
			void getUserSettings(authToken)
				.then((settings) => {
					mustChangeOwnPassword = settings?.require_password_change === true;
					if (!settings?.home_experience) return;
					homeExperienceMode = settings.home_experience === 'conversations' ? 'conversations' : 'community';
					setStoredHomeExperienceMode(homeExperienceMode);
				})
				.catch((error) => {
					console.warn('[Settings] Failed to load home experience mode:', error);
				});
		}

		const unsubscribeDonationRealtime = subscribePaymentRealtimeEvent('payments:donations-admin-updated', () => {
			if (!canManageAdmin) return;
			adminDonationAuditLoaded = false;
			adminOfflineDonationAuditLoaded = false;
			if (activeSettingsTab === 'admin') {
				void loadAdminDonationAudit();
				void loadAdminOfflineDonationAudit();
			}
		});

		const unsubscribeAccessRealtime = subscribePaymentRealtimeEvent('payments:access-updated', () => {
			if (!canManageAdmin || activeSettingsTab !== 'admin') return;
			adminDonationConfigLoaded = false;
			void loadAdminDonationConfig();
		});

		return () => {
			unsubscribeDonationRealtime();
			unsubscribeAccessRealtime();
		};
	});
	$: selectedLocale = $currentLocale || 'en';
	$: uiLearningModeEnabled = $learningModeEnabled;
	$: uiLearningTargetPercent = $learningTargetPercent;

	async function runBusinessSyncNow() {
		if (businessSyncInFlight) return;
		businessSyncInFlight = true;
		businessSyncStatus = 'Syncing now...';
		try {
			const ok = await syncBusinessData(true);
			const pending = hasPendingRemoteBusinessUpdate();
			businessSyncStatus = ok
				? (pending ? 'Synced. New remote updates may still be pending.' : 'Sync complete.')
				: 'No sync performed (offline or not authenticated).';
		} catch (error) {
			businessSyncStatus = 'Sync failed.';
			console.error('Manual business sync failed:', error);
		} finally {
			businessSyncInFlight = false;
		}
	}

	function toggleBusinessSyncMode() {
		businessSyncMode = businessSyncMode === 'manual' ? 'auto' : 'manual';
		setBusinessSyncMode(businessSyncMode);
		businessSyncStatus = businessSyncMode === 'manual'
			? 'Manual mode enabled. Use Sync Now when needed.'
			: 'Auto mode enabled.';
	}

	async function toggleDirectionsGpsAssist(): Promise<void> {
		const next = !directionsGpsEnabled;
		if (next) {
			const granted = await requestDirectionsGpsPermission();
			if (!granted) {
				directionsGpsStatus = 'Location permission was denied or unavailable. Directions cards will stay target-only.';
				directionsGpsEnabled = false;
				setDirectionsGpsEnabled(false);
				return;
			}
			directionsGpsStatus = 'Location assist enabled. Your position is only used locally when you create directions.';
			directionsGpsEnabled = true;
			setDirectionsGpsEnabled(true);
			return;
		}
		directionsGpsEnabled = false;
		setDirectionsGpsEnabled(false);
		directionsGpsStatus = 'Location assist disabled.';
	}

	$: if (!updatingDisplayName && $currentUser?.username && displayNameDraft === '') {
		displayNameDraft = $currentUser.username;
	}
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
		if (selectedStillValid) {
			// Keep the explicit selection.
		} else {
			linkedWabiImportSourceKey =
				getSuggestedLocalWabiImportSourceAccount(currentLocalWabiAccountKey)?.key ||
				otherLocalWabiAccounts[0]?.key ||
				'';
		}
	}
	$: linkedWabiImportPreview = getLocalWabiProfileImportPreview(
		linkedWabiImportSourceKey,
		$currentUser
	);

	onDestroy(() => {
		cleanupMicTest();
		stopMemoryTelemetry();
		if (callRingtonePreviewTimeout !== null) {
			window.clearTimeout(callRingtonePreviewTimeout);
			callRingtonePreviewTimeout = null;
		}
		stopCallRingtone();
	});

	function bytesToMbInput(bytes: number | null): string {
		if (bytes === null) return '';
		const mb = Math.floor(bytes / MB);
		return mb > 0 ? String(mb) : '1';
	}

	function syncUploadLimitInputsFromConfig(config: UploadLimitConfig) {
		uploadLimitInputs = {
			new: bytesToMbInput(config.perRoleBytes.new),
			trusted: bytesToMbInput(config.perRoleBytes.trusted),
			moderator: bytesToMbInput(config.perRoleBytes.moderator),
			admin: bytesToMbInput(config.perRoleBytes.admin),
			owner: bytesToMbInput(config.perRoleBytes.owner)
		};
		globalUploadLimitInput = bytesToMbInput(config.globalUploadCapBytes);
	}

	function parseMbInput(value: string): number | null {
		const trimmed = value.trim();
		if (!trimmed) return null;
		const mb = Number(trimmed);
		if (!Number.isFinite(mb) || mb <= 0) {
			throw new Error('Limits must be positive MB values or blank for unlimited.');
		}
		return Math.floor(mb * MB);
	}

	async function loadUploadLimits() {
		if (!canManageAdmin || loadingUploadLimits) return;
		const token = getAuthToken();
		if (!token) return;
		loadingUploadLimits = true;
		try {
			const { config } = await getAdminUploadLimits(token);
			uploadLimitConfig = config;
			syncUploadLimitInputsFromConfig(config);
			uploadLimitsLoaded = true;
		} catch (error) {
			console.error('Failed to load upload limits:', error);
		} finally {
			loadingUploadLimits = false;
		}
	}

	async function saveUploadLimits() {
		if (!canManageAdmin || savingUploadLimits) return;
		const token = getAuthToken();
		if (!token) {
			alert('You are not authenticated.');
			return;
		}
		try {
			const nextConfig: UploadLimitConfig = {
				perRoleBytes: {
					new: parseMbInput(uploadLimitInputs.new),
					trusted: parseMbInput(uploadLimitInputs.trusted),
					moderator: parseMbInput(uploadLimitInputs.moderator),
					admin: parseMbInput(uploadLimitInputs.admin),
					owner: parseMbInput(uploadLimitInputs.owner)
				},
				globalUploadCapBytes: parseMbInput(globalUploadLimitInput)
			};
			savingUploadLimits = true;
			const saved = await saveAdminUploadLimits(token, nextConfig);
			uploadLimitConfig = saved;
			syncUploadLimitInputsFromConfig(saved);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to save upload limits.';
			alert(message);
		} finally {
			savingUploadLimits = false;
		}
	}

	$: if (isOpen && canManageAdmin && !uploadLimitsLoaded && !loadingUploadLimits) {
		void loadUploadLimits();
	}

	$: if (isOpen && activeSettingsTab === 'addons' && !addonsLoading && !addonsLastDetectedAt) {
		void refreshAddonDetection();
	}

	$: if (!isOpen) {
		addonsLastDetectedAt = '';
	}
	$: translatorAddonDetected = [...frontendAddons, ...backendAddons].some((addon) => addon.id === 'translator-assist');
	$: spellCheckEnabled = $composerEnhancementSettingsStore.spellcheckEnabled;
	$: charCounterEnabled = $composerEnhancementSettingsStore.charCounterEnabled;
	$: splitLargeMessagesEnabled = $composerEnhancementSettingsStore.splitLargeMessagesEnabled;
	$: splitLargeMessagesChunkSize = $composerEnhancementSettingsStore.splitLargeMessagesChunkSize;
	$: splitLargeMessagesInputMaxLength = $composerEnhancementSettingsStore.splitLargeMessagesInputMaxLength;
	$: writeUpperCaseEnabled = $composerEnhancementSettingsStore.writeUpperCaseEnabled;
	$: clickableMentionsEnabled = $displayEnhancementSettingsStore.clickableMentionsEnabled;
	$: timestampDisplayMode = $displayEnhancementSettingsStore.timestampDisplayMode;
	$: revealAllSpoilersEnabled = $displayEnhancementSettingsStore.revealAllSpoilersEnabled;
	$: revealAllSpoilersMinRole = $displayEnhancementSettingsStore.revealAllSpoilersMinRole;
	$: betterSearchPageEnabled = $displayEnhancementSettingsStore.betterSearchPageEnabled;
	$: googleSearchReplaceEnabled = $displayEnhancementSettingsStore.googleSearchReplaceEnabled;
	$: hideMutedCategoriesEnabled = $displayEnhancementSettingsStore.hideMutedCategoriesEnabled;
	$: readAllNotificationsButtonEnabled =
		$displayEnhancementSettingsStore.readAllNotificationsButtonEnabled;
	$: spotifyControlsEnabled = $displayEnhancementSettingsStore.spotifyControlsEnabled;
	$: localNicknamesEnabled = $displayEnhancementSettingsStore.localNicknamesEnabled;
	$: serverCounterEnabled = $displayEnhancementSettingsStore.serverCounterEnabled;
	$: betterNsfwTagEnabled = $displayEnhancementSettingsStore.betterNsfwTagEnabled;
	$: customStatusPresetsEnabled = $displayEnhancementSettingsStore.customStatusPresetsEnabled;
	$: quickMentionEnabled = $displayEnhancementSettingsStore.quickMentionEnabled;
	$: personalPinsEnabled = $displayEnhancementSettingsStore.personalPinsEnabled;
	$: lastMessageDateEnabled = $displayEnhancementSettingsStore.lastMessageDateEnabled;
	$: showConnectionsEnabled = $displayEnhancementSettingsStore.showConnectionsEnabled;
	$: userNotesEnabled = $displayEnhancementSettingsStore.userNotesEnabled;
	$: friendNotificationsEnabled = $displayEnhancementSettingsStore.friendNotificationsEnabled;
	$: friendNotificationsTrackedOnly =
		$displayEnhancementSettingsStore.friendNotificationsTrackedOnly;
	$: messageUtilitiesEnabled = $displayEnhancementSettingsStore.messageUtilitiesEnabled;
	$: betterFriendListEnabled = $displayEnhancementSettingsStore.betterFriendListEnabled;
	$: emojiStatisticsEnabled = $displayEnhancementSettingsStore.emojiStatisticsEnabled;
	$: removeNicknamesEnabled = $displayEnhancementSettingsStore.removeNicknamesEnabled;
	$: staffTagEnabled = $displayEnhancementSettingsStore.staffTagEnabled;
	$: topRoleEverywhereEnabled = $displayEnhancementSettingsStore.topRoleEverywhereEnabled;
	$: timedThemeModeEnabled = $timedThemeModeSettingsStore.enabled;
	$: timedThemeDayStartHour = $timedThemeModeSettingsStore.dayStartHour;
	$: timedThemeNightStartHour = $timedThemeModeSettingsStore.nightStartHour;
	$: timedThemeLightThemeId = $timedThemeModeSettingsStore.lightThemeId;
	$: timedThemeDarkThemeId = $timedThemeModeSettingsStore.darkThemeId;
	$: personalPinCount = Object.values($personalPinsStore).reduce(
		(total, ids) => total + (Array.isArray(ids) ? ids.length : 0),
		0
	);
	$: unicodeEmojisEnabled = $unicodeEmojiSettingsStore.enabled;
	$: unicodeConvertDefaultEnabled = $unicodeEmojiSettingsStore.convertDefault;
	$: unicodeConvertOpenmojiEnabled = $unicodeEmojiSettingsStore.convertOpenmoji;
	$: gifCaptionerEnabled = $gifCaptionerSettingsStore.enabled;
	$: gifCaptionerDedicatedFieldEnabled = $gifCaptionerSettingsStore.dedicatedCaptionFieldEnabled;
	$: gifCaptionerCaptionStyle = $gifCaptionerSettingsStore.captionStyle;
	$: zipPreviewEnabled = $zipPreviewSettingsStore.enabled;
	$: zipPreviewInlineEnabled = $zipPreviewSettingsStore.inlinePreviewEnabled;
	$: quickReactionsEnabled = $quickReactionSettingsStore.enabled;
	$: quickReactionCustomEmojiEntries = $quickReactionSettingsStore.customEmojiIds
		.map((emojiId) => $emojis.find((emoji) => emoji.id === emojiId))
		.filter((emoji): emoji is Emoji => Boolean(emoji));
	$: emojiStatsCategories = (() => {
		const byCategory = new Map<string, number>();
		for (const emoji of $emojis) {
			const category = (emoji.category || 'uncategorized').trim().toLowerCase();
			byCategory.set(category, (byCategory.get(category) || 0) + 1);
		}
		return Array.from(byCategory.entries())
			.map(([category, count]) => ({ category, count }))
			.sort((a, b) => b.count - a.count || a.category.localeCompare(b.category))
			.slice(0, 8);
	})();
	$: mutedChannelCount = $displayEnhancementSettingsStore.mutedChannelIds.length;
	$: localNicknameCount = Object.keys($localNicknamesStore).length;
	$: quickReactionClickShare = getQuickReactionClickShare($quickReactionTelemetryStore);
	$: pinnedDmConversationCount = $pinnedDmIdsStore.length;

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

	async function loadMediaDevices() {
		if (!browser || !navigator.mediaDevices?.enumerateDevices) return;
		try {
			const devices = await navigator.mediaDevices.enumerateDevices();
			audioInputDevices = devices.filter(d => d.kind === 'audioinput');
			videoInputDevices = devices.filter(d => d.kind === 'videoinput');
		} catch {
			// permissions denied - lists stay empty
		}
	}

	function handleMicDeviceChange(deviceId: string) {
		selectedMicDeviceId = deviceId;
		setPreferredMicDeviceId(deviceId || null);
	}

	function handleCameraDeviceChange(deviceId: string) {
		selectedCameraDeviceId = deviceId;
		setPreferredCameraDeviceId(deviceId || null);
	}

	function toggleUiLearningMode() {
		setLearningModeEnabled(!uiLearningModeEnabled);
	}

	function handleUiLearningPercentChange(value: string) {
		const next = Number(value);
		if (!Number.isFinite(next)) return;
		setLearningTargetPercent(next);
	}

	function toggleSuppressEveryoneHereMentions() {
		suppressEveryoneHereMentions = !suppressEveryoneHereMentions;
		localStorage.setItem('suppressEveryoneHereMentions', suppressEveryoneHereMentions.toString());
	}

	function toggleSuppressRoleMentions() {
		suppressRoleMentions = !suppressRoleMentions;
		localStorage.setItem('suppressRoleMentions', suppressRoleMentions.toString());
	}

	function toggleNotificationPreview() {
		notificationPreviewEnabled = !notificationPreviewEnabled;
		localStorage.setItem('notificationPreviewEnabled', notificationPreviewEnabled.toString());
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

	function openProfilePaymentSheet(options: {
		amountInput?: string | null;
		currency?: string | null;
		countryCode?: string | null;
		description?: string | null;
		customerRef?: string | null;
		providerId?: string | null;
		methodId?: string | null;
		metadata?: Record<string, unknown> | null;
	} = {}): void {
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

	function minorToMajorInput(amountMinor: number, currency = adminDonationConfig.currency || 'USD'): string {
		return minorAmountToInput(amountMinor, currency);
	}

	function formatDonationAuditAmount(amountMinor: number, currency: string): string {
		return formatPaymentMinorAmount(amountMinor, currency);
	}

	function formatDonationAuditWhen(entry: PaymentDonationLedgerEntry | OfflineDonationLedgerEntry): string {
		const timestamp = 'refundedAt' in entry
			? entry.refundedAt || entry.completedAt || entry.createdAt
			: entry.voidedAt || entry.completedAt || entry.createdAt;
		if (!timestamp || !Number.isFinite(timestamp)) return 'n/a';
		return new Date(timestamp).toLocaleString();
	}

	function parseSuggestedAmountsInput(value: string): number[] {
		return value
			.split(',')
			.map((entry) => parsePaymentMajorAmount(entry.trim(), adminDonationConfig.currency || 'USD'))
			.filter((amount) => Number.isFinite(amount) && amount > 0);
	}

	function parseMajorAmountInput(value: string, currency = adminDonationConfig.currency || 'USD'): number {
		return parsePaymentMajorAmount(value, currency);
	}

	function normalizeDonationRouteOptionValues(values: string[]): string[] {
		const seen = new Set<string>();
		const normalized: string[] = [];
		for (const value of values) {
			const upper = String(value || '').trim().toUpperCase();
			if (!upper || seen.has(upper)) continue;
			seen.add(upper);
			normalized.push(upper);
		}
		return normalized;
	}

	function getDonationRouteOptions(providerValues: string[], methodValues: string[]): string[] {
		const providerOptions = normalizeDonationRouteOptionValues(providerValues);
		const methodOptions = normalizeDonationRouteOptionValues(methodValues);

		if (providerOptions.length === 0) return methodOptions;
		if (methodOptions.length === 0) return providerOptions;

		const intersection = providerOptions.filter((value) => methodOptions.includes(value));
		return intersection.length > 0 ? intersection : providerOptions;
	}

	function getDonationRouteSummaryList(values: number[]): string {
		if (values.length === 0) return 'No suggested amounts';
		return values.map((amountMinor) => minorToMajorInput(amountMinor, adminDonationConfig.currency || 'USD')).join(', ');
	}

	function reconcileAdminDonationRouteSelection(): void {
		let nextConfig = adminDonationConfig;
		let changed = false;

		if (!adminDonationSelectedProvider) {
			if (adminDonationConfig.methodId !== null) {
				nextConfig = {
					...nextConfig,
					methodId: null
				};
				changed = true;
			}
			if (changed) {
				adminDonationConfig = nextConfig;
			}
			return;
		}

		const nextMethodId = adminDonationMethods.some((method) => method.id === nextConfig.methodId)
			? nextConfig.methodId
			: (adminDonationMethods[0]?.id || null);
		if (nextMethodId !== nextConfig.methodId) {
			nextConfig = {
				...nextConfig,
				methodId: nextMethodId
			};
			changed = true;
		}

		const selectedMethod: PaymentMethodCapability | null =
			adminDonationMethods.find((method) => method.id === nextConfig.methodId) || null;
		const nextCurrencyOptions = getDonationRouteOptions(
			adminDonationSelectedProvider.currencies,
			selectedMethod?.currencies || []
		);
		const normalizedCurrency = String(nextConfig.currency || '').trim().toUpperCase();
		const nextCurrency =
			nextCurrencyOptions.length > 0
				? (nextCurrencyOptions.includes(normalizedCurrency) ? normalizedCurrency : nextCurrencyOptions[0])
				: (normalizedCurrency || 'USD');
		if (nextCurrency !== nextConfig.currency) {
			nextConfig = {
				...nextConfig,
				currency: nextCurrency
			};
			changed = true;
		}

		const nextCountryOptions = getDonationRouteOptions(
			adminDonationSelectedProvider.countries,
			selectedMethod?.countries || []
		);
		const normalizedCountry = String(nextConfig.countryCode || '').trim().toUpperCase();
		const nextCountryCode =
			nextCountryOptions.length > 0
				? (nextCountryOptions.includes(normalizedCountry) ? normalizedCountry : nextCountryOptions[0])
				: (normalizedCountry || null);
		if (nextCountryCode !== nextConfig.countryCode) {
			nextConfig = {
				...nextConfig,
				countryCode: nextCountryCode
			};
			changed = true;
		}

		if (changed) {
			adminDonationConfig = nextConfig;
		}
	}

	function normalizeAdminDonationMethodSelection(): void {
		if (!adminDonationConfig.providerPluginId) {
			if (adminDonationConfig.methodId !== null) {
				adminDonationConfig = {
					...adminDonationConfig,
					methodId: null
				};
			}
			return;
		}

		const selectedProvider =
			paymentProviderCapabilities.find((provider) => provider.pluginId === adminDonationConfig.providerPluginId) || null;
		const methods = selectedProvider?.methods || [];
		const currentMethodValid = methods.some((method) => method.id === adminDonationConfig.methodId);
		const nextMethodId = currentMethodValid ? adminDonationConfig.methodId : (methods[0]?.id || null);

		if (nextMethodId !== adminDonationConfig.methodId) {
			adminDonationConfig = {
				...adminDonationConfig,
				methodId: nextMethodId
			};
		}
	}

	async function loadPaymentProviderCapabilities(): Promise<void> {
		if (paymentProviderCapabilitiesLoaded) return;
		try {
			paymentProviderCapabilities = await listPaymentProviders();
			paymentProviderCapabilitiesLoaded = true;
			normalizeAdminDonationMethodSelection();
		} catch (error) {
			console.error('[Payments] Failed to load provider capabilities for settings:', error);
		}
	}

	async function loadAdminDonationConfig(): Promise<void> {
		if (adminDonationConfigLoaded || adminDonationConfigLoading || !canManageAdmin) return;
		const token = getAuthToken();
		if (!token) return;
		adminDonationConfigLoading = true;
		try {
			adminDonationConfig = await getAdminPaymentDonationConfig(token);
			donationSuggestedAmountsInput = adminDonationConfig.suggestedAmountsMinor
				.map((amountMinor) => minorToMajorInput(amountMinor, adminDonationConfig.currency || 'USD'))
				.join(', ');
			offlineDonationCurrency = adminDonationConfig.currency || offlineDonationCurrency;
			adminDonationConfigLoaded = true;
			await loadPaymentProviderCapabilities();
			normalizeAdminDonationMethodSelection();
		} catch (error) {
			console.error('[Payments] Failed to load donation config:', error);
		} finally {
			adminDonationConfigLoading = false;
		}
	}

	async function loadAdminDonationAudit(): Promise<void> {
		if (adminDonationAuditLoaded || adminDonationAuditLoading || !canManageAdmin) return;
		const token = getAuthToken();
		if (!token) return;
		adminDonationAuditLoading = true;
		try {
			const response = await listAdminPaymentDonationAudit(token, 100);
			adminDonationAudit = response.donations;
			adminDonationAuditLoaded = true;
		} catch (error) {
			console.error('[Payments] Failed to load donation audit trail:', error);
		} finally {
			adminDonationAuditLoading = false;
		}
	}

	function getAdminRelayKindLabel(relay: AdminRelayNode): string {
		const kind = relay.metadata?.kind;
		if (kind === 'booster-relay') return 'Booster Relay';
		if (kind === 'desktop-helper') return 'Desktop Helper';
		if (relay.metadata?.capabilities?.selfHosted) return 'Self-Hosted Node';
		return 'Relay Node';
	}

	function getAdminRelayCapabilitiesSummary(relay: AdminRelayNode): string {
		const capabilities = relay.metadata?.capabilities;
		if (!capabilities) return 'No capabilities advertised';
		const labels: string[] = [];
		if (capabilities.fileRelay) labels.push('Files');
		if (capabilities.turn) labels.push('TURN');
		if (capabilities.sfu) labels.push('SFU');
		if (capabilities.gateway) labels.push('Gateway');
		return labels.length > 0 ? labels.join(' / ') : 'No capabilities advertised';
	}

	function formatRelaySeenAt(unixSeconds: number | null): string {
		if (!unixSeconds) return 'Never';
		try {
			return new Date(unixSeconds * 1000).toLocaleString();
		} catch {
			return 'Unknown';
		}
	}

	function getAdminRelayOwnerLabel(relay: AdminRelayNode): string | null {
		if (relay.metadata?.ownerUsername) {
			return 'Owner: ' + relay.metadata.ownerUsername;
		}
		return null;
	}

	async function loadAdminRelayRoster(): Promise<void> {
		if (adminRelayRosterLoaded || adminRelayRosterLoading || !canManageAdmin) return;
		const token = getAuthToken();
		if (!token) return;
		adminRelayRosterLoading = true;
		try {
			const relays = await listAdminRelays(token);
			adminRelayRoster = relays.sort((a, b) => {
				const statusOrder = (value: string) =>
					value === 'active' ? 0 : value === 'degraded' ? 1 : value === 'pending' ? 2 : value === 'offline' ? 3 : 4;
				return statusOrder(a.status) - statusOrder(b.status) || a.name.localeCompare(b.name);
			});
			adminRelayRosterLoaded = true;
		} catch (error) {
			console.error('[Relay] Failed to load admin relay roster:', error);
		} finally {
			adminRelayRosterLoading = false;
		}
	}

	async function loadCommunityNodeAnnouncementsPolicy(): Promise<void> {
		if (communityNodeAnnouncementsLoaded || communityNodeAnnouncementsLoading || !canManageAdmin) return;
		const token = getAuthToken();
		if (!token) return;
		communityNodeAnnouncementsLoading = true;
		try {
			communityNodeAnnouncements = await getAdminCommunityNodeAnnouncementsPolicy(token);
			communityNodeAnnouncementsLoaded = true;
			communityNodeAnnouncementsStatus = '';
		} catch (error) {
			console.error('[CommunityNodes] Failed to load announcement policy:', error);
			communityNodeAnnouncementsStatus =
				error instanceof Error ? error.message : 'Failed to load node announcement settings.';
		} finally {
			communityNodeAnnouncementsLoading = false;
		}
	}

	async function loadCommunityNodeAccessPolicy(): Promise<void> {
		if (communityNodeAccessLoaded || communityNodeAccessLoading || !canManageAdmin) return;
		const token = getAuthToken();
		if (!token) return;
		communityNodeAccessLoading = true;
		try {
			communityNodeAccess = await getAdminCommunityNodeAccessPolicy(token);
			communityNodeAccessLoaded = true;
			communityNodeAccessStatus = '';
		} catch (error) {
			console.error('[CommunityNodes] Failed to load access policy:', error);
			communityNodeAccessStatus =
				error instanceof Error ? error.message : 'Failed to load community node access policy.';
		} finally {
			communityNodeAccessLoading = false;
		}
	}

	function addCommunityNodeWhitelistEntry(entry: CommunityNodeAllowedUser): void {
		if (communityNodeAccess.allowedUsers.some((item) => item.userId === entry.userId)) return;
		communityNodeAccess = {
			...communityNodeAccess,
			allowedUsers: [...communityNodeAccess.allowedUsers, entry].sort((a, b) => a.username.localeCompare(b.username))
		};
	}

	function addSelectedCommunityNodeWhitelistUser(): void {
		const numericId = Number(communityNodeWhitelistSelectedUserId);
		if (!Number.isFinite(numericId)) return;
		const user = communityNodeWhitelistCandidates.find((entry) => entry.dbUserId === numericId);
		if (!user?.dbUserId) return;
		addCommunityNodeWhitelistEntry({
			userId: user.dbUserId,
			username: user.username
		});
		communityNodeWhitelistSelectedUserId = '';
	}

	function addTypedCommunityNodeWhitelistUser(): void {
		const username = communityNodeWhitelistUsernameInput.trim();
		if (!username) return;
		if (communityNodeAccess.allowedUsers.some((entry) => entry.username.toLowerCase() === username.toLowerCase())) {
			communityNodeWhitelistUsernameInput = '';
			return;
		}
		if (!communityNodeWhitelistPendingUsernames.some((entry) => entry.toLowerCase() === username.toLowerCase())) {
			communityNodeWhitelistPendingUsernames = [...communityNodeWhitelistPendingUsernames, username].sort((a, b) =>
				a.localeCompare(b)
			);
		}
		communityNodeWhitelistUsernameInput = '';
	}

	function removeCommunityNodeWhitelistUser(userId: number): void {
		communityNodeAccess = {
			...communityNodeAccess,
			allowedUsers: communityNodeAccess.allowedUsers.filter((entry) => entry.userId !== userId)
		};
	}

	function removePendingCommunityNodeWhitelistUsername(username: string): void {
		communityNodeWhitelistPendingUsernames = communityNodeWhitelistPendingUsernames.filter((entry) => entry !== username);
	}

	async function saveCommunityNodeAccess(): Promise<void> {
		if (!canManageAdmin || communityNodeAccessSaving) return;
		const token = getAuthToken();
		if (!token) return;
		communityNodeAccessSaving = true;
		try {
			const payload = {
				...communityNodeAccess,
				allowedUsers: [...communityNodeAccess.allowedUsers, ...communityNodeWhitelistPendingUsernames]
			};
			communityNodeAccess = await saveAdminCommunityNodeAccessPolicy(
				token,
				payload as unknown as CommunityNodeAccessPolicy
			);
			communityNodeWhitelistPendingUsernames = [];
			communityNodeAccessLoaded = true;
			communityNodeAccessStatus = 'Community node access policy saved.';
		} catch (error) {
			communityNodeAccessStatus =
				error instanceof Error ? error.message : 'Failed to save community node access policy.';
		} finally {
			communityNodeAccessSaving = false;
		}
	}

	async function saveCommunityNodeAnnouncements(): Promise<void> {
		if (!canManageAdmin || communityNodeAnnouncementsSaving) return;
		const token = getAuthToken();
		if (!token) return;
		if (communityNodeAnnouncements.enabled && !communityNodeAnnouncements.channelId) {
			communityNodeAnnouncementsStatus = 'Pick a channel before enabling community node announcements.';
			return;
		}
		communityNodeAnnouncementsSaving = true;
		try {
			communityNodeAnnouncements = await saveAdminCommunityNodeAnnouncementsPolicy(token, communityNodeAnnouncements);
			communityNodeAnnouncementsLoaded = true;
			communityNodeAnnouncementsStatus = 'Community node announcement settings saved.';
		} catch (error) {
			communityNodeAnnouncementsStatus =
				error instanceof Error ? error.message : 'Failed to save node announcement settings.';
		} finally {
			communityNodeAnnouncementsSaving = false;
		}
	}

	async function approveRelayNode(relay: AdminRelayNode): Promise<void> {
		if (!canManageAdmin || adminRelayApproveBusyId !== null) return;
		const token = getAuthToken();
		if (!token) return;
		adminRelayApproveBusyId = relay.relay_id;
		try {
			await approveAdminRelay(token, relay.relay_id);
			adminRelayRosterLoaded = false;
			await loadAdminRelayRoster();
		} catch (error) {
			alert(error instanceof Error ? error.message : 'Failed to approve relay node');
		} finally {
			adminRelayApproveBusyId = null;
		}
	}

	async function deleteRelayNode(relay: AdminRelayNode): Promise<void> {
		if (!canManageAdmin || adminRelayDeleteBusyId !== null) return;
		const token = getAuthToken();
		if (!token) return;
		if (!confirm(`Delete node "${relay.name}" from the server roster?`)) return;
		adminRelayDeleteBusyId = relay.relay_id;
		try {
			await deleteAdminRelay(token, relay.relay_id);
			adminRelayRoster = adminRelayRoster.filter((entry) => entry.relay_id !== relay.relay_id);
			adminRelayRosterLoaded = true;
		} catch (error) {
			alert(error instanceof Error ? error.message : 'Failed to delete relay node');
		} finally {
			adminRelayDeleteBusyId = null;
		}
	}

	async function saveDesktopHelperProfile(): Promise<void> {
		if (!browser) return;
		const normalizedName = desktopHelperProfileName.trim();
		if (desktopHelperProfileMode !== 'off' && !normalizedName) {
			desktopHelperProfileStatus = 'Pick a helper name before using helper mode.';
			return;
		}
		try {
			localStorage.setItem(
				DESKTOP_HELPER_PROFILE_KEY,
				JSON.stringify({
					name: normalizedName,
					mode: desktopHelperProfileMode
				})
			);
			desktopHelperProfileStatus =
				desktopHelperProfileMode === 'off'
					? 'Desktop helper profile saved. Helper mode stays off.'
					: 'Desktop helper profile saved. Activating desktop helper...';
			await syncDesktopHelperService();
			desktopHelperProfileStatus = get(desktopHelperState).message || desktopHelperProfileStatus;
		} catch {
			desktopHelperProfileStatus = 'Failed to save desktop helper profile locally.';
		}
	}

	async function loadAdminOfflineDonationAudit(): Promise<void> {
		if (adminOfflineDonationAuditLoaded || adminOfflineDonationAuditLoading || !canManageAdmin) return;
		const token = getAuthToken();
		if (!token) return;
		adminOfflineDonationAuditLoading = true;
		try {
			const response = await listAdminOfflineDonations(token, 100);
			adminOfflineDonationAudit = response.donations;
			adminOfflineDonationAuditLoaded = true;
		} catch (error) {
			console.error('[Payments] Failed to load offline donation audit trail:', error);
		} finally {
			adminOfflineDonationAuditLoading = false;
		}
	}

	async function saveDonationConfig(): Promise<void> {
		if (adminDonationConfigSaving) return;
		const token = getAuthToken();
		if (!token) {
			alert('You must be logged in as admin/owner.');
			return;
		}

		const nextConfig: PaymentDonationConfig = {
			...adminDonationConfig,
			suggestedAmountsMinor: parseSuggestedAmountsInput(donationSuggestedAmountsInput)
		};

		adminDonationConfigSaving = true;
		try {
			adminDonationConfig = await saveAdminPaymentDonationConfig(token, nextConfig);
			donationSuggestedAmountsInput = adminDonationConfig.suggestedAmountsMinor
				.map((amountMinor) => minorToMajorInput(amountMinor, adminDonationConfig.currency || 'USD'))
				.join(', ');
			alert('Donation settings saved.');
		} catch (error) {
			alert(error instanceof Error ? error.message : 'Failed to save donation settings.');
		} finally {
			adminDonationConfigSaving = false;
		}
	}

	async function createOfflineDonationRecord(): Promise<void> {
		if (adminOfflineDonationSaving) return;
		const token = getAuthToken();
		if (!token) {
			alert('You must be logged in as admin/owner.');
			return;
		}

		const amountMinor = parseMajorAmountInput(offlineDonationAmountInput, offlineDonationCurrency);
		if (amountMinor <= 0) {
			alert('Enter a valid offline donation amount.');
			return;
		}
		const currency = offlineDonationCurrency.trim().toUpperCase();
		if (!/^[A-Z]{3}$/.test(currency)) {
			alert('Enter a valid 3-letter currency code.');
			return;
		}

		adminOfflineDonationSaving = true;
		try {
			const donation = await createAdminOfflineDonation(token, {
				amountMinor,
				currency,
				donorLabel: offlineDonationDonorLabel.trim() || undefined,
				description: offlineDonationDescription.trim() || undefined,
				metadata: { source: 'settings_admin_manual_entry' }
			});
			adminOfflineDonationAudit = [
				donation,
				...adminOfflineDonationAudit.filter((entry) => entry.settlementId !== donation.settlementId)
			];
			adminOfflineDonationAuditLoaded = true;
			offlineDonationAmountInput = minorToMajorInput(amountMinor, currency);
			offlineDonationCurrency = currency;
			offlineDonationDonorLabel = '';
			offlineDonationDescription = '';
			alert('Offline donation recorded.');
		} catch (error) {
			alert(error instanceof Error ? error.message : 'Failed to record offline donation.');
		} finally {
			adminOfflineDonationSaving = false;
		}
	}

	async function refundDonation(entry: PaymentDonationLedgerEntry): Promise<void> {
		if (!canManageAdmin || adminDonationRefundingIntentId || !entry.canRefund) return;
		const token = getAuthToken();
		if (!token) {
			alert('You must be logged in as admin/owner.');
			return;
		}

		const reason = window.prompt(
			`Refund ${formatDonationAuditAmount(entry.amountMinor, entry.currency)} from ${entry.donorLabel}.`,
			'Refund requested by donor'
		);
		if (reason === null) return;

		const normalizedReason = reason.trim() || 'Refund requested by donor';
		const confirmed = window.confirm(
			`Issue a donation refund for ${entry.donorLabel}?\n\n${formatDonationAuditAmount(entry.amountMinor, entry.currency)}\nReason: ${normalizedReason}`
		);
		if (!confirmed) return;

		adminDonationRefundingIntentId = entry.intentId;
		try {
			await refundAdminPaymentDonation(token, entry.intentId, normalizedReason);
			adminDonationAuditLoaded = false;
			await loadAdminDonationAudit();
			alert('Donation refund submitted.');
		} catch (error) {
			alert(error instanceof Error ? error.message : 'Failed to refund donation.');
		} finally {
			adminDonationRefundingIntentId = '';
		}
	}

	async function voidOfflineDonation(entry: OfflineDonationLedgerEntry): Promise<void> {
		if (!canManageAdmin || adminOfflineDonationVoidingSettlementId || !entry.canVoid) return;
		const token = getAuthToken();
		if (!token) {
			alert('You must be logged in as admin/owner.');
			return;
		}

		const reason = window.prompt(
			`Void offline donation from ${entry.donorLabel}?`,
			'Recorded in error'
		);
		if (reason === null) return;
		const normalizedReason = reason.trim() || 'Recorded in error';
		const confirmed = window.confirm(
			`Void offline donation for ${entry.donorLabel}?\n\n${formatDonationAuditAmount(entry.amountMinor, entry.currency)}\nReason: ${normalizedReason}`
		);
		if (!confirmed) return;

		adminOfflineDonationVoidingSettlementId = entry.settlementId;
		try {
			const updated = await voidAdminOfflineDonation(token, entry.settlementId, normalizedReason);
			adminOfflineDonationAudit = adminOfflineDonationAudit.map((item) =>
				item.settlementId === entry.settlementId ? updated : item
			);
			alert('Offline donation voided.');
		} catch (error) {
			alert(error instanceof Error ? error.message : 'Failed to void offline donation.');
		} finally {
			adminOfflineDonationVoidingSettlementId = '';
		}
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

	async function promptAdminPasswordReset(user: { dbUserId?: number; username: string; id: string; highestRole?: string }) {
		if (!canManageTargetUser(user) || !user.dbUserId) return;

		const newPassword = window.prompt(`Set a new password for ${user.username} (min 8 chars):`);
		if (!newPassword) return;
		if (newPassword.length < 8) {
			alert('Password must be at least 8 characters.');
			return;
		}
		const confirm = window.prompt(`Confirm new password for ${user.username}:`);
		if (confirm !== newPassword) {
			alert('Password confirmation does not match.');
			return;
		}

		const token = getAuthToken();
		if (!token) {
			alert('You must be logged in as admin/owner.');
			return;
		}

		const temporaryReset = window.confirm(
			`Make this a temporary password for ${user.username}? Click OK to require a password change on next login, or Cancel to make it permanent.`
		);

		try {
			await adminResetUserPassword(token, user.dbUserId, newPassword, temporaryReset);
			alert(
				temporaryReset
					? `Temporary password set for ${user.username}. They will be asked to change it on next login.`
					: `Password reset for ${user.username}.`
			);
		} catch (error) {
			alert(error instanceof Error ? error.message : 'Failed to reset password.');
		}
	}

	async function clearUserLoginLockout(user: { dbUserId?: number; username: string; id: string; highestRole?: string }) {
		if (!canManageTargetUser(user) || !user.dbUserId) return;
		const token = getAuthToken();
		if (!token) {
			alert('You must be logged in as admin/owner.');
			return;
		}
		try {
			await adminClearUserLoginLockout(token, user.dbUserId);
			alert(`Cleared login lockout state for ${user.username}.`);
		} catch (error) {
			alert(error instanceof Error ? error.message : 'Failed to clear lockout.');
		}
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

	function updateCallMuteBehavior(mode: CallMuteBehavior) {
		callMuteBehavior = mode;
		setCallMuteBehavior(mode);
		refreshLocalAudioMuteState();
		refreshCallRecordingMix();
	}

	function updateCallRecordingStemMode(mode: CallRecordingStemMode) {
		callRecordingStemMode = mode;
		setCallRecordingStemMode(mode);
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

	function updateScreenShareBitrateKbps(value: number) {
		screenShareBitrateKbps = value;
		setScreenShareBitrateKbps(value > 0 ? value : null);
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

	async function toggleExperimentalStdbCalls() {
		const next = !experimentalStdbCallsEnabled;
		experimentalStdbCallsEnabled = next;
		await setExperimentalStdbCallEnabled(next);
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

	function formatRuntimeTime(timestamp: number | null): string {
		if (!timestamp) return 'never';
		return new Date(timestamp).toLocaleTimeString();
	}

	// Handle theme change
	async function handleThemeChange(themeId: string) {
		try {
			savingTheme = true;
			themeStore.setThemeId(themeId);

			// Check if user is registered
			const isRegistered = !!getAuthToken();

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
		notificationSoundLabel = sound === '/sounds/ProjectSound.ogg'
			? 'ProjectSound.ogg'
			: localStorage.getItem('notificationSoundLabel') || 'Custom sound';
	}

	function updateNotificationVolume(volume: number) {
		notificationVolume = volume;
		localStorage.setItem('notificationVolume', volume.toString());
	}

	function updateCallRingtoneMode(mode: CallRingtoneMode) {
		callRingtoneMode = mode;
		localStorage.setItem('callRingtoneMode', mode);
		callRingtoneLabel = getResolvedCallRingtoneLabel(mode);
		if (mode !== 'custom-synth') {
			callRingtoneSynthEditorExpanded = false;
		}
		stopCallRingtone();
	}

	function updateCallRingtoneVolume(volume: number) {
		callRingtoneVolume = volume;
		localStorage.setItem('callRingtoneVolume', volume.toString());
	}

	function updateCallRingtoneCustomSynthField<K extends keyof CustomSynthRingtonePreset>(
		key: K,
		value: CustomSynthRingtonePreset[K]
	) {
		callRingtoneCustomSynth = sanitizeCustomSynthRingtonePreset({
			...callRingtoneCustomSynth,
			[key]: value
		});
		saveCallRingtoneCustomSynth();
	}

	function testNotificationSound() {
		playNotificationSound();
	}

	function testCallRingtone() {
		if (callRingtonePreviewTimeout !== null) {
			window.clearTimeout(callRingtonePreviewTimeout);
			callRingtonePreviewTimeout = null;
		}
		stopCallRingtone();
		playCallRingtone();
		callRingtonePreviewTimeout = window.setTimeout(() => {
			stopCallRingtone();
			callRingtonePreviewTimeout = null;
		}, 4800);
	}

	function triggerNotificationSoundFilePicker(): void {
		notificationSoundInput?.click();
	}

	function triggerCallRingtoneFilePicker(): void {
		callRingtoneInput?.click();
	}

	function triggerCallRingtoneSynthImportFilePicker(): void {
		callRingtoneSynthImportInput?.click();
	}

	function resetNotificationSoundToDefault(): void {
		notificationSoundLabel = 'ProjectSound.ogg';
		localStorage.removeItem('notificationSoundLabel');
		updateNotificationSound('/sounds/ProjectSound.ogg');
	}

	function resetCallRingtoneToDefault(): void {
		localStorage.removeItem('callRingtoneCustomAudio');
		localStorage.removeItem('callRingtoneLabel');
		callRingtoneCustomSynth = getDefaultCustomSynthRingtonePreset();
		localStorage.setItem('callRingtoneCustomSynth', JSON.stringify(callRingtoneCustomSynth));
		updateCallRingtoneMode('classic-bell');
		callRingtoneLabel = 'Classic Bell';
	}

	function resetCallRingtoneCustomSynth(): void {
		callRingtoneCustomSynth = getDefaultCustomSynthRingtonePreset();
		saveCallRingtoneCustomSynth();
		if (callRingtoneMode !== 'custom-synth') {
			updateCallRingtoneMode('custom-synth');
		}
		callRingtoneSynthEditorExpanded = true;
	}

	function exportCallRingtoneCustomSynth(): void {
		const preset = sanitizeCustomSynthRingtonePreset(callRingtoneCustomSynth);
		const blob = new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a');
		const safeName = (preset.name || 'custom-synth')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/(^-|-$)/g, '') || 'custom-synth';
		link.href = url;
		link.download = `${safeName}-ringtone.json`;
		document.body.appendChild(link);
		link.click();
		document.body.removeChild(link);
		URL.revokeObjectURL(url);
	}

	async function handleNotificationSoundFileSelect(event: Event): Promise<void> {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;

		const isAudioFile = file.type.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|aac)$/i.test(file.name);
		if (!isAudioFile) {
			alert('Please choose an audio file.');
			input.value = '';
			return;
		}
		if (file.size > 1024 * 1024) {
			alert('Custom notification sounds must be 1MB or smaller.');
			input.value = '';
			return;
		}

		try {
			const dataUrl = await new Promise<string>((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(String(reader.result || ''));
				reader.onerror = () => reject(new Error('Failed to read audio file.'));
				reader.readAsDataURL(file);
			});
			if (!dataUrl.startsWith('data:audio')) {
				throw new Error('Unsupported audio encoding.');
			}
			localStorage.setItem('notificationSoundLabel', file.name);
			notificationSoundLabel = file.name;
			updateNotificationSound(dataUrl);
			testNotificationSound();
		} catch (error) {
			alert(error instanceof Error ? error.message : 'Failed to load custom sound.');
		} finally {
			input.value = '';
		}
	}

	async function handleCallRingtoneSynthImportFileSelect(event: Event): Promise<void> {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;

		const isJsonFile = file.type === 'application/json' || /\.json$/i.test(file.name);
		if (!isJsonFile) {
			alert('Please choose a JSON preset file.');
			input.value = '';
			return;
		}

		try {
			const text = await file.text();
			const preset = sanitizeCustomSynthRingtonePreset(JSON.parse(text));
			callRingtoneCustomSynth = preset;
			saveCallRingtoneCustomSynth();
			updateCallRingtoneMode('custom-synth');
			callRingtoneSynthEditorExpanded = true;
			testCallRingtone();
		} catch (error) {
			alert(error instanceof Error ? error.message : 'Failed to import synth preset.');
		} finally {
			input.value = '';
		}
	}

	async function handleCallRingtoneFileSelect(event: Event): Promise<void> {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;

		const isAudioFile = file.type.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|aac)$/i.test(file.name);
		if (!isAudioFile) {
			alert('Please choose an audio file.');
			input.value = '';
			return;
		}
		if (file.size > 1024 * 1024) {
			alert('Custom call ringtones must be 1MB or smaller.');
			input.value = '';
			return;
		}

		try {
			const dataUrl = await new Promise<string>((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(String(reader.result || ''));
				reader.onerror = () => reject(new Error('Failed to read audio file.'));
				reader.readAsDataURL(file);
			});
			if (!dataUrl.startsWith('data:audio')) {
				throw new Error('Unsupported audio encoding.');
			}
			localStorage.setItem('callRingtoneCustomAudio', dataUrl);
			localStorage.setItem('callRingtoneLabel', file.name);
			callRingtoneLabel = file.name;
			updateCallRingtoneMode('custom-audio');
			testCallRingtone();
		} catch (error) {
			alert(error instanceof Error ? error.message : 'Failed to load custom ringtone.');
		} finally {
			input.value = '';
		}
	}

	function updateReverseSearchProvider(value: ReverseImageSearchProvider): void {
		reverseImageSearchProvider = value;
		setReverseImageSearchProvider(value);
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

	function toggleAnimationPass() {
		const next = updateAnimationPassSettings({ enabled: !animationPassEnabled });
		animationPassEnabled = next.enabled;
	}

	function updateAnimationPreset(value: AnimationPassPreset) {
		const next = updateAnimationPassSettings({ preset: value });
		animationPassPreset = next.preset;
	}

	function updateAnimationLevel(value: AnimationPassLevel) {
		const next = updateAnimationPassSettings({ level: value });
		animationPassLevel = next.level;
	}

	function updateAnimationDurationMultiplier(value: number) {
		const next = updateAnimationPassSettings({ durationMultiplier: value });
		animationPassDurationMultiplier = next.durationMultiplier;
	}

	function updateRoleColorMode(mode: RoleColorMode) {
		const next = updateAccessibilitySettings({ roleColorMode: mode });
		roleColorMode = next.roleColorMode;
	}

	function toggleOwnMessagesOnRight() {
		const next = updateAccessibilitySettings({ ownMessagesOnRight: !ownMessagesOnRight });
		ownMessagesOnRight = next.ownMessagesOnRight;
	}

	function updateChatAvatarMode(mode: ChatAvatarMode) {
		const next = updateAccessibilitySettings({ chatAvatarMode: mode });
		chatAvatarMode = next.chatAvatarMode;
	}

	function updateTabShadeStrength(value: number) {
		const next = updateAccessibilitySettings({ tabShadeStrength: value });
		tabShadeStrength = next.tabShadeStrength;
	}

	function updateAppChromeOpacity(value: number) {
		const next = updateAccessibilitySettings({ appChromeOpacity: value });
		appChromeOpacity = next.appChromeOpacity;
	}

	function toggleVideoCompressionEnabled() {
		videoCompressionEnabled = !videoCompressionEnabled;
		setVideoCompressionEnabled(videoCompressionEnabled);
	}

	function updateVideoCompressionPreset(value: VideoCompressionPresetId) {
		defaultVideoCompressionPreset = value;
		setDefaultVideoCompressionPreset(value, videoCompressionRuntime);
	}

	function updateMessageDensity(value: MessageDensity) {
		const next = updateAccessibilitySettings({ messageDensity: value });
		messageDensity = next.messageDensity;
	}

	function updateChatFontScale(value: number) {
		const next = updateAccessibilitySettings({ chatFontScale: value });
		chatFontScale = next.chatFontScale;
	}

	function updateDeletionCountdownMode(mode: DeletionCountdownMode) {
		const next = updateAccessibilitySettings({ deletionCountdownMode: mode });
		deletionCountdownMode = next.deletionCountdownMode;
	}

	function toggleClickableSendEnabled() {
		const next = updateAccessibilitySettings({ clickableSendEnabled: !clickableSendEnabled });
		clickableSendEnabled = next.clickableSendEnabled;
	}

	function resetAccessibilityVisuals() {
		const next = updateAccessibilitySettings({
			colorAssistEnabled: false,
			saturation: 1,
			contrast: 1,
			reducedMotion: false,
			roleColorMode: 'full',
			ownMessagesOnRight: false,
			chatAvatarMode: 'all',
			tabShadeStrength: 0.06,
			appChromeOpacity: 1,
			messageDensity: 'cozy',
			chatFontScale: 1,
			deletionCountdownMode: 'static',
			clickableSendEnabled: true
		});
		colorAssistEnabled = next.colorAssistEnabled;
		saturation = next.saturation;
		contrast = next.contrast;
		reducedMotion = next.reducedMotion;
		roleColorMode = next.roleColorMode;
		ownMessagesOnRight = next.ownMessagesOnRight;
		chatAvatarMode = next.chatAvatarMode;
		tabShadeStrength = next.tabShadeStrength;
		appChromeOpacity = next.appChromeOpacity;
		messageDensity = next.messageDensity;
		chatFontScale = next.chatFontScale;
		deletionCountdownMode = next.deletionCountdownMode;
		clickableSendEnabled = next.clickableSendEnabled;
		const animationReset = updateAnimationPassSettings({
			enabled: true,
			preset: 'slip',
			level: 'balanced',
			durationMultiplier: 1
		});
		animationPassEnabled = animationReset.enabled;
		animationPassPreset = animationReset.preset;
		animationPassLevel = animationReset.level;
		animationPassDurationMultiplier = animationReset.durationMultiplier;
	}

	function updateDockSide(side: 'left' | 'right') {
		layoutStore.setNavDock(side);
	}

	function toggleDockNavCollapsed() {
		layoutStore.toggleNavCollapsed();
	}

	async function updateHomeExperienceMode(mode: HomeExperienceMode) {
		homeExperienceMode = mode;
		setStoredHomeExperienceMode(mode);
		applyHomeExperienceMode(mode);

		const token = getAuthToken();
		if (!token) return;

		try {
			await saveUserSettings(token, { home_experience: mode });
		} catch (error) {
			console.warn('[Settings] Failed to save home experience mode:', error);
		}
	}

	function toggleObviousGrabRails() {
		layoutStore.setObviousGrabRails(!$layoutStore.obviousGrabRails);
	}

	function loadWorkspaceByName(name: string) {
		layoutStore.loadWorkspace(name);
	}

	function saveWorkspaceAsPrompt() {
		const suggested = `${$layoutStore.activeWorkspace}-copy`;
		const name = window.prompt('Save layout as', suggested);
		if (!name) return;
		layoutStore.saveWorkspace(name);
	}

	function renameWorkspacePrompt() {
		const current = $layoutStore.activeWorkspace;
		const nextName = window.prompt('Rename layout', current);
		if (!nextName) return;
		layoutStore.renameWorkspace(current, nextName);
	}

	function resetActiveWorkspace() {
		layoutStore.resetWorkspace($layoutStore.activeWorkspace);
	}

	async function exportWorkspaceJson() {
		const json = layoutStore.exportLayoutJson();
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(json);
			alert('Layout JSON copied to clipboard.');
			return;
		}
		window.prompt('Copy layout JSON:', json);
	}

	function importWorkspaceJsonPrompt() {
		const pasted = window.prompt('Paste layout JSON');
		if (!pasted) return;
		const ok = layoutStore.importLayoutJson(pasted);
		if (!ok) {
			alert('Invalid layout JSON.');
		}
	}

	function toAddonNameFromComponentFile(fileName: string): string {
		return fileName
			.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
			.replace(/[-_]/g, ' ')
			.trim();
	}

	function getBuiltinAddonMeta(fileName: string): { id: string; name: string } | null {
		if (fileName === 'ModelViewer3D') {
			return {
				id: 'model-viewer',
				name: 'Model Viewer 3D'
			};
		}
		return null;
	}

	function detectFrontendAddons(): DetectedAddon[] {
		const keys = Object.keys(frontendAddonModules);
		if (keys.length === 0) return [];

		const addons = keys.map((path) => {
			const fileName = path.split('/').pop()?.replace('.svelte', '') || path;
			const builtinMeta = getBuiltinAddonMeta(fileName);
			const addonId =
				builtinMeta?.id ||
				fileName
					.replace(/([a-z0-9])([A-Z])/g, '$1-$2')
					.replace(/[_\s]+/g, '-')
					.toLowerCase();
			return {
				id: addonId,
				name: builtinMeta?.name || toAddonNameFromComponentFile(fileName),
				version: 'local',
				source: path,
				side: 'frontend' as const
			};
		});

		return addons.sort((a, b) => a.name.localeCompare(b.name));
	}

	function mergeFrontendAddonLists(
		primary: DetectedAddon[],
		secondary: DetectedAddon[]
	): DetectedAddon[] {
		const merged = new Map<string, DetectedAddon>();
		for (const addon of secondary) {
			merged.set(addon.id, addon);
		}
		for (const addon of primary) {
			merged.set(addon.id, addon);
		}
		return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	async function fetchPluginInventory(): Promise<PluginApiRecord[] | null> {
		const token = getAuthToken();

		try {
			const response = await fetch(`${getServerUrl()}/api/plugins`, {
				headers: token ? { Authorization: `Bearer ${token}` } : undefined
			});
			if (!response.ok) return null;
			const payload = await response.json();
			return Array.isArray(payload?.plugins) ? payload.plugins : [];
		} catch (error) {
			console.warn('[Addons] Failed to detect backend add-ons:', error);
			return null;
		}
	}

	async function refreshAddonDetection(): Promise<void> {
		addonsLoading = true;
		try {
			const localFrontendAddons = detectFrontendAddons();
			const plugins = await fetchPluginInventory();
			if (plugins) {
				const pluginFrontendAddons = plugins
					.filter((plugin) => Boolean(plugin.hasFrontend || plugin.frontendEntry))
					.map((plugin) => ({
						id: String(plugin.id || 'unknown'),
						name: String(plugin.name || plugin.id || 'Unknown Plugin'),
						version: String(plugin.version || 'unknown'),
						source: String(plugin.frontendEntry || 'plugin-manifest'),
						side: 'frontend' as const
					}));
				frontendAddons = mergeFrontendAddonLists(pluginFrontendAddons, localFrontendAddons);
				backendAddons = plugins
					.filter((plugin) => Boolean(plugin.hasBackend || plugin.backendEntry))
					.map((plugin) => ({
						id: String(plugin.id || 'unknown'),
						name: String(plugin.name || plugin.id || 'Unknown Plugin'),
						version: String(plugin.version || 'unknown'),
						source: plugin.signerKeyId ? `signer:${plugin.signerKeyId}` : String(plugin.backendEntry || 'plugin-manifest'),
						side: 'backend' as const
					}))
					.sort((a, b) => a.name.localeCompare(b.name));
			} else {
				frontendAddons = localFrontendAddons;
				backendAddons = [];
			}
			addonsLastDetectedAt = new Date().toLocaleString();
		} finally {
			addonsLoading = false;
		}
	}

	function exportAddonManifest(): void {
		const data = {
			exportedAt: new Date().toISOString(),
			frontend: frontendAddons,
			backend: backendAddons
		};
		const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `wabi-addons-manifest-${Date.now()}.json`;
		a.click();
		URL.revokeObjectURL(url);
	}

	function triggerAddonImport(): void {
		addonsImportInput?.click();
	}

	function triggerAddonPackageInstall(): void {
		addonsPackageInput?.click();
	}

	function loadTranslatorAddonSettings(): void {
		try {
			const raw = localStorage.getItem(TRANSLATOR_SETTINGS_KEY);
			if (!raw) return;
			const parsed = JSON.parse(raw);
			const parsedModel = typeof parsed?.model === 'string' ? parsed.model : '';
			if (parsedModel === 'libretranslate-local' || parsedModel === 'libretranslate-public') {
				translatorModel = parsedModel;
			} else {
				const providerUrl = typeof parsed?.providerUrl === 'string' ? parsed.providerUrl.trim() : '';
				if (providerUrl === 'https://libretranslate.com/translate') {
					translatorModel = 'libretranslate-public';
				} else {
					translatorModel = 'libretranslate-local';
				}
			}
			translatorTargetLang = typeof parsed?.targetLang === 'string' ? parsed.targetLang : 'en';
		} catch {
			// Ignore malformed local settings
		}
	}

	function saveTranslatorAddonSettings(): void {
		const selectedModel = TRANSLATOR_MODEL_OPTIONS.find((option) => option.id === translatorModel) || TRANSLATOR_MODEL_OPTIONS[0];
		const payload = {
			mode: 'on-demand',
			model: selectedModel.id,
			providerUrl: selectedModel.providerUrl,
			sourceLang: 'auto',
			targetLang: translatorTargetLang.trim() || 'en',
			useProxy: true
		};
		localStorage.setItem(TRANSLATOR_SETTINGS_KEY, JSON.stringify(payload));
		translatorSettingsSavedAt = new Date().toLocaleTimeString();
	}

	function addChatAliasFromDraft(): void {
		const trigger = chatAliasTriggerDraft.trim();
		const replacement = chatAliasReplacementDraft.trim();
		if (!trigger || !replacement) return;
		addChatAlias(trigger, replacement);
		chatAliasTriggerDraft = '';
		chatAliasReplacementDraft = '';
	}

	function toggleChatAliasEnabled(alias: ChatAliasEntry): void {
		updateChatAlias(alias.id, { enabled: !alias.enabled });
	}

	function editChatAlias(alias: ChatAliasEntry): void {
		const nextReplacement = window.prompt(`Edit replacement for ${alias.trigger}`, alias.replacement);
		if (nextReplacement === null) return;
		if (!nextReplacement.trim()) return;
		updateChatAlias(alias.id, { replacement: nextReplacement.trim() });
	}

	function toggleChatFilterEnabled(): void {
		setChatFilterSettings({ enabled: !$chatFilterStore.enabled });
	}

	function updateChatFilterMode(mode: ChatFilterMode): void {
		setChatFilterSettings({ mode });
	}

	function toggleChatFilterIncoming(): void {
		setChatFilterSettings({ applyToIncoming: !$chatFilterStore.applyToIncoming });
	}

	function toggleChatFilterOutgoing(): void {
		setChatFilterSettings({ applyToOutgoing: !$chatFilterStore.applyToOutgoing });
	}

	function updateChatFilterReplacement(value: string): void {
		setChatFilterSettings({ replacement: value });
	}

	function editChatFilterTerms(): void {
		const current = $chatFilterStore.terms.join(', ');
		const raw = window.prompt('Blocked terms (comma-separated)', current);
		if (raw === null) return;
		const terms = raw
			.split(',')
			.map((term) => term.trim())
			.filter(Boolean);
		setChatFilterSettings({ terms });
	}

	function saveQuoteTemplate(): void {
		setCustomQuoteTemplate(quoteTemplateDraft);
		quoteTemplateDraft = get(customQuoteSettingsStore).template;
	}

	function resetQuoteTemplateFromSettings(): void {
		resetCustomQuoteTemplate();
		quoteTemplateDraft = get(customQuoteSettingsStore).template;
	}

	function toggleSpellCheckAddon(): void {
		setSpellCheckEnabled(!spellCheckEnabled);
	}

	function toggleCharCounterAddon(): void {
		setCharCounterEnabled(!charCounterEnabled);
	}

	function toggleSplitLargeMessagesAddon(): void {
		setSplitLargeMessagesEnabled(!splitLargeMessagesEnabled);
	}

	function updateSplitLargeMessagesChunkSize(rawValue: string): void {
		const parsed = Number.parseInt(rawValue, 10);
		if (!Number.isFinite(parsed)) return;
		setSplitLargeMessagesChunkSize(parsed);
	}

	function toggleWriteUpperCaseAddon(): void {
		setWriteUpperCaseEnabled(!writeUpperCaseEnabled);
	}

	function toggleClickableMentionsAddon(): void {
		setClickableMentionsEnabled(!clickableMentionsEnabled);
	}

	function updateTimestampDisplayMode(mode: string): void {
		if (mode === 'compact' || mode === 'complete' || mode === 'detailed') {
			setTimestampDisplayMode(mode as TimestampDisplayMode);
		}
	}

	function toggleRevealAllSpoilersAddon(): void {
		setRevealAllSpoilersEnabled(!revealAllSpoilersEnabled);
	}

	function updateRevealAllSpoilersRole(role: string): void {
		if (role === 'guest' || role === 'member' || role === 'mod' || role === 'admin' || role === 'owner') {
			setRevealAllSpoilersMinRole(role as RevealAllSpoilersMinRole);
		}
	}

	function toggleBetterSearchPageAddon(): void {
		setBetterSearchPageEnabled(!betterSearchPageEnabled);
	}

	function toggleGoogleSearchReplaceAddon(): void {
		setGoogleSearchReplaceEnabled(!googleSearchReplaceEnabled);
	}

	function updateSearchEngineProvider(value: string): void {
		if (
			value === 'google' ||
			value === 'duckduckgo' ||
			value === 'bing' ||
			value === 'brave' ||
			value === 'startpage' ||
			value === 'custom'
		) {
			searchEngineProvider = value as SearchEngineProvider;
			setSearchEngineProvider(searchEngineProvider);
		}
	}

	function saveCustomSearchEngineTemplateFromSettings(): void {
		const saved = setCustomSearchEngineTemplate(searchEngineCustomTemplate);
		if (!saved) {
			alert(
				'Custom search template must include {query} and use an http(s) URL. Example: https://search.brave.com/search?q={query}'
			);
			searchEngineCustomTemplate = getCustomSearchEngineTemplate();
			return;
		}
		searchEngineCustomTemplate = getCustomSearchEngineTemplate();
	}

	function toggleHideMutedCategoriesAddon(): void {
		setHideMutedCategoriesEnabled(!hideMutedCategoriesEnabled);
	}

	function clearMutedChannelsAddon(): void {
		if (!window.confirm('Clear all locally muted channels?')) return;
		clearMutedChannelIds();
	}

	function toggleReadAllNotificationsButtonAddon(): void {
		setReadAllNotificationsButtonEnabled(!readAllNotificationsButtonEnabled);
	}

	function toggleSpotifyControlsAddon(): void {
		setSpotifyControlsEnabled(!spotifyControlsEnabled);
	}

	function toggleLocalNicknamesAddon(): void {
		setLocalNicknamesEnabled(!localNicknamesEnabled);
	}

	function clearAllLocalNicknamesAddon(): void {
		if (!window.confirm('Clear all local nicknames on this device?')) return;
		clearAllLocalNicknames();
	}

	function toggleServerCounterAddon(): void {
		setServerCounterEnabled(!serverCounterEnabled);
	}

	function toggleBetterNsfwTagAddon(): void {
		setBetterNsfwTagEnabled(!betterNsfwTagEnabled);
	}

	function toggleCustomStatusPresetsAddon(): void {
		setCustomStatusPresetsEnabled(!customStatusPresetsEnabled);
	}

	function addCustomStatusPresetFromSettings(): void {
		const label = customStatusPresetLabelDraft.trim();
		if (!label) {
			customStatusPresetsStatus = 'Preset label is required.';
			return;
		}
		const added = addCustomStatusPreset(
			label,
			customStatusPresetPresenceDraft,
			customStatusPresetNoteDraft
		);
		if (!added) {
			customStatusPresetsStatus = `Could not add preset. Limit: ${MAX_CUSTOM_STATUS_PRESETS} presets.`;
			return;
		}
		customStatusPresetLabelDraft = '';
		customStatusPresetNoteDraft = '';
		customStatusPresetPresenceDraft = 'active';
		customStatusPresetsStatus = 'Status preset added.';
	}

	function removeCustomStatusPresetFromSettings(presetId: string): void {
		removeCustomStatusPreset(presetId);
		customStatusPresetsStatus = '';
	}

	function activateCustomStatusPresetFromSettings(
		presetId: string,
		status: CustomStatusPresetPresence
	): void {
		setActiveCustomStatusPreset(presetId);
		updateProfile(status, undefined, undefined);
		customStatusPresetsStatus = 'Status preset applied.';
	}

	function resetCustomStatusPresetsAddon(): void {
		const confirmed = window.confirm('Reset status presets to defaults?');
		if (!confirmed) return;
		resetCustomStatusPresetsToDefaults();
		customStatusPresetsStatus = 'Status presets reset.';
	}

	function toggleQuickMentionAddon(): void {
		setQuickMentionEnabled(!quickMentionEnabled);
	}

	function togglePersonalPinsAddon(): void {
		setPersonalPinsEnabled(!personalPinsEnabled);
	}

	function clearPersonalPinsAddon(): void {
		if (!window.confirm('Clear all local personal pins?')) return;
		clearAllPersonalPins();
	}

	function toggleLastMessageDateAddon(): void {
		setLastMessageDateEnabled(!lastMessageDateEnabled);
	}

	function toggleShowConnectionsAddon(): void {
		setShowConnectionsEnabled(!showConnectionsEnabled);
	}

	function toggleUserNotesAddon(): void {
		setUserNotesEnabled(!userNotesEnabled);
	}

	function toggleFriendNotificationsAddon(): void {
		setFriendNotificationsEnabled(!friendNotificationsEnabled);
	}

	function toggleFriendNotificationsTrackedOnlyAddon(): void {
		setFriendNotificationsTrackedOnly(!friendNotificationsTrackedOnly);
	}

	function clearFriendNotificationTrackedUsers(): void {
		if (!window.confirm('Clear all tracked people for status alerts on this device?')) return;
		clearAllTrackedPersonStatusAlerts();
	}

	function toggleMessageUtilitiesAddon(): void {
		setMessageUtilitiesEnabled(!messageUtilitiesEnabled);
	}

	function toggleBetterFriendListAddon(): void {
		setBetterFriendListEnabled(!betterFriendListEnabled);
	}

	function toggleEmojiStatisticsAddon(): void {
		setEmojiStatisticsEnabled(!emojiStatisticsEnabled);
	}

	function toggleRemoveNicknamesAddon(): void {
		setRemoveNicknamesEnabled(!removeNicknamesEnabled);
	}

	function toggleStaffTagAddon(): void {
		setStaffTagEnabled(!staffTagEnabled);
	}

	function toggleTopRoleEverywhereAddon(): void {
		setTopRoleEverywhereEnabled(!topRoleEverywhereEnabled);
	}

	function toggleTimedThemeModeAddon(): void {
		setTimedThemeModeEnabled(!timedThemeModeEnabled);
	}

	function updateTimedThemeDayStartHour(rawValue: string): void {
		const parsed = Number.parseInt(rawValue, 10);
		if (!Number.isFinite(parsed)) return;
		setTimedThemeModeDayStartHour(parsed);
	}

	function updateTimedThemeNightStartHour(rawValue: string): void {
		const parsed = Number.parseInt(rawValue, 10);
		if (!Number.isFinite(parsed)) return;
		setTimedThemeModeNightStartHour(parsed);
	}

	function updateTimedThemeLightTheme(themeId: string): void {
		setTimedThemeModeLightThemeId(themeId);
	}

	function updateTimedThemeDarkTheme(themeId: string): void {
		setTimedThemeModeDarkThemeId(themeId);
	}

	function toggleUnicodeEmojisAddon(): void {
		setUnicodeEmojiConversionEnabled(!unicodeEmojisEnabled);
		unicodeEmojisPrefsStatus = '';
	}

	function toggleUnicodeDefaultSource(): void {
		setUnicodeEmojiDefaultSourceEnabled(!unicodeConvertDefaultEnabled);
		unicodeEmojisPrefsStatus = '';
	}

	function toggleUnicodeOpenmojiSource(): void {
		setUnicodeEmojiOpenmojiSourceEnabled(!unicodeConvertOpenmojiEnabled);
		unicodeEmojisPrefsStatus = '';
	}

	function resetUnicodeEmojisTelemetry(): void {
		const telemetryTotal =
			$unicodeEmojiTelemetryStore.convertedTokens +
			$unicodeEmojiTelemetryStore.unknownTokens +
			$unicodeEmojiTelemetryStore.shortcodeCollisions;
		if (telemetryTotal === 0) return;
		const confirmed = window.confirm('Reset UnicodeEmojis conversion counters?');
		if (!confirmed) return;
		resetUnicodeEmojiTelemetry();
	}

	async function exportUnicodeEmojisPrefs(): Promise<void> {
		try {
			const payload = exportUnicodeEmojiPreferences(false);
			if (navigator?.clipboard?.writeText) {
				await navigator.clipboard.writeText(payload);
				unicodeEmojisPrefsStatus = 'UnicodeEmojis preferences copied to clipboard.';
				return;
			}
			window.prompt('Copy UnicodeEmojis preferences JSON:', payload);
			unicodeEmojisPrefsStatus = 'UnicodeEmojis preferences ready to copy.';
		} catch (error) {
			unicodeEmojisPrefsStatus =
				error instanceof Error ? error.message : 'Failed to export UnicodeEmojis preferences.';
		}
	}

	function importUnicodeEmojisPrefs(): void {
		const raw = window.prompt('Paste UnicodeEmojis preferences JSON:');
		if (!raw || !raw.trim()) return;
		try {
			const result = importUnicodeEmojiPreferences(raw);
			unicodeEmojisPrefsStatus = result.telemetryImported
				? 'UnicodeEmojis settings and local counters imported.'
				: 'UnicodeEmojis settings imported.';
		} catch (error) {
			unicodeEmojisPrefsStatus =
				error instanceof Error ? error.message : 'Invalid UnicodeEmojis preferences JSON.';
		}
	}

	function toggleGifCaptionerAddon(): void {
		setGifCaptionerEnabled(!gifCaptionerEnabled);
	}

	function toggleGifCaptionerDedicatedField(): void {
		setGifCaptionerDedicatedCaptionFieldEnabled(!gifCaptionerDedicatedFieldEnabled);
	}

	function updateGifCaptionerStyle(style: string): void {
		if (style === 'plain' || style === 'accent' || style === 'card') {
			setGifCaptionerCaptionStyle(style);
		}
	}

	function toggleZipPreviewAddon(): void {
		setZipPreviewEnabled(!zipPreviewEnabled);
	}

	function toggleZipPreviewInlineAddon(): void {
		setZipPreviewInlinePreviewEnabled(!zipPreviewInlineEnabled);
	}

	function toggleMoreQuickReactsAddon(): void {
		setQuickReactionsEnabled(!quickReactionsEnabled);
		quickReactionSettingsStatus = '';
	}

	function addCustomQuickReactionEmoji(): void {
		const emojiId = quickReactionCustomEmojiIdDraft.trim();
		if (!emojiId) return;
		if (!$emojis.some((emoji) => emoji.id === emojiId)) {
			quickReactionSettingsStatus = 'Selected emoji is no longer available.';
			return;
		}
		const alreadyAdded = $quickReactionSettingsStore.customEmojiIds.includes(emojiId);
		const added = addQuickReactionCustomEmojiId(emojiId);
		if (added) {
			quickReactionSettingsStatus = 'Custom quick reaction added.';
			quickReactionCustomEmojiIdDraft = '';
			return;
		}
		quickReactionSettingsStatus = alreadyAdded
			? 'Emoji already exists in your custom quick-reaction set.'
			: `Custom quick-reaction set is capped at ${MAX_CUSTOM_QUICK_REACTION_EMOJIS} emojis.`;
	}

	function removeCustomQuickReactionEmoji(emojiId: string): void {
		removeQuickReactionCustomEmojiId(emojiId);
		quickReactionSettingsStatus = '';
	}

	function clearCustomQuickReactionEmojis(): void {
		if ($quickReactionSettingsStore.customEmojiIds.length === 0) return;
		const confirmed = window.confirm('Clear all custom quick-reaction emojis?');
		if (!confirmed) return;
		clearQuickReactionCustomEmojiIds();
		quickReactionSettingsStatus = '';
	}

	function resetMoreQuickReactsTelemetry(): void {
		if ($quickReactionTelemetryStore.quickStripClicks + $quickReactionTelemetryStore.pickerOpens === 0) return;
		const confirmed = window.confirm('Reset MoreQuickReacts usage counters?');
		if (!confirmed) return;
		resetQuickReactionTelemetry();
	}

	function formatQuickReactionShare(value: number | null): string {
		if (value === null) return 'n/a';
		return `${Math.round(value * 100)}%`;
	}

	function clearAllPinnedDmConversations(): void {
		if (pinnedDmConversationCount === 0) return;
		const confirmed = window.confirm('Clear all pinned DM conversations?');
		if (!confirmed) return;
		clearPinnedDms();
	}

	async function importAddonManifest(event: Event): Promise<void> {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		try {
			const raw = await file.text();
			const parsed = JSON.parse(raw);
			addonsImportPreview = {
				importedAt: parsed?.exportedAt,
				frontend: Array.isArray(parsed?.frontend) ? parsed.frontend : [],
				backend: Array.isArray(parsed?.backend) ? parsed.backend : []
			};
		} catch {
			alert('Invalid add-ons manifest JSON file.');
		} finally {
			input.value = '';
		}
	}

	async function installAddonPackage(event: Event): Promise<void> {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;

		const token = getAuthToken();
		if (!token) {
			alert('Please log in with an admin account to install plugins.');
			input.value = '';
			return;
		}

		const lowerName = file.name.toLowerCase();
		if (!lowerName.endsWith('.zip') && !lowerName.endsWith('.wabi-plugin') && !lowerName.endsWith('.wabip')) {
			alert('Please select a .zip, .wabi-plugin, or .wabip file.');
			input.value = '';
			return;
		}

		const formData = new FormData();
		formData.append('pluginPackage', file);

		addonInstallLoading = true;
		addonInstallStatus = `Installing ${file.name}...`;
		try {
			const response = await fetch(`${getServerUrl()}/api/plugins/install`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${token}` },
				body: formData
			});

			const payload = await response.json().catch(() => ({}));
			if (!response.ok || !payload?.success) {
				throw new Error(String(payload?.error || 'Plugin install failed'));
			}

			const pluginName = String(payload?.plugin?.name || payload?.plugin?.pluginId || 'plugin');
			const pluginVersion = String(payload?.plugin?.version || 'unknown');
			addonInstallStatus = `Installed ${pluginName} (v${pluginVersion}).`;
			await refreshAddonDetection();
			loadTranslatorAddonSettings();
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Plugin install failed';
			addonInstallStatus = `Install failed: ${message}`;
			alert(`Plugin install failed: ${message}`);
		} finally {
			addonInstallLoading = false;
			input.value = '';
		}
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
		clearAuthSession();
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
			const authToken = getAuthToken();
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
			const authToken = getAuthToken();
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
			const authToken = getAuthToken();
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
				// Clear browser archive storage so old messages cannot rehydrate on reload.
				await chatStorage.clearAllHistory();

				// Also clear local in-memory messages for every known channel key
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
				try {
					localStorage.removeItem('channelUnreadCounts');
					localStorage.removeItem('unreadCount');
					localStorage.removeItem('lastReadMessageId');
				} catch {
					// ignore localStorage failures
				}
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
			const uploadedProfilePictureUrl = await uploadProfilePictureFile(selectedAvatarFile);
			updateProfile(undefined, uploadedProfilePictureUrl);
			alert('Profile picture updated successfully!');
		} catch (error) {
			console.error('Error uploading profile picture:', error);
			alert(error instanceof Error ? error.message : 'Failed to upload profile picture. Please try again.');
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

	function makeCurrentLocalWabiDefault(): void {
		if (!currentLocalWabiAccountKey) return;
		setDefaultLocalWabiAccount(currentLocalWabiAccountKey);
		linkedWabiImportStatus = 'This account is now the default local Wabi profile source on this device.';
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
				{$t('settings.title')}
			</h2>
				<div class="header-actions">
					<label for="settings-locale" class="header-locale-label">{$t('settings.language')}</label>
					<select
						id="settings-locale"
						class="header-locale-select"
						bind:value={selectedLocale}
						on:change={(event) => setAppLocale((event.currentTarget as HTMLSelectElement).value)}
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
					<button class="settings-tab" class:active={activeSettingsTab === 'profile'} on:click={() => activeSettingsTab = 'profile'}>{$t('settings.tabs.profile')}</button>
					<button class="settings-tab" class:active={activeSettingsTab === 'audio'} on:click={() => activeSettingsTab = 'audio'}>{$t('settings.tabs.audio')}</button>
					<button class="settings-tab" class:active={activeSettingsTab === 'notifications'} on:click={() => activeSettingsTab = 'notifications'}>{$t('settings.tabs.notifications')}</button>
					<button class="settings-tab" class:active={activeSettingsTab === 'accessibility'} on:click={() => activeSettingsTab = 'accessibility'}>{$t('settings.tabs.accessibility')}</button>
					<button class="settings-tab" class:active={activeSettingsTab === 'appearance'} on:click={() => activeSettingsTab = 'appearance'}>{$t('settings.tabs.appearance')}</button>
					<button class="settings-tab" class:active={activeSettingsTab === 'server'} on:click={() => activeSettingsTab = 'server'}>{$t('settings.tabs.server')}</button>
					<button class="settings-tab" class:active={activeSettingsTab === 'addons'} on:click={() => activeSettingsTab = 'addons'}>{$t('settings.tabs.addons')}</button>
					<button class="settings-tab" class:active={activeSettingsTab === 'emojis'} on:click={() => activeSettingsTab = 'emojis'}>{$t('settings.tabs.emojis')}</button>
					<button class="settings-tab" class:active={activeSettingsTab === 'storage'} on:click={() => activeSettingsTab = 'storage'}>{$t('settings.tabs.storage')}</button>
					{#if canManageAdmin}
						<button class="settings-tab" class:active={activeSettingsTab === 'admin'} on:click={() => activeSettingsTab = 'admin'}>{$t('settings.tabs.admin')}</button>
					{/if}
					<button class="settings-tab" class:active={activeSettingsTab === 'about'} on:click={() => activeSettingsTab = 'about'}>{$t('settings.tabs.about')}</button>
					<div class="settings-tabs-spacer"></div>
					<button class="settings-tab logout-tab" on:click={handleLogout}>{$t('settings.tabs.logout')}</button>
				</div>

				<div class="settings-content">
					{#if activeSettingsTab === 'profile'}
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
								<h3>Multi-Wabi Account Import</h3>
								<div class="setting-item-full">
									<div class="setting-info">
										<span class="setting-label">Default Local Wabi Account</span>
										<span class="setting-description">Choose which locally linked Wabi account should be treated as your default source profile on this device.</span>
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
										<span class="setting-label">Import Profile From Another Local Wabi Account</span>
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
											No other registered Wabi accounts have been seen on this device yet.
										</div>
									{/if}
									{#if linkedWabiImportStatus}
										<div class="runtime-note">{linkedWabiImportStatus}</div>
									{/if}
								</div>
							</div>
						{/if}
						{#if $currentUser?.dbUserId}
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
								<button class="pfp-upload-btn" on:click={openPaymentHistory} disabled={!$currentUser?.dbUserId}>
									{$currentUser?.dbUserId ? 'View History' : 'Sign In Required'}
								</button>
							</div>
							<div class="setting-item-full">
								<div class="setting-info">
									<span class="setting-label">Saved Payment References</span>
									<span class="setting-description">Save non-sensitive payment references for providers this server already exposes, so Wabi can reuse them when you make or request payment.</span>
								</div>
								<button class="pfp-upload-btn" on:click={openPaymentConnections} disabled={!$currentUser?.dbUserId}>
									{$currentUser?.dbUserId ? 'Manage References' : 'Sign In Required'}
								</button>
							</div>
							<div class="setting-item-full">
								<div class="setting-info">
									<span class="setting-label">Support This Server</span>
									<span class="setting-description">View donation totals and contribute through the server's configured donation route.</span>
								</div>
								<button class="pfp-upload-btn" on:click={openServerDonation}>
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
							<h3>{$t('settings.sections.audio')}</h3>
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
									{cameraEnabled ? $t('common.on') : $t('common.off')}
								</button>
							</div>
							{#if audioInputDevices.length > 0}
							<div class="quality-mode-row">
								<label for="mic-device-select">Microphone Device</label>
								<select
									id="mic-device-select"
									class="theme-select"
									value={selectedMicDeviceId}
									on:change={(e) => handleMicDeviceChange(e.currentTarget.value)}
								>
									<option value="">System Default</option>
									{#each audioInputDevices as device}
										<option value={device.deviceId}>{device.label || `Microphone ${device.deviceId.slice(0, 8)}`}</option>
									{/each}
								</select>
							</div>
						{/if}
						{#if videoInputDevices.length > 0}
							<div class="quality-mode-row">
								<label for="camera-device-select">Camera Device</label>
								<select
									id="camera-device-select"
									class="theme-select"
									value={selectedCameraDeviceId}
									on:change={(e) => handleCameraDeviceChange(e.currentTarget.value)}
								>
									<option value="">System Default</option>
									{#each videoInputDevices as device}
										<option value={device.deviceId}>{device.label || `Camera ${device.deviceId.slice(0, 8)}`}</option>
									{/each}
								</select>
							</div>
						{/if}

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
								<div class="runtime-note">
									Spatial sources: <strong>{$spatialAudioDiagnostics.totalSources}</strong>
									(call {$spatialAudioDiagnostics.callSources}, share {$spatialAudioDiagnostics.shareSources})
								</div>
								<div class="runtime-note">
									Spatial seats: call {$spatialAudioDiagnostics.callSeatSlots}, share {$spatialAudioDiagnostics.shareSeatSlots}
									. Last sync {formatRuntimeTime($spatialAudioDiagnostics.lastUpdatedAt)}.
								</div>
								<div class="runtime-note">
									Transport runtime: <strong>{$callTransportState.activeTransport.toUpperCase()}</strong>
									(control plane {$callTransportState.gatewayControlPlaneStatus})
								</div>

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
										<option value="source-unbounded">Source (Unbounded Bitrate)</option>
										<option value="720p">720p</option>
										<option value="480p">480p</option>
										<option value="144p-mobile">144p (Mobile / Low data)</option>
									</select>
								</div>

								<div class="quality-mode-row">
									<label for="screen-share-bitrate-kbps">Screen Share Bitrate (kbps)</label>
									<input
										id="screen-share-bitrate-kbps"
										class="theme-select"
										type="number"
										min="0"
										max="200000"
										step="250"
										value={screenShareBitrateKbps}
										on:change={(e) => updateScreenShareBitrateKbps(parseInt(e.currentTarget.value || '0', 10) || 0)}
									/>
									<div class="runtime-note">Set `0` to use preset bitrate behavior. Any value above `0` is applied directly.</div>
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
									<div class="runtime-note">
										Channel voice calls can use SFU when configured. Direct DM calls currently stay on WebRTC P2P/TURN.
									</div>
									{#if mediaRuntimeSnapshot && !mediaRuntimeSnapshot.media?.turn?.configured}
										<div class="runtime-note">
											TURN relay is not configured on this server right now. DM calls can fail across NAT, mobile, and home-network boundaries.
										</div>
									{/if}
									{#if mediaRuntimeSnapshot?.media?.boosterRelay}
										<div class="runtime-note">
											Server booster relay: requested {getBoosterRelayModeLabel(boosterRelayRequestedMode)}, effective {getBoosterRelayModeLabel(boosterRelayEffectiveMode)}.
										</div>
										<div class="runtime-note">{getBoosterRelayComponentsSummary(mediaRuntimeSnapshot)}</div>
										<div class="runtime-note">{getBoosterRelaySelfAdvertisementSummary(mediaRuntimeSnapshot)}</div>
										{#if mediaRuntimeSnapshot.media.boosterRelay.selfAdvertisement?.reason}
											<div class="runtime-note">
												{mediaRuntimeSnapshot.media.boosterRelay.selfAdvertisement.reason}
											</div>
										{/if}
										{#if boosterRelayRequestedMode !== 'off' && boosterRelayRequestedMode !== boosterRelayEffectiveMode}
											<div class="runtime-note">
												The deployment is asking for a heavier server-side relay mode than this runtime currently exposes. Start the matching compose profiles on the server machine.
											</div>
										{/if}
									{/if}
								</div>

								<div class="quality-mode-row">
									<label for="call-mute-behavior">Call Mute Behavior</label>
									<select
										id="call-mute-behavior"
										class="theme-select"
										value={callMuteBehavior}
										on:change={(e) => updateCallMuteBehavior(e.currentTarget.value as CallMuteBehavior)}
									>
										<option value="mute-local-input">Mute outbound + local recording (Default)</option>
										<option value="outbound-only">Mute outbound only</option>
									</select>
									<div class="runtime-note">
										Mute outbound only keeps your mic in local call recordings for VTuber/avatar workflows while still silencing what other participants hear.
									</div>
								</div>

								<div class="quality-mode-row">
									<label for="call-recording-stem-mode">Recording Outputs</label>
									<select
										id="call-recording-stem-mode"
										class="theme-select"
										value={callRecordingStemMode}
										on:change={(e) => updateCallRecordingStemMode(e.currentTarget.value as CallRecordingStemMode)}
									>
										<option value="mixed-only">Mixed recording only (Default)</option>
										<option value="mixed-plus-mic">Mixed + mic stem</option>
										<option value="mixed-plus-all-audio">Mixed + all live audio stems</option>
									</select>
									<div class="runtime-note">
										Extra stems add CPU load, file size, and save time. All-stems mode exports separate audio files for your mic and each live remote/share audio source that appears during the recording.
									</div>
								</div>

								<div class="setting-item">
									<div class="setting-info">
										<span class="setting-label">Experimental SpaceChatDB STDB Calls</span>
										<span class="setting-description">Desktop-only experimental path for DM/group calls. Channel voice calls stay on standard routing.</span>
									</div>
									<button
										class="toggle-btn"
										class:active={experimentalStdbCallsEnabled}
										on:click={toggleExperimentalStdbCalls}
										disabled={!desktopLocalAppRuntime}
										title="Experimental desktop STDB routing for DM/group calls only"
									>
										{experimentalStdbCallsEnabled ? 'ON' : 'OFF'}
									</button>
								</div>

								<div class="setting-item">
									<div class="setting-info">
										<span class="setting-label">SRT Gateway</span>
										<span class="setting-description">Requires Local App + self-hosted media gateway with worker mode enabled. Browser-only calls do not use SRT directly.</span>
									</div>
									<button class="toggle-btn" class:active={srtGatewayEnabled} on:click={toggleSrtGateway} disabled={!localAppRuntime}>
										{srtGatewayEnabled ? 'ON' : 'OFF'}
									</button>
								</div>

								{#if desktopLocalAppRuntime}
									<div class="upload-limits-panel">
										<h4>Desktop Helper Profile</h4>
										<p class="admin-help">Pick the human-readable name this desktop should use before helper activation is turned on. This avoids exposing raw machine hostnames later.</p>
										<div class="quality-mode-row">
											<label for="desktop-helper-name">Helper Name</label>
											<input
												id="desktop-helper-name"
												class="emoji-name-input"
												maxlength="120"
												placeholder="Will Laptop"
												bind:value={desktopHelperProfileName}
											/>
										</div>
										<div class="quality-mode-row">
											<label for="desktop-helper-mode">Helper Mode</label>
											<select
												id="desktop-helper-mode"
												class="theme-select"
												bind:value={desktopHelperProfileMode}
											>
												<option value="off">Off</option>
												<option value="files-only">Files Only</option>
												<option value="desktop-assist">Desktop Assist</option>
											</select>
										</div>
										<button class="action-btn" on:click={saveDesktopHelperProfile}>
											Save Helper Profile
										</button>
										{#if desktopHelperProfileStatus}
											<p class="admin-help">{desktopHelperProfileStatus}</p>
										{/if}
									</div>
								{/if}

								{#if !localAppRuntime && browser}
									<p class="runtime-note">Tip: install the Local App (Tauri) to unlock enhanced call quality mode.</p>
								{/if}
							</div>
						</div>

					{:else if activeSettingsTab === 'notifications'}
						<div class="settings-section">
							<h3>{$t('settings.sections.notifications')}</h3>
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

							<div class="setting-item">
								<div class="setting-info">
									<span class="setting-label">Show Message Preview</span>
									<span class="setting-description">If off, desktop notifications use a generic "New message" body.</span>
								</div>
								<button class="toggle-btn" class:active={notificationPreviewEnabled} on:click={toggleNotificationPreview}>
									{notificationPreviewEnabled ? 'ON' : 'OFF'}
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
									<button
										class="sound-option"
										class:active={notificationSound.startsWith('data:audio')}
										on:click={triggerNotificationSoundFilePicker}
									>
										Upload Custom Sound
									</button>
								</div>
								<input
									type="file"
									accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac"
									bind:this={notificationSoundInput}
									on:change={handleNotificationSoundFileSelect}
									style="display: none;"
								/>
								<div class="runtime-note">Active sound: {notificationSoundLabel}</div>
								<div class="settings-row-actions">
									<button class="test-sound-btn" on:click={testNotificationSound}>
										Test Sound
									</button>
									<button class="action-btn secondary" on:click={resetNotificationSoundToDefault}>
										Reset Default
									</button>
								</div>
							</div>

							<div class="setting-item-full">
								<div class="setting-info">
									<span class="setting-label">Call Ringtone</span>
									<span class="setting-description">Choose what repeats while an incoming call is ringing.</span>
								</div>
								<select
									class="theme-select"
									bind:value={callRingtoneMode}
									on:change={(e) => updateCallRingtoneMode(e.currentTarget.value as CallRingtoneMode)}
								>
									{#each CALL_RINGTONE_OPTIONS as option}
										<option value={option.value}>{option.label}</option>
									{/each}
								</select>
								{#if callRingtoneMode === 'custom-synth'}
									<div class="runtime-note">Custom synth presets stay tiny in storage and can be imported or exported as JSON.</div>
									<div class="settings-row-actions">
										<button
											class="action-btn secondary"
											on:click={() => (callRingtoneSynthEditorExpanded = !callRingtoneSynthEditorExpanded)}
										>
											{callRingtoneSynthEditorExpanded ? 'Hide Advanced' : 'Edit Synth'}
										</button>
										<button class="sound-option" on:click={exportCallRingtoneCustomSynth}>
											Export JSON
										</button>
										<button class="sound-option" on:click={triggerCallRingtoneSynthImportFilePicker}>
											Import JSON
										</button>
									</div>
									<div class="runtime-note">Preset: {getCallRingtoneCustomSynthSummary()}</div>
									{#if callRingtoneSynthEditorExpanded}
										<div class="synth-editor-grid">
											<div class="quality-mode-row">
												<label for="call-ringtone-synth-name">Preset Name</label>
												<input
													id="call-ringtone-synth-name"
													class="theme-select"
													maxlength="48"
													value={callRingtoneCustomSynth.name}
													on:input={(e) => updateCallRingtoneCustomSynthField('name', e.currentTarget.value)}
												/>
											</div>
											<div class="quality-mode-row">
												<label for="call-ringtone-synth-waveform">Waveform</label>
												<select
													id="call-ringtone-synth-waveform"
													class="theme-select"
													value={callRingtoneCustomSynth.waveform}
													on:change={(e) => updateCallRingtoneCustomSynthField('waveform', e.currentTarget.value as CustomSynthWaveform)}
												>
													{#each CUSTOM_SYNTH_WAVEFORM_OPTIONS as option}
														<option value={option.value}>{option.label}</option>
													{/each}
												</select>
											</div>
											<div class="quality-mode-row">
												<label for="call-ringtone-primary-tone">Primary Tone (Hz)</label>
												<input
													id="call-ringtone-primary-tone"
													type="number"
													min="120"
													max="2200"
													step="5"
													class="theme-select"
													value={callRingtoneCustomSynth.primaryToneHz}
													on:input={(e) => updateCallRingtoneCustomSynthField('primaryToneHz', Number(e.currentTarget.value))}
												/>
											</div>
											<div class="quality-mode-row">
												<label for="call-ringtone-secondary-tone">Secondary Tone (Hz)</label>
												<input
													id="call-ringtone-secondary-tone"
													type="number"
													min="0"
													max="2600"
													step="5"
													class="theme-select"
													value={callRingtoneCustomSynth.secondaryToneHz}
													on:input={(e) => updateCallRingtoneCustomSynthField('secondaryToneHz', Number(e.currentTarget.value))}
												/>
											</div>
											<div class="quality-mode-row">
												<label for="call-ringtone-burst-count">Burst Count</label>
												<input
													id="call-ringtone-burst-count"
													type="number"
													min="1"
													max="6"
													step="1"
													class="theme-select"
													value={callRingtoneCustomSynth.burstCount}
													on:input={(e) => updateCallRingtoneCustomSynthField('burstCount', Number(e.currentTarget.value))}
												/>
											</div>
											<div class="quality-mode-row">
												<label for="call-ringtone-burst-duration">Burst Duration (ms)</label>
												<input
													id="call-ringtone-burst-duration"
													type="number"
													min="60"
													max="2500"
													step="10"
													class="theme-select"
													value={callRingtoneCustomSynth.burstDurationMs}
													on:input={(e) => updateCallRingtoneCustomSynthField('burstDurationMs', Number(e.currentTarget.value))}
												/>
											</div>
											<div class="quality-mode-row">
												<label for="call-ringtone-burst-spacing">Burst Gap (ms)</label>
												<input
													id="call-ringtone-burst-spacing"
													type="number"
													min="80"
													max="4000"
													step="10"
													class="theme-select"
													value={callRingtoneCustomSynth.burstSpacingMs}
													on:input={(e) => updateCallRingtoneCustomSynthField('burstSpacingMs', Number(e.currentTarget.value))}
												/>
											</div>
											<div class="quality-mode-row">
												<label for="call-ringtone-cycle">Loop Length (ms)</label>
												<input
													id="call-ringtone-cycle"
													type="number"
													min="300"
													max="8000"
													step="10"
													class="theme-select"
													value={callRingtoneCustomSynth.cycleMs}
													on:input={(e) => updateCallRingtoneCustomSynthField('cycleMs', Number(e.currentTarget.value))}
												/>
											</div>
											<div class="quality-mode-row">
												<label for="call-ringtone-level">Synth Level</label>
												<input
													id="call-ringtone-level"
													type="range"
													min="0.02"
													max="0.25"
													step="0.01"
													value={callRingtoneCustomSynth.level}
													on:input={(e) => updateCallRingtoneCustomSynthField('level', Number(e.currentTarget.value))}
													class="volume-slider"
												/>
											</div>
											<div class="quality-mode-row">
												<label for="call-ringtone-fadeout">Fade Out (ms)</label>
												<input
													id="call-ringtone-fadeout"
													type="number"
													min="10"
													max="800"
													step="5"
													class="theme-select"
													value={callRingtoneCustomSynth.fadeOutMs}
													on:input={(e) => updateCallRingtoneCustomSynthField('fadeOutMs', Number(e.currentTarget.value))}
												/>
											</div>
											<div class="quality-mode-row">
												<label for="call-ringtone-harmonic-multiplier">Harmonic Multiplier</label>
												<input
													id="call-ringtone-harmonic-multiplier"
													type="number"
													min="1"
													max="8"
													step="0.1"
													class="theme-select"
													value={callRingtoneCustomSynth.harmonicMultiplier}
													on:input={(e) => updateCallRingtoneCustomSynthField('harmonicMultiplier', Number(e.currentTarget.value))}
												/>
											</div>
											<div class="quality-mode-row">
												<label for="call-ringtone-harmonic-gain">Harmonic Gain</label>
												<input
													id="call-ringtone-harmonic-gain"
													type="range"
													min="0"
													max="0.4"
													step="0.01"
													value={callRingtoneCustomSynth.harmonicGain}
													on:input={(e) => updateCallRingtoneCustomSynthField('harmonicGain', Number(e.currentTarget.value))}
													class="volume-slider"
												/>
											</div>
											<div class="quality-mode-row">
												<label for="call-ringtone-tremolo-hz">Tremolo Speed (Hz)</label>
												<input
													id="call-ringtone-tremolo-hz"
													type="number"
													min="0"
													max="30"
													step="0.5"
													class="theme-select"
													value={callRingtoneCustomSynth.tremoloHz}
													on:input={(e) => updateCallRingtoneCustomSynthField('tremoloHz', Number(e.currentTarget.value))}
												/>
											</div>
											<div class="quality-mode-row">
												<label for="call-ringtone-tremolo-depth">Tremolo Depth</label>
												<input
													id="call-ringtone-tremolo-depth"
													type="range"
													min="0"
													max="0.95"
													step="0.01"
													value={callRingtoneCustomSynth.tremoloDepth}
													on:input={(e) => updateCallRingtoneCustomSynthField('tremoloDepth', Number(e.currentTarget.value))}
													class="volume-slider"
												/>
											</div>
										</div>
										<div class="settings-row-actions">
											<button class="sound-option" on:click={resetCallRingtoneCustomSynth}>
												Reset Synth
											</button>
										</div>
									{/if}
									<input
										type="file"
										accept="application/json,.json"
										bind:this={callRingtoneSynthImportInput}
										on:change={handleCallRingtoneSynthImportFileSelect}
										style="display: none;"
									/>
								{:else if callRingtoneMode === 'custom-audio'}
									<div class="sound-options">
										<button class="sound-option" on:click={triggerCallRingtoneFilePicker}>
											{callRingtoneLabel === 'Custom audio' ? 'Upload Custom Audio' : 'Replace Custom Audio'}
										</button>
										<button class="sound-option" on:click={resetCallRingtoneToDefault}>
											Back To Preset
										</button>
									</div>
									<input
										type="file"
										accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac"
										bind:this={callRingtoneInput}
										on:change={handleCallRingtoneFileSelect}
										style="display: none;"
									/>
								{/if}
								<div class="runtime-note">Active ringtone: {callRingtoneLabel}</div>
								<div class="settings-row-actions">
									<button class="test-sound-btn" on:click={testCallRingtone}>
										Test Ringtone
									</button>
									{#if callRingtoneMode !== 'custom-audio'}
										<button class="action-btn secondary" on:click={resetCallRingtoneToDefault}>
											Reset Default
										</button>
									{/if}
								</div>
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

							<div class="setting-item-full">
								<div class="setting-info">
									<span class="setting-label">Call Ringtone Volume</span>
									<span class="setting-description">Adjust the volume of the incoming call ringtone ({Math.round(callRingtoneVolume * 100)}%)</span>
								</div>
								<input
									type="range"
									min="0"
									max="1"
									step="0.05"
									bind:value={callRingtoneVolume}
									on:input={(e) => updateCallRingtoneVolume(parseFloat(e.currentTarget.value))}
									class="volume-slider"
								/>
							</div>
						</div>

					{:else if activeSettingsTab === 'accessibility'}
						<div class="settings-section">
							<h3>{$t('settings.sections.accessibility')}</h3>
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
									<span class="setting-label">Better Animations Pass</span>
									<span class="setting-description">BetterAnimations-style channel/message/popout motion across Wabi</span>
								</div>
								<button class="toggle-btn" class:active={animationPassEnabled} on:click={toggleAnimationPass}>
									{animationPassEnabled ? 'ON' : 'OFF'}
								</button>
							</div>

							<div class="setting-item">
								<div class="setting-info">
									<span class="setting-label">Animation Preset</span>
									<span class="setting-description">Slip matches BetterAnimations defaults. Fade/Scale/Flip are alternatives.</span>
								</div>
								<select
									class="theme-select"
									value={animationPassPreset}
									on:change={(e) => updateAnimationPreset(e.currentTarget.value as AnimationPassPreset)}
									disabled={!animationPassEnabled || reducedMotion}
								>
									<option value="slip">Slip</option>
									<option value="fade">Fade</option>
									<option value="scale">Scale</option>
									<option value="flip">Flip</option>
								</select>
							</div>

							<div class="setting-item">
								<div class="setting-info">
									<span class="setting-label">Animation Detail</span>
									<span class="setting-description">Balanced animates core surfaces. Full pushes stronger distance/staging.</span>
								</div>
								<select
									class="theme-select"
									value={animationPassLevel}
									on:change={(e) => updateAnimationLevel(e.currentTarget.value as AnimationPassLevel)}
									disabled={!animationPassEnabled || reducedMotion}
								>
									<option value="balanced">Balanced</option>
									<option value="full">Full</option>
								</select>
							</div>

							<div class="setting-item-full">
								<div class="setting-info">
									<span class="setting-label">Animation Speed</span>
									<span class="setting-description">{Math.round(animationPassDurationMultiplier * 100)}% animation timing multiplier</span>
								</div>
								<input
									type="range"
									min="0.7"
									max="1.6"
									step="0.05"
									bind:value={animationPassDurationMultiplier}
									on:input={(e) => updateAnimationDurationMultiplier(parseFloat(e.currentTarget.value))}
									class="volume-slider"
									disabled={!animationPassEnabled || reducedMotion}
								/>
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
							<h3>{$t('settings.sections.appearance')}</h3>
							<div class="setting-item">
								<div class="setting-info">
									<span class="setting-label">Chat Avatars</span>
									<span class="setting-description">Choose how profile pictures are shown in chat</span>
								</div>
								<select
									class="theme-select"
									value={chatAvatarMode}
									on:change={(e) => updateChatAvatarMode(e.currentTarget.value as ChatAvatarMode)}
								>
									<option value="off">Off</option>
									<option value="user">User Only (Others)</option>
									<option value="all">All</option>
								</select>
							</div>

							<div class="setting-item">
								<div class="setting-info">
									<span class="setting-label">Home View</span>
									<span class="setting-description">Choose whether Wabi opens focused on conversations or the community panel</span>
								</div>
								<select
									class="theme-select"
									value={homeExperienceMode}
									on:change={(e) => updateHomeExperienceMode(e.currentTarget.value as HomeExperienceMode)}
								>
									<option value="conversations">Conversation-first</option>
									<option value="community">Community-first</option>
								</select>
							</div>

							<!-- Message Density -->
							<div class="setting-item">
								<div class="setting-info">
									<span class="setting-label">Message Display</span>
									<span class="setting-description">Cozy adds breathing room between groups; Compact is IRC-style with no avatars</span>
								</div>
								<div class="density-toggle">
									<button type="button" class="density-btn" class:active={messageDensity === 'cozy'} on:click={() => updateMessageDensity('cozy')}>Cozy</button>
									<button type="button" class="density-btn" class:active={messageDensity === 'compact'} on:click={() => updateMessageDensity('compact')}>Compact</button>
								</div>
							</div>

							<div class="setting-item">
								<div class="setting-info">
									<span class="setting-label">Message Deletion Timer</span>
									<span class="setting-description">Show timers only in the last hour: Off, Static snapshot, or Live countdown</span>
								</div>
								<select
									class="theme-select"
									value={deletionCountdownMode}
									on:change={(e) => updateDeletionCountdownMode(e.currentTarget.value as DeletionCountdownMode)}
								>
									<option value="off">Off</option>
									<option value="static">General Countdown</option>
									<option value="live">Live Countdown</option>
								</select>
							</div>

							<div class="setting-item">
								<div class="setting-info">
									<span class="setting-label">Clickable Send Button</span>
									<span class="setting-description">Show the paper-plane send button next to the composer</span>
								</div>
								<button class="toggle-btn" class:active={clickableSendEnabled} on:click={toggleClickableSendEnabled}>
									{clickableSendEnabled ? 'ON' : 'OFF'}
								</button>
							</div>

							<!-- Chat Font Size -->
							<div class="setting-item-full">
								<div class="setting-info">
									<span class="setting-label">Chat Font Size</span>
									<span class="setting-description">Scale message text only ({Math.round(chatFontScale * 100)}%)</span>
								</div>
								<input type="range" min="0.8" max="1.6" step="0.05" bind:value={chatFontScale} on:input={(e) => updateChatFontScale(parseFloat(e.currentTarget.value))} class="volume-slider" />
								<div class="font-scale-presets">
									<button type="button" class="sound-option" class:active={Math.abs(chatFontScale - 0.85) < 0.01} on:click={() => updateChatFontScale(0.85)}>Small</button>
									<button type="button" class="sound-option" class:active={Math.abs(chatFontScale - 1) < 0.01} on:click={() => updateChatFontScale(1)}>Default</button>
									<button type="button" class="sound-option" class:active={Math.abs(chatFontScale - 1.2) < 0.01} on:click={() => updateChatFontScale(1.2)}>Large</button>
									<button type="button" class="sound-option" class:active={Math.abs(chatFontScale - 1.4) < 0.01} on:click={() => updateChatFontScale(1.4)}>XL</button>
								</div>
							</div>

							<div class="setting-item">
								<div class="setting-info">
									<span class="setting-label">Own Messages on Right</span>
									<span class="setting-description">Align your messages to the right side of chat</span>
								</div>
								<button class="toggle-btn" class:active={ownMessagesOnRight} on:click={toggleOwnMessagesOnRight}>
									{ownMessagesOnRight ? 'ON' : 'OFF'}
								</button>
							</div>

							<div class="setting-item">
								<div class="setting-info">
									<span class="setting-label">Navigation Dock Side</span>
									<span class="setting-description">Choose whether the navigation module is docked left or right</span>
								</div>
								<select
									class="theme-select"
									value={$layoutStore.navDock}
									on:change={(e) => updateDockSide(e.currentTarget.value as 'left' | 'right')}
								>
									<option value="left">Left</option>
									<option value="right">Right</option>
								</select>
							</div>

							<div class="setting-item">
								<div class="setting-info">
									<span class="setting-label">Navigation Collapse</span>
									<span class="setting-description">Collapse or expand the navigation dock</span>
								</div>
								<button class="toggle-btn" class:active={$layoutStore.isNavCollapsed} on:click={toggleDockNavCollapsed}>
									{$layoutStore.isNavCollapsed ? 'COLLAPSED' : 'EXPANDED'}
								</button>
							</div>

								<div class="setting-item">
									<div class="setting-info">
										<span class="setting-label">Layout Preset</span>
										<span class="setting-description">Load or save docking layouts for different workflows</span>
									</div>
								<select
									class="theme-select"
									value={$layoutStore.activeWorkspace}
									on:change={(e) => loadWorkspaceByName(e.currentTarget.value)}
								>
									{#each $layoutStore.workspaces as workspaceName}
										<option value={workspaceName}>{workspaceName}</option>
									{/each}
									</select>
								</div>

								<div class="setting-item">
									<div class="setting-info">
										<span class="setting-label">Obvious Grab Rails</span>
										<span class="setting-description">Debug mode: draw exact draggable resize hitboxes</span>
									</div>
									<button class="toggle-btn" class:active={$layoutStore.obviousGrabRails} on:click={toggleObviousGrabRails}>
										{$layoutStore.obviousGrabRails ? 'ON' : 'OFF'}
									</button>
								</div>

							<div class="setting-item-full">
								<div class="settings-row-actions">
									<button type="button" class="action-btn" on:click={saveWorkspaceAsPrompt}>Save Layout As...</button>
									<button type="button" class="action-btn secondary" on:click={renameWorkspacePrompt}>Rename Layout...</button>
									<button type="button" class="action-btn danger" on:click={resetActiveWorkspace}>Reset Layout</button>
								</div>
								<div class="settings-row-actions">
									<button type="button" class="action-btn secondary" on:click={exportWorkspaceJson}>Export Layout JSON</button>
									<button type="button" class="action-btn secondary" on:click={importWorkspaceJsonPrompt}>Import Layout JSON</button>
								</div>
							</div>

							<div class="setting-item setting-item-stack">
								<div class="setting-info">
									<span class="setting-label">{$t('settings.language_learning.label')}</span>
									<span class="setting-description">{$t('settings.language_learning.description')}</span>
								</div>
								<div class="quality-mode-row">
									<label for="ui-learning-target">{$t('settings.language_learning.target_percent', { values: { percent: uiLearningTargetPercent } })}</label>
									<button class="toggle-btn" class:active={uiLearningModeEnabled} on:click={toggleUiLearningMode}>
										{uiLearningModeEnabled ? $t('common.on') : $t('common.off')}
									</button>
								</div>
								<input
									id="ui-learning-target"
									type="range"
									min="0"
									max="100"
									step="5"
									value={uiLearningTargetPercent}
									on:input={(e) => handleUiLearningPercentChange(e.currentTarget.value)}
									class="volume-slider"
									disabled={!uiLearningModeEnabled || selectedLocale === 'en'}
								/>
								<div class="runtime-note">
									{selectedLocale === 'en'
										? $t('settings.language_learning.select_non_english')
										: $t('settings.language_learning.hint')}
								</div>
							</div>

							<div class="setting-item setting-item-stack">
								<div class="setting-info">
									<span class="setting-label">Tab Shade Strength</span>
									<span class="setting-description">
										Controls how much each new queued tab shifts shade ({Math.round(tabShadeStrength * 100)}%)
									</span>
								</div>
								<input
									type="range"
									min="0"
									max="0.14"
									step="0.01"
									bind:value={tabShadeStrength}
									on:input={(e) => updateTabShadeStrength(parseFloat(e.currentTarget.value))}
									class="volume-slider"
								/>
							</div>

							<div class="setting-item setting-item-stack">
								<div class="setting-info">
									<span class="setting-label">Window Chrome Opacity (Tauri)</span>
									<span class="setting-description">
										Make UI panels transparent while keeping text readable ({Math.round(appChromeOpacity * 100)}%)
									</span>
								</div>
								<input
									type="range"
									min="0.2"
									max="1"
									step="0.05"
									bind:value={appChromeOpacity}
									on:input={(e) => updateAppChromeOpacity(parseFloat(e.currentTarget.value))}
									class="volume-slider"
								/>
							</div>

							<div class="setting-item">
								<div class="setting-info">
									<span class="setting-label">Video Compression ({videoCompressionRuntimeLabel})</span>
									<span class="setting-description">
										Prompt to compress large videos before upload with runtime-specific safety limits.
									</span>
								</div>
								<button class="toggle-btn" class:active={videoCompressionEnabled} on:click={toggleVideoCompressionEnabled}>
									{videoCompressionEnabled ? 'ON' : 'OFF'}
								</button>
							</div>

							<div class="setting-item">
								<div class="setting-info">
									<span class="setting-label">Default Compression Preset</span>
									<span class="setting-description">Used by the upload compression dialog for large videos</span>
								</div>
								<select
									class="theme-select"
									value={defaultVideoCompressionPreset}
									on:change={(e) => updateVideoCompressionPreset(e.currentTarget.value as VideoCompressionPresetId)}
									disabled={!videoCompressionEnabled}
								>
									{#each videoCompressionPresetOptions as presetOption}
										<option value={presetOption.id}>{presetOption.label}</option>
									{/each}
								</select>
								{#if selectedVideoCompressionPresetOption}
									<div class="runtime-note">{selectedVideoCompressionPresetOption.description}</div>
								{/if}
							</div>

							<div class="setting-item-full">
								<div class="setting-info">
									<span class="setting-label">Theme</span>
									<span class="setting-description">Choose your preferred theme</span>
								</div>
								<div class="theme-cards">
									{#each Object.values(THEMES) as theme}
										<button
											type="button"
											class="theme-card"
											class:active={$themeStore.themeId === theme.id}
											on:click={() => handleThemeChange(theme.id)}
											disabled={savingTheme}
											title={theme.description}
										>
											<div class="theme-card-preview" style="background: {theme.colors.bgSecondary};">
												<div class="theme-preview-top" style="background: {theme.colors.bgTertiary};"></div>
												<div class="theme-preview-content">
													<div class="theme-preview-bar long" style="background: {theme.colors.textPrimary}; opacity: 0.55;"></div>
													<div class="theme-preview-bar short" style="background: {theme.colors.textSecondary}; opacity: 0.4;"></div>
													<div class="theme-preview-accent" style="background: {theme.colors.accentHex};"></div>
												</div>
											</div>
											<div class="theme-card-footer">
												<span class="theme-card-name">{theme.name}</span>
												{#if $themeStore.themeId === theme.id}<span class="theme-card-badge">&#10003;</span>{/if}
											</div>
										</button>
									{/each}
								</div>
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
							<h3>{$t('settings.sections.server_management')}</h3>
							<div class="setting-item">
								<div class="setting-info">
									<span class="setting-label">Local Directions Assist</span>
									<span class="setting-description">Opt in to use your current location locally when creating directions cards. This is never uploaded to the server.</span>
								</div>
								<button class="toggle-btn" class:active={directionsGpsEnabled} on:click={toggleDirectionsGpsAssist}>
									{directionsGpsEnabled ? 'ON' : 'OFF'}
								</button>
							</div>
							{#if directionsGpsStatus}
								<div class="runtime-note">{directionsGpsStatus}</div>
							{/if}
							<div class="setting-item">
								<div class="setting-info">
									<span class="setting-label">Business Data Sync Mode</span>
									<span class="setting-description">Manual mode reduces background sync chatter. Auto mode continuously syncs business data.</span>
								</div>
								<button class="toggle-btn" class:active={businessSyncMode === 'auto'} on:click={toggleBusinessSyncMode}>
									{businessSyncMode === 'auto' ? 'AUTO' : 'MANUAL'}
								</button>
							</div>
							<div class="setting-item">
								<div class="setting-info">
									<span class="setting-label">Sync Business Data Now</span>
									<span class="setting-description">Pull latest server state, then push your local business updates.</span>
								</div>
								<button class="action-btn" on:click={runBusinessSyncNow} disabled={businessSyncInFlight}>
									{businessSyncInFlight ? 'Syncing...' : 'Sync Now'}
								</button>
							</div>
							{#if businessSyncStatus}
								<div class="runtime-note">{businessSyncStatus}</div>
							{/if}
							<div class="setting-item">
								<div class="setting-info">
									<span class="setting-label">Clear All Server Messages</span>
									<span class="setting-description">Delete all messages from the server for all users (cannot be undone)</span>
								</div>
								<button class="action-btn danger" on:click={clearServerMessages}>
									{$t('settings.actions.clear_server')}
								</button>
							</div>
						</div>

					{:else if activeSettingsTab === 'addons'}
						<div class="settings-section">
							<h3>{$t('settings.sections.addons')}</h3>
							<div class="setting-item-full">
								<div class="setting-info">
									<span class="setting-label">Import / Export Add-ons Manifest</span>
									<span class="setting-description">Export a snapshot of detected frontend/backend add-ons, or import a saved manifest for comparison.</span>
								</div>
								<div class="addons-actions">
									<button class="action-btn export" on:click={exportAddonManifest}>Export Add-ons JSON</button>
									<button class="action-btn import" on:click={triggerAddonImport}>Import Add-ons JSON</button>
									<button class="action-btn install" on:click={triggerAddonPackageInstall} disabled={addonInstallLoading}>
										{addonInstallLoading ? 'Installing Plugin...' : 'Install Plugin Package'}
									</button>
									<button class="action-btn" on:click={refreshAddonDetection} disabled={addonsLoading}>
										{addonsLoading ? 'Detecting...' : 'Refresh Detection'}
									</button>
								</div>
								<input
									type="file"
									accept=".json,application/json"
									bind:this={addonsImportInput}
									on:change={importAddonManifest}
									style="display: none;"
								/>
								<input
									type="file"
									accept=".zip,.wabi-plugin,.wabip,application/zip,application/x-zip-compressed"
									bind:this={addonsPackageInput}
									on:change={installAddonPackage}
									style="display: none;"
								/>
								{#if addonsLastDetectedAt}
									<div class="runtime-note">Last detected: {addonsLastDetectedAt}</div>
								{/if}
								{#if addonInstallStatus}
									<div class="runtime-note">{addonInstallStatus}</div>
								{/if}
								{#if addonsImportPreview}
									<div class="runtime-note">
										Imported manifest
										{#if addonsImportPreview.importedAt}
											from {new Date(addonsImportPreview.importedAt).toLocaleString()}
										{/if}
										(frontend: {addonsImportPreview.frontend?.length || 0}, backend: {addonsImportPreview.backend?.length || 0})
									</div>
								{/if}
							</div>

							<div class="addons-runtime-grid">
								<div class="settings-section">
									<h3>Frontend Add-ons (Detected)</h3>
									{#if frontendAddons.length === 0}
										<div class="runtime-note">No frontend add-ons detected.</div>
									{:else}
										<div class="addons-list">
											{#each frontendAddons as addon (addon.id + addon.source)}
												<div class="addon-row">
													<div class="addon-name">{addon.name}</div>
													<div class="addon-meta">id: {addon.id} - version: {addon.version}</div>
													<div class="addon-source">{addon.source}</div>
												</div>
											{/each}
										</div>
									{/if}
								</div>

								<div class="settings-section">
									<h3>Backend Add-ons (Detected)</h3>
									{#if backendAddons.length === 0}
										<div class="runtime-note">No backend add-ons detected (or plugin API access is unavailable for this account/session).</div>
									{:else}
										<div class="addons-list">
											{#each backendAddons as addon (addon.id + addon.version)}
												<div class="addon-row">
													<div class="addon-name">{addon.name}</div>
													<div class="addon-meta">id: {addon.id} - version: {addon.version}</div>
													<div class="addon-source">{addon.source}</div>
												</div>
											{/each}
										</div>
									{/if}
								</div>
							</div>

							<div class="addons-settings-window">
								<div class="addons-settings-window-header">
									<div class="setting-info">
										<span class="setting-label">Local Add-on Controls</span>
										<span class="setting-description">Browse and tune device-local add-on behavior here. Search auto-expands matching sections while you filter.</span>
									</div>
									<div class="addons-settings-toolbar">
										<label class="addons-search-field">
											<span class="addons-search-label">Search add-ons</span>
											<input
												type="search"
												class="theme-select addon-search-input"
												bind:value={addonSearchQuery}
												placeholder="Search local add-ons, tools, and settings"
											/>
										</label>
										<div class="addons-search-meta">
											<span class="runtime-note">Showing {visibleLocalAddonControlCount} of {availableLocalAddonControlCount} local add-ons</span>
											{#if addonSearchQuery.trim()}
												<button type="button" class="action-btn secondary addon-search-clear" on:click={clearAddonSearchQuery}>
													Clear Search
												</button>
											{/if}
										</div>
									</div>
								</div>
								<div class="addons-settings-window-body">
									{#if visibleLocalAddonControlCount === 0}
										<div class="addon-empty-state">
											<div class="addon-empty-state-title">No local add-ons matched that search.</div>
											<div class="runtime-note">Try another keyword, or clear the filter to show everything again.</div>
											<button type="button" class="action-btn secondary addon-search-clear" on:click={clearAddonSearchQuery}>
												Clear Search
											</button>
										</div>
									{:else}
									{#if addonSectionHasMatches('dms')}
									<section class="addon-accordion-section">
										<button
											type="button"
											class="addon-accordion-trigger"
											aria-expanded={isAddonSectionOpen('dms')}
											aria-controls="addon-section-dms"
											on:click={() => toggleAddonSection('dms')}
										>
											<span class="addon-accordion-trigger-main">
												<span class="addon-section-chevron" aria-hidden="true">
													<svg viewBox="0 0 24 24">
														<path d="M9 6l6 6-6 6"></path>
													</svg>
												</span>
												<span class="addon-accordion-label">{ADDON_SECTION_LABELS.dms}</span>
											</span>
											<span class="addon-accordion-count">{addonSectionMatchCount('dms')}</span>
										</button>
										{#if isAddonSectionOpen('dms')}
										<div class="addon-accordion-body" id="addon-section-dms">
											{#if localAddonControlMatches('line_dm')}
												<LineDm />
											{/if}

											{#if localAddonControlMatches('pin_dms')}
												<div class="setting-item-full">
																					<div class="setting-info">
																						<span class="setting-label">PinDMs (MVP)</span>
																						<span class="setting-description">Pin conversations from the DM context menu to keep them at the top.</span>
																					</div>
																				<div class="runtime-note">Pinned conversations: {pinnedDmConversationCount}</div>
																				<div class="settings-row-actions">
																					<button class="action-btn secondary" on:click={clearAllPinnedDmConversations} disabled={pinnedDmConversationCount === 0}>
																						Clear All Pins
																					</button>
																				</div>
																			</div>
											{/if}
										</div>
										{/if}
									</section>
									{/if}

									{#if addonSectionHasMatches('chat')}
									<section class="addon-accordion-section">
										<button
											type="button"
											class="addon-accordion-trigger"
											aria-expanded={isAddonSectionOpen('chat')}
											aria-controls="addon-section-chat"
											on:click={() => toggleAddonSection('chat')}
										>
											<span class="addon-accordion-trigger-main">
												<span class="addon-section-chevron" aria-hidden="true">
													<svg viewBox="0 0 24 24">
														<path d="M9 6l6 6-6 6"></path>
													</svg>
												</span>
												<span class="addon-accordion-label">{ADDON_SECTION_LABELS.chat}</span>
											</span>
											<span class="addon-accordion-count">{addonSectionMatchCount('chat')}</span>
										</button>
										{#if isAddonSectionOpen('chat')}
										<div class="addon-accordion-body" id="addon-section-chat">
											{#if localAddonControlMatches('spellcheck')}
												<div class="setting-item-full">
																				<div class="setting-info">
																					<span class="setting-label">SpellCheck (MVP)</span>
																					<span class="setting-description">Use browser spellcheck in the main chat and DM composers.</span>
																				</div>
																				<div class="settings-row-actions">
																					<button class="toggle-btn" class:active={spellCheckEnabled} on:click={toggleSpellCheckAddon}>
																						{spellCheckEnabled ? 'ON' : 'OFF'}
																					</button>
																				</div>
																			</div>
											{/if}

											{#if localAddonControlMatches('char_counter')}
												<div class="setting-item-full">
																				<div class="setting-info">
																					<span class="setting-label">CharCounter (MVP)</span>
																					<span class="setting-description">Show live character counters in the main chat and DM composers.</span>
																				</div>
																				<div class="settings-row-actions">
																					<button class="toggle-btn" class:active={charCounterEnabled} on:click={toggleCharCounterAddon}>
																						{charCounterEnabled ? 'ON' : 'OFF'}
																					</button>
																				</div>
																			</div>
											{/if}

											{#if localAddonControlMatches('split_large_messages')}
												<div class="setting-item-full">
																				<div class="setting-info">
																					<span class="setting-label">SplitLargeMessages (MVP)</span>
																					<span class="setting-description">Automatically split long outgoing text into multiple messages.</span>
																				</div>
																				<div class="settings-row-actions">
																					<button class="toggle-btn" class:active={splitLargeMessagesEnabled} on:click={toggleSplitLargeMessagesAddon}>
																						{splitLargeMessagesEnabled ? 'ON' : 'OFF'}
																					</button>
																					<label class="upload-limit-row split-chunk-size-row">
																						<span>Chunk size</span>
																						<input
																							type="number"
																							min="250"
																							max="4000"
																							step="50"
																							value={splitLargeMessagesChunkSize}
																							on:change={(event) => updateSplitLargeMessagesChunkSize(event.currentTarget.value)}
																							disabled={!splitLargeMessagesEnabled}
																						/>
																					</label>
																				</div>
																				<div class="runtime-note">
																					Composer max length: {splitLargeMessagesEnabled ? splitLargeMessagesInputMaxLength : splitLargeMessagesChunkSize} characters.
																				</div>
																			</div>
											{/if}

											{#if localAddonControlMatches('write_upper_case')}
												<div class="setting-item-full">
																				<div class="setting-info">
																					<span class="setting-label">WriteUpperCase</span>
																					<span class="setting-description">Auto-capitalize sentence starts for outgoing text (main chat, DM, and GIF captions).</span>
																				</div>
																				<div class="settings-row-actions">
																					<button class="toggle-btn" class:active={writeUpperCaseEnabled} on:click={toggleWriteUpperCaseAddon}>
																						{writeUpperCaseEnabled ? 'ON' : 'OFF'}
																					</button>
																				</div>
																			</div>
											{/if}

											{#if localAddonControlMatches('clickable_mentions')}
												<div class="setting-item-full">
																				<div class="setting-info">
																					<span class="setting-label">ClickableMentions</span>
																					<span class="setting-description">Open user popouts by clicking usernames and @mentions in message content.</span>
																				</div>
																				<div class="settings-row-actions">
																					<button class="toggle-btn" class:active={clickableMentionsEnabled} on:click={toggleClickableMentionsAddon}>
																						{clickableMentionsEnabled ? 'ON' : 'OFF'}
																					</button>
																				</div>
																			</div>
											{/if}

											{#if localAddonControlMatches('complete_timestamps')}
												<div class="setting-item-full">
																				<div class="setting-info">
																					<span class="setting-label">CompleteTimestamps</span>
																					<span class="setting-description">Choose the timestamp detail level shown in message rows.</span>
																				</div>
																				<label class="upload-limit-row">
																					<span>Timestamp mode</span>
																					<select
																						class="theme-select"
																						value={timestampDisplayMode}
																						on:change={(event) => updateTimestampDisplayMode(event.currentTarget.value)}
																					>
																						<option value="compact">Compact (time only)</option>
																						<option value="complete">Complete (date + time)</option>
																						<option value="detailed">Detailed (full locale)</option>
																					</select>
																				</label>
																			</div>
											{/if}

											{#if localAddonControlMatches('reveal_all_spoilers')}
												<div class="setting-item-full">
																				<div class="setting-info">
																					<span class="setting-label">RevealAllSpoilers</span>
																					<span class="setting-description">Hold Ctrl/Cmd and click a spoiler to reveal all spoilers in that message.</span>
																				</div>
																				<div class="settings-row-actions">
																					<button class="toggle-btn" class:active={revealAllSpoilersEnabled} on:click={toggleRevealAllSpoilersAddon}>
																						{revealAllSpoilersEnabled ? 'ON' : 'OFF'}
																					</button>
																					<label class="upload-limit-row split-chunk-size-row">
																						<span>Minimum role</span>
																						<select
																							class="theme-select"
																							value={revealAllSpoilersMinRole}
																							on:change={(event) => updateRevealAllSpoilersRole(event.currentTarget.value)}
																							disabled={!revealAllSpoilersEnabled}
																						>
																							<option value="guest">Guest</option>
																							<option value="member">Member</option>
																							<option value="mod">Moderator</option>
																							<option value="admin">Admin</option>
																							<option value="owner">Owner</option>
																						</select>
																					</label>
																				</div>
																			</div>
											{/if}

											{#if localAddonControlMatches('message_utilities')}
												<div class="setting-item-full">
																				<div class="setting-info">
																					<span class="setting-label">MessageUtilities</span>
																					<span class="setting-description">Show extra quick message tools in hover actions (quick mention, pin, edit).</span>
																				</div>
																				<div class="settings-row-actions">
																					<button class="toggle-btn" class:active={messageUtilitiesEnabled} on:click={toggleMessageUtilitiesAddon}>
																						{messageUtilitiesEnabled ? 'ON' : 'OFF'}
																					</button>
																				</div>
																			</div>
											{/if}

											{#if localAddonControlMatches('quick_mention')}
												<div class="setting-item-full">
																				<div class="setting-info">
																					<span class="setting-label">QuickMention</span>
																					<span class="setting-description">Adds a fast mention action in message context/utility actions.</span>
																				</div>
																				<div class="settings-row-actions">
																					<button class="toggle-btn" class:active={quickMentionEnabled} on:click={toggleQuickMentionAddon}>
																						{quickMentionEnabled ? 'ON' : 'OFF'}
																					</button>
																				</div>
																			</div>
											{/if}

											{#if localAddonControlMatches('personal_pins')}
												<div class="setting-item-full">
																				<div class="setting-info">
																					<span class="setting-label">PersonalPins</span>
																					<span class="setting-description">Pin messages locally on this device without affecting shared channel pins.</span>
																				</div>
																				<div class="runtime-note">Local personal pins: {personalPinCount}</div>
																				<div class="settings-row-actions">
																					<button class="toggle-btn" class:active={personalPinsEnabled} on:click={togglePersonalPinsAddon}>
																						{personalPinsEnabled ? 'ON' : 'OFF'}
																					</button>
																					<button class="action-btn secondary" on:click={clearPersonalPinsAddon} disabled={personalPinCount === 0}>
																						Clear Local Pins
																					</button>
																				</div>
																			</div>
											{/if}

											{#if localAddonControlMatches('unicode_emojis')}
												<div class="setting-item-full">
																					<div class="setting-info">
																						<span class="setting-label">UnicodeEmojis</span>
																						<span class="setting-description">Convert outgoing default/OpenMoji shortcodes (for example <code>:smile:</code>) into native Unicode emoji. Custom emoji shortcodes stay unchanged.</span>
																					</div>
																					<div class="settings-row-actions">
																						<button class="toggle-btn" class:active={unicodeEmojisEnabled} on:click={toggleUnicodeEmojisAddon}>
																							{unicodeEmojisEnabled ? 'ON' : 'OFF'}
																						</button>
																					</div>
																					{#if unicodeEmojisEnabled}
																						<div class="settings-row-actions">
																							<button class="toggle-btn" class:active={unicodeConvertDefaultEnabled} on:click={toggleUnicodeDefaultSource}>
																								Default source: {unicodeConvertDefaultEnabled ? 'ON' : 'OFF'}
																							</button>
																							<button class="toggle-btn" class:active={unicodeConvertOpenmojiEnabled} on:click={toggleUnicodeOpenmojiSource}>
																								OpenMoji source: {unicodeConvertOpenmojiEnabled ? 'ON' : 'OFF'}
																							</button>
																						</div>
																					{/if}
																					<div class="runtime-note">Applies to main chat, DM sends, and GIF captions.</div>
																					{#if unicodeEmojisEnabled}
																						<div class="runtime-note">
																							Local counters (device-only):
																							converted {$unicodeEmojiTelemetryStore.convertedTokens},
																							unknown {$unicodeEmojiTelemetryStore.unknownTokens},
																							shortcode collisions {$unicodeEmojiTelemetryStore.shortcodeCollisions}.
																						</div>
																						<div class="settings-row-actions">
																							<button
																								class="action-btn secondary"
																								on:click={resetUnicodeEmojisTelemetry}
																								disabled={
																									$unicodeEmojiTelemetryStore.convertedTokens +
																									$unicodeEmojiTelemetryStore.unknownTokens +
																									$unicodeEmojiTelemetryStore.shortcodeCollisions === 0
																								}
																							>
																								Reset Unicode Counters
																							</button>
																							<button class="action-btn secondary" on:click={() => void exportUnicodeEmojisPrefs()}>
																								Export Unicode Prefs
																							</button>
																							<button class="action-btn secondary" on:click={importUnicodeEmojisPrefs}>
																								Import Unicode Prefs
																							</button>
																						</div>
																						{#if unicodeEmojisPrefsStatus}
																							<div class="runtime-note">{unicodeEmojisPrefsStatus}</div>
																						{/if}
																					{/if}
																				</div>
											{/if}
										</div>
										{/if}
									</section>
									{/if}

									{#if addonSectionHasMatches('search')}
									<section class="addon-accordion-section">
										<button
											type="button"
											class="addon-accordion-trigger"
											aria-expanded={isAddonSectionOpen('search')}
											aria-controls="addon-section-search"
											on:click={() => toggleAddonSection('search')}
										>
											<span class="addon-accordion-trigger-main">
												<span class="addon-section-chevron" aria-hidden="true">
													<svg viewBox="0 0 24 24">
														<path d="M9 6l6 6-6 6"></path>
													</svg>
												</span>
												<span class="addon-accordion-label">{ADDON_SECTION_LABELS.search}</span>
											</span>
											<span class="addon-accordion-count">{addonSectionMatchCount('search')}</span>
										</button>
										{#if isAddonSectionOpen('search')}
										<div class="addon-accordion-body" id="addon-section-search">
											{#if localAddonControlMatches('better_search_page')}
												<div class="setting-item-full">
																				<div class="setting-info">
																					<span class="setting-label">BetterSearchPage</span>
																					<span class="setting-description">Keep search results controls pinned above the message list while you scroll through matches.</span>
																				</div>
																				<div class="settings-row-actions">
																					<button class="toggle-btn" class:active={betterSearchPageEnabled} on:click={toggleBetterSearchPageAddon}>
																						{betterSearchPageEnabled ? 'ON' : 'OFF'}
																					</button>
																				</div>
																			</div>
											{/if}

											{#if localAddonControlMatches('google_search_replace')}
												<div class="setting-item-full">
																				<div class="setting-info">
																					<span class="setting-label">GoogleSearchReplace (Wabi translation)</span>
																					<span class="setting-description">Add a quick "Search on Web" action from the in-chat search bar so users can continue the same query in a browser.</span>
																				</div>
																				<div class="settings-row-actions">
																					<button class="toggle-btn" class:active={googleSearchReplaceEnabled} on:click={toggleGoogleSearchReplaceAddon}>
																						{googleSearchReplaceEnabled ? 'ON' : 'OFF'}
																					</button>
																					<label class="upload-limit-row split-chunk-size-row">
																						<span>Search engine</span>
																						<select
																							class="theme-select"
																							value={searchEngineProvider}
																							on:change={(event) => updateSearchEngineProvider(event.currentTarget.value)}
																							disabled={!googleSearchReplaceEnabled}
																						>
																							<option value="brave">Brave</option>
																							<option value="duckduckgo">DuckDuckGo</option>
																							<option value="startpage">Startpage</option>
																							<option value="bing">Bing</option>
																							<option value="google">Google</option>
																							<option value="custom">Custom template</option>
																						</select>
																					</label>
																				</div>
																				{#if searchEngineProvider === 'custom'}
																					<div class="settings-row-actions">
																						<input
																							type="text"
																							class="theme-select"
																							bind:value={searchEngineCustomTemplate}
																							placeholder={SEARCH_ENGINE_CUSTOM_TEMPLATE_PLACEHOLDER}
																							disabled={!googleSearchReplaceEnabled}
																						/>
																						<button
																							class="action-btn secondary"
																							on:click={saveCustomSearchEngineTemplateFromSettings}
																							disabled={!googleSearchReplaceEnabled}
																						>
																							Save Template
																						</button>
																					</div>
																					<div class="runtime-note">Use <code>{SEARCH_ENGINE_CUSTOM_QUERY_TOKEN}</code> where the search text should be inserted.</div>
																				{/if}
																			</div>
											{/if}
										</div>
										{/if}
									</section>
									{/if}

									{#if addonSectionHasMatches('navigation')}
									<section class="addon-accordion-section">
										<button
											type="button"
											class="addon-accordion-trigger"
											aria-expanded={isAddonSectionOpen('navigation')}
											aria-controls="addon-section-navigation"
											on:click={() => toggleAddonSection('navigation')}
										>
											<span class="addon-accordion-trigger-main">
												<span class="addon-section-chevron" aria-hidden="true">
													<svg viewBox="0 0 24 24">
														<path d="M9 6l6 6-6 6"></path>
													</svg>
												</span>
												<span class="addon-accordion-label">{ADDON_SECTION_LABELS.navigation}</span>
											</span>
											<span class="addon-accordion-count">{addonSectionMatchCount('navigation')}</span>
										</button>
										{#if isAddonSectionOpen('navigation')}
										<div class="addon-accordion-body" id="addon-section-navigation">
											{#if localAddonControlMatches('hide_muted_categories')}
												<div class="setting-item-full">
																				<div class="setting-info">
																					<span class="setting-label">HideMutedCategories</span>
																					<span class="setting-description">Wabi translation: hide locally muted channels from the sidebar channel list.</span>
																				</div>
																				<div class="runtime-note">Locally muted channels: {mutedChannelCount}</div>
																				<div class="settings-row-actions">
																					<button class="toggle-btn" class:active={hideMutedCategoriesEnabled} on:click={toggleHideMutedCategoriesAddon}>
																						{hideMutedCategoriesEnabled ? 'ON' : 'OFF'}
																					</button>
																					<button class="action-btn secondary" on:click={clearMutedChannelsAddon} disabled={mutedChannelCount === 0}>
																						Clear Muted
																					</button>
																				</div>
																			</div>
											{/if}

											{#if localAddonControlMatches('read_all_notifications_button')}
												<div class="setting-item-full">
																				<div class="setting-info">
																					<span class="setting-label">ReadAllNotificationsButton</span>
																					<span class="setting-description">Show a clear-unread action in the channel sidebar.</span>
																				</div>
																				<div class="settings-row-actions">
																					<button class="toggle-btn" class:active={readAllNotificationsButtonEnabled} on:click={toggleReadAllNotificationsButtonAddon}>
																						{readAllNotificationsButtonEnabled ? 'ON' : 'OFF'}
																					</button>
																				</div>
																			</div>
											{/if}

											{#if localAddonControlMatches('server_counter')}
												<div class="setting-item-full">
																				<div class="setting-info">
																					<span class="setting-label">ServerCounter (server list)</span>
																					<span class="setting-description">Show a server channel counter above the channel list.</span>
																				</div>
																				<div class="settings-row-actions">
																					<button class="toggle-btn" class:active={serverCounterEnabled} on:click={toggleServerCounterAddon}>
																						{serverCounterEnabled ? 'ON' : 'OFF'}
																					</button>
																				</div>
																			</div>
											{/if}

											{#if localAddonControlMatches('better_nsfw_tag')}
												<div class="setting-item-full">
																				<div class="setting-info">
																					<span class="setting-label">BetterNsfwTag (Wabi translation)</span>
																					<span class="setting-description">Highlight NSFW-like channels in the sidebar with a high-visibility warning tag.</span>
																				</div>
																				<div class="settings-row-actions">
																					<button class="toggle-btn" class:active={betterNsfwTagEnabled} on:click={toggleBetterNsfwTagAddon}>
																						{betterNsfwTagEnabled ? 'ON' : 'OFF'}
																					</button>
																				</div>
																			</div>
											{/if}

											{#if localAddonControlMatches('better_friend_list')}
												<div class="setting-item-full">
																				<div class="setting-info">
																					<span class="setting-label">BetterFriendList</span>
																					<span class="setting-description">Enable search/filter/sort and summary counters in the right-panel user list.</span>
																				</div>
																				<div class="settings-row-actions">
																					<button class="toggle-btn" class:active={betterFriendListEnabled} on:click={toggleBetterFriendListAddon}>
																						{betterFriendListEnabled ? 'ON' : 'OFF'}
																					</button>
																				</div>
																			</div>
											{/if}
										</div>
										{/if}
									</section>
									{/if}

									{#if addonSectionHasMatches('identity')}
									<section class="addon-accordion-section">
										<button
											type="button"
											class="addon-accordion-trigger"
											aria-expanded={isAddonSectionOpen('identity')}
											aria-controls="addon-section-identity"
											on:click={() => toggleAddonSection('identity')}
										>
											<span class="addon-accordion-trigger-main">
												<span class="addon-section-chevron" aria-hidden="true">
													<svg viewBox="0 0 24 24">
														<path d="M9 6l6 6-6 6"></path>
													</svg>
												</span>
												<span class="addon-accordion-label">{ADDON_SECTION_LABELS.identity}</span>
											</span>
											<span class="addon-accordion-count">{addonSectionMatchCount('identity')}</span>
										</button>
										{#if isAddonSectionOpen('identity')}
										<div class="addon-accordion-body" id="addon-section-identity">
											{#if localAddonControlMatches('custom_status_presets')}
												<div class="setting-item-full">
																				<div class="setting-info">
																					<span class="setting-label">CustomStatusPresets (Wabi translation)</span>
																					<span class="setting-description">Save reusable presence presets and apply them directly from the sidebar status menu.</span>
																				</div>
																				<div class="settings-row-actions">
																					<button class="toggle-btn" class:active={customStatusPresetsEnabled} on:click={toggleCustomStatusPresetsAddon}>
																						{customStatusPresetsEnabled ? 'ON' : 'OFF'}
																					</button>
																					<div class="runtime-note">
																						Presets: {$customStatusPresetsStore.presets.length}/{MAX_CUSTOM_STATUS_PRESETS}
																					</div>
																				</div>
																				<div class="settings-row-actions">
																					<input
																						type="text"
																						class="theme-select"
																						placeholder="Preset label"
																						bind:value={customStatusPresetLabelDraft}
																						maxlength="36"
																						disabled={!customStatusPresetsEnabled}
																					/>
																					<select
																						class="theme-select"
																						bind:value={customStatusPresetPresenceDraft}
																						disabled={!customStatusPresetsEnabled}
																					>
																						<option value="active">Active</option>
																						<option value="away">Away</option>
																						<option value="busy">Busy</option>
																					</select>
																					<button
																						class="action-btn"
																						on:click={addCustomStatusPresetFromSettings}
																						disabled={!customStatusPresetsEnabled || !customStatusPresetLabelDraft.trim()}
																					>
																						Add Preset
																					</button>
																				</div>
																				<div class="settings-row-actions">
																					<input
																						type="text"
																						class="theme-select"
																						placeholder="Optional note shown below your username"
																						bind:value={customStatusPresetNoteDraft}
																						maxlength="120"
																						disabled={!customStatusPresetsEnabled}
																					/>
																					<button
																						class="action-btn secondary"
																						on:click={resetCustomStatusPresetsAddon}
																						disabled={!customStatusPresetsEnabled}
																					>
																						Reset Presets
																					</button>
																				</div>
																				{#if $customStatusPresetsStore.presets.length === 0}
																					<div class="runtime-note">No presets configured.</div>
																				{:else}
																					<div class="custom-status-preset-list">
																						{#each $customStatusPresetsStore.presets as preset (preset.id)}
																							<div class="custom-status-preset-row">
																								<div class="custom-status-preset-main">
																									<div class="custom-status-preset-label">{preset.label}</div>
																									<div class="custom-status-preset-meta">
																										{preset.status}{preset.note ? ` | ${preset.note}` : ''}
																									</div>
																								</div>
																								<div class="settings-row-actions">
																									<button
																										class="action-btn secondary"
																										on:click={() => activateCustomStatusPresetFromSettings(preset.id, preset.status)}
																										disabled={!customStatusPresetsEnabled}
																									>
																										Apply
																									</button>
																									<button
																										class="action-btn danger"
																										on:click={() => removeCustomStatusPresetFromSettings(preset.id)}
																										disabled={!customStatusPresetsEnabled}
																									>
																										Remove
																									</button>
																								</div>
																							</div>
																						{/each}
																					</div>
																				{/if}
																				{#if customStatusPresetsStatus}
																					<div class="runtime-note">{customStatusPresetsStatus}</div>
																				{/if}
																			</div>
											{/if}

											{#if localAddonControlMatches('last_message_date')}
												<div class="setting-item-full">
																				<div class="setting-info">
																					<span class="setting-label">LastMessageDate</span>
																					<span class="setting-description">Show each user's most recent message timestamp in the active channel inside popouts.</span>
																				</div>
																				<div class="settings-row-actions">
																					<button class="toggle-btn" class:active={lastMessageDateEnabled} on:click={toggleLastMessageDateAddon}>
																						{lastMessageDateEnabled ? 'ON' : 'OFF'}
																					</button>
																				</div>
																			</div>
											{/if}

											{#if localAddonControlMatches('show_connections')}
												<div class="setting-item-full">
																				<div class="setting-info">
																					<span class="setting-label">ShowConnections</span>
																					<span class="setting-description">Show profile connections metadata (handle + linked URLs) in user popouts.</span>
																				</div>
																				<div class="settings-row-actions">
																					<button class="toggle-btn" class:active={showConnectionsEnabled} on:click={toggleShowConnectionsAddon}>
																						{showConnectionsEnabled ? 'ON' : 'OFF'}
																					</button>
																				</div>
																			</div>
											{/if}

											{#if localAddonControlMatches('user_notes')}
												<div class="setting-item-full">
																				<div class="setting-info">
																					<span class="setting-label">UserNotes</span>
																					<span class="setting-description">Enable local private notes for each user directly from their popout profile.</span>
																				</div>
																				<div class="settings-row-actions">
																					<button class="toggle-btn" class:active={userNotesEnabled} on:click={toggleUserNotesAddon}>
																						{userNotesEnabled ? 'ON' : 'OFF'}
																					</button>
																				</div>
																			</div>
											{/if}

											{#if localAddonControlMatches('remove_nicknames')}
												<div class="setting-item-full">
																				<div class="setting-info">
																					<span class="setting-label">RemoveNicknames</span>
																					<span class="setting-description">Prefer stable account names in chat headers when incoming messages include alias-style display names.</span>
																				</div>
																				<div class="settings-row-actions">
																					<button class="toggle-btn" class:active={removeNicknamesEnabled} on:click={toggleRemoveNicknamesAddon}>
																						{removeNicknamesEnabled ? 'ON' : 'OFF'}
																					</button>
																				</div>
																			</div>
											{/if}

											{#if localAddonControlMatches('local_nicknames')}
												<div class="setting-item-full">
																				<div class="setting-info">
																					<span class="setting-label">LocalNicknames (Wabi translation)</span>
																					<span class="setting-description">Set private per-user nicknames that only appear on this device in chat headers, popouts, and the user list.</span>
																				</div>
																				<div class="runtime-note">Local nicknames saved: {localNicknameCount}</div>
																				<div class="settings-row-actions">
																					<button class="toggle-btn" class:active={localNicknamesEnabled} on:click={toggleLocalNicknamesAddon}>
																						{localNicknamesEnabled ? 'ON' : 'OFF'}
																					</button>
																					<button class="action-btn secondary" on:click={clearAllLocalNicknamesAddon} disabled={localNicknameCount === 0}>
																						Clear Local Nicknames
																					</button>
																				</div>
																			</div>
											{/if}

											{#if localAddonControlMatches('staff_tag')}
												<div class="setting-item-full">
																				<div class="setting-info">
																					<span class="setting-label">StaffTag</span>
																					<span class="setting-description">Show a staff marker for owner/admin/mod users in message and profile surfaces.</span>
																				</div>
																				<div class="settings-row-actions">
																					<button class="toggle-btn" class:active={staffTagEnabled} on:click={toggleStaffTagAddon}>
																						{staffTagEnabled ? 'ON' : 'OFF'}
																					</button>
																				</div>
																			</div>
											{/if}

											{#if localAddonControlMatches('top_role_everywhere')}
												<div class="setting-item-full">
																				<div class="setting-info">
																					<span class="setting-label">TopRoleEverywhere</span>
																					<span class="setting-description">Show each user's top role badge beside usernames in chat and user popouts.</span>
																				</div>
																				<div class="settings-row-actions">
																					<button class="toggle-btn" class:active={topRoleEverywhereEnabled} on:click={toggleTopRoleEverywhereAddon}>
																						{topRoleEverywhereEnabled ? 'ON' : 'OFF'}
																					</button>
																				</div>
																			</div>
											{/if}
										</div>
										{/if}
									</section>
									{/if}

									{#if addonSectionHasMatches('notifications')}
									<section class="addon-accordion-section">
										<button
											type="button"
											class="addon-accordion-trigger"
											aria-expanded={isAddonSectionOpen('notifications')}
											aria-controls="addon-section-notifications"
											on:click={() => toggleAddonSection('notifications')}
										>
											<span class="addon-accordion-trigger-main">
												<span class="addon-section-chevron" aria-hidden="true">
													<svg viewBox="0 0 24 24">
														<path d="M9 6l6 6-6 6"></path>
													</svg>
												</span>
												<span class="addon-accordion-label">{ADDON_SECTION_LABELS.notifications}</span>
											</span>
											<span class="addon-accordion-count">{addonSectionMatchCount('notifications')}</span>
										</button>
										{#if isAddonSectionOpen('notifications')}
										<div class="addon-accordion-body" id="addon-section-notifications">
											{#if localAddonControlMatches('friend_notifications')}
												<div class="setting-item-full">
																				<div class="setting-info">
																					<span class="setting-label">FriendNotifications</span>
																					<span class="setting-description">Desktop notifications when people change presence status.</span>
																				</div>
																				<div class="settings-row-actions">
																					<button class="toggle-btn" class:active={friendNotificationsEnabled} on:click={toggleFriendNotificationsAddon}>
																						{friendNotificationsEnabled ? 'ON' : 'OFF'}
																					</button>
																					<button
																						class="toggle-btn"
																						class:active={friendNotificationsTrackedOnly}
																						on:click={toggleFriendNotificationsTrackedOnlyAddon}
																						disabled={!friendNotificationsEnabled}
																					>
																						Status alerts list only: {friendNotificationsTrackedOnly ? 'ON' : 'OFF'}
																					</button>
																				</div>
																				<div class="runtime-note">
																					Tracked people for status alerts: {$trackedStatusAlertPersonCountStore}. Use the People tab context menu to enable or disable alerts per person on each server.
																				</div>
																				<div class="settings-row-actions">
																					<button
																						class="action-btn secondary"
																						on:click={clearFriendNotificationTrackedUsers}
																						disabled={$trackedStatusAlertPersonCountStore === 0}
																					>
																						Clear Status Alerts List
																					</button>
																				</div>
																			</div>
											{/if}
										</div>
										{/if}
									</section>
									{/if}

									{#if addonSectionHasMatches('media')}
									<section class="addon-accordion-section">
										<button
											type="button"
											class="addon-accordion-trigger"
											aria-expanded={isAddonSectionOpen('media')}
											aria-controls="addon-section-media"
											on:click={() => toggleAddonSection('media')}
										>
											<span class="addon-accordion-trigger-main">
												<span class="addon-section-chevron" aria-hidden="true">
													<svg viewBox="0 0 24 24">
														<path d="M9 6l6 6-6 6"></path>
													</svg>
												</span>
												<span class="addon-accordion-label">{ADDON_SECTION_LABELS.media}</span>
											</span>
											<span class="addon-accordion-count">{addonSectionMatchCount('media')}</span>
										</button>
										{#if isAddonSectionOpen('media')}
										<div class="addon-accordion-body" id="addon-section-media">
											{#if localAddonControlMatches('image_utilities')}
												<div class="setting-item-full">
																				<div class="setting-info">
																					<span class="setting-label">ImageUtilities (MVP)</span>
																					<span class="setting-description">Choose the default provider for reverse image search from the image lightbox menu.</span>
																				</div>
																				<label class="upload-limit-row">
																					<span>Reverse image search provider</span>
																					<select
																						class="theme-select"
																						value={reverseImageSearchProvider}
																						on:change={(event) => updateReverseSearchProvider(event.currentTarget.value as ReverseImageSearchProvider)}
																					>
																						<option value="google_lens">Google Lens</option>
																						<option value="bing">Bing Visual Search</option>
																						<option value="tineye">TinEye</option>
																						<option value="yandex">Yandex Images</option>
																					</select>
																				</label>
																			</div>
											{/if}

											{#if localAddonControlMatches('emoji_statistics')}
												<div class="setting-item-full">
																				<div class="setting-info">
																					<span class="setting-label">EmojiStatistics</span>
																					<span class="setting-description">Show local emoji inventory stats and category breakdown in Add-ons.</span>
																				</div>
																				<div class="settings-row-actions">
																					<button class="toggle-btn" class:active={emojiStatisticsEnabled} on:click={toggleEmojiStatisticsAddon}>
																						{emojiStatisticsEnabled ? 'ON' : 'OFF'}
																					</button>
																				</div>
																				{#if emojiStatisticsEnabled}
																					<div class="runtime-note">
																						Inventory: total {$emojis.length},
																						custom {$emojis.filter((emoji) => emoji.isCustom).length},
																						default/open {$emojis.filter((emoji) => !emoji.isCustom).length}.
																					</div>
																					{#if emojiStatsCategories.length > 0}
																						<div class="runtime-note">
																							Top categories:
																							{#each emojiStatsCategories as categoryEntry, index}
																								{index > 0 ? ', ' : ''}
																								{categoryEntry.category} ({categoryEntry.count})
																							{/each}
																						</div>
																					{:else}
																						<div class="runtime-note">No emoji catalog data loaded yet.</div>
																					{/if}
																				{/if}
																			</div>
											{/if}

											{#if localAddonControlMatches('spotify_controls')}
												<div class="setting-item-full">
																				<div class="setting-info">
																					<span class="setting-label">SpotifyControls (Wabi translation)</span>
																					<span class="setting-description">Render playable Spotify mini-controls for Spotify track/album/playlist links directly in chat.</span>
																				</div>
																				<div class="settings-row-actions">
																					<button class="toggle-btn" class:active={spotifyControlsEnabled} on:click={toggleSpotifyControlsAddon}>
																						{spotifyControlsEnabled ? 'ON' : 'OFF'}
																					</button>
																				</div>
																			</div>
											{/if}

											{#if localAddonControlMatches('gif_captioner')}
												<div class="setting-item-full">
																					<div class="setting-info">
																						<span class="setting-label">GifCaptioner</span>
																						<span class="setting-description">Allow GIF sends to include caption text and keep caption rules consistent with outgoing text filters.</span>
																					</div>
																					<div class="settings-row-actions">
																						<button class="toggle-btn" class:active={gifCaptionerEnabled} on:click={toggleGifCaptionerAddon}>
																							{gifCaptionerEnabled ? 'ON' : 'OFF'}
																						</button>
																						<button
																							class="toggle-btn"
																							class:active={gifCaptionerDedicatedFieldEnabled}
																							on:click={toggleGifCaptionerDedicatedField}
																							disabled={!gifCaptionerEnabled}
																						>
																							Dedicated caption field: {gifCaptionerDedicatedFieldEnabled ? 'ON' : 'OFF'}
																						</button>
																					</div>
																					<div class="settings-row-actions">
																						<label class="upload-limit-row split-chunk-size-row">
																							<span>Caption style</span>
																							<select
																								value={gifCaptionerCaptionStyle}
																								on:change={(event) => updateGifCaptionerStyle(event.currentTarget.value)}
																								disabled={!gifCaptionerEnabled}
																							>
																								<option value="plain">Plain</option>
																								<option value="accent">Accent line</option>
																								<option value="card">Caption card</option>
																							</select>
																						</label>
																					</div>
																					<div class="runtime-note">
																						Caption limit: {GIF_CAPTIONER_MAX_CAPTION_LENGTH} characters.
																					</div>
																				</div>
											{/if}

											{#if localAddonControlMatches('zip_preview')}
												<div class="setting-item-full">
																					<div class="setting-info">
																						<span class="setting-label">ZipPreview</span>
																						<span class="setting-description">Inspect ZIP contents inline in chat, with optional per-entry text/image previews.</span>
																					</div>
																					<div class="settings-row-actions">
																						<button class="toggle-btn" class:active={zipPreviewEnabled} on:click={toggleZipPreviewAddon}>
																							{zipPreviewEnabled ? 'ON' : 'OFF'}
																						</button>
																						<button
																							class="toggle-btn"
																							class:active={zipPreviewInlineEnabled}
																							on:click={toggleZipPreviewInlineAddon}
																							disabled={!zipPreviewEnabled}
																						>
																							Inline entry preview: {zipPreviewInlineEnabled ? 'ON' : 'OFF'}
																						</button>
																					</div>
																					<div class="runtime-note">Sort preference is saved from the preview panel controls.</div>
																				</div>
											{/if}

											{#if localAddonControlMatches('more_quick_reacts')}
												<div class="setting-item-full">
																					<div class="setting-info">
																						<span class="setting-label">MoreQuickReacts</span>
																						<span class="setting-description">Show one-click quick-reaction buttons in message hover actions, with optional custom emoji shortcuts.</span>
																					</div>
																					<div class="settings-row-actions">
																						<button class="toggle-btn" class:active={quickReactionsEnabled} on:click={toggleMoreQuickReactsAddon}>
																							{quickReactionsEnabled ? 'ON' : 'OFF'}
																						</button>
																						<div class="runtime-note">
																							Custom quick set: {$quickReactionSettingsStore.customEmojiIds.length}/{MAX_CUSTOM_QUICK_REACTION_EMOJIS}
																						</div>
																					</div>
																					<div class="settings-row-actions">
																						<select class="theme-select" bind:value={quickReactionCustomEmojiIdDraft}>
																							<option value="">Select emoji to add</option>
																							{#each $emojis as emoji (emoji.id)}
																								<option value={emoji.id}>
																									{emoji.displayName || emoji.name} ({emoji.name})
																								</option>
																							{/each}
																						</select>
																						<button class="action-btn" on:click={addCustomQuickReactionEmoji} disabled={!quickReactionCustomEmojiIdDraft.trim()}>
																							Add Emoji
																						</button>
																						<button class="action-btn secondary" on:click={clearCustomQuickReactionEmojis} disabled={$quickReactionSettingsStore.customEmojiIds.length === 0}>
																							Clear Custom
																						</button>
																					</div>
																					{#if quickReactionCustomEmojiEntries.length === 0}
																						<div class="runtime-note">No custom quick reactions configured. Wabi will fall back to smart defaults.</div>
																					{:else}
																						<div class="quick-reaction-settings-list">
																							{#each quickReactionCustomEmojiEntries as emoji (emoji.id)}
																								<div class="quick-reaction-settings-row">
																									<img
																										src={emoji.url}
																										alt={emoji.displayName || emoji.name}
																										class="quick-reaction-settings-emoji"
																										loading="lazy"
																										decoding="async"
																									/>
																									<div class="quick-reaction-settings-name">{emoji.displayName || emoji.name}</div>
																									<button class="action-btn danger" on:click={() => removeCustomQuickReactionEmoji(emoji.id)}>
																										Remove
																									</button>
																								</div>
																							{/each}
																						</div>
																					{/if}
																					{#if quickReactionSettingsStatus}
																						<div class="runtime-note">{quickReactionSettingsStatus}</div>
																					{/if}
																					<div class="runtime-note">
																						Local usage counters (device-only):
																						quick-strip clicks {$quickReactionTelemetryStore.quickStripClicks},
																						picker opens {$quickReactionTelemetryStore.pickerOpens},
																						quick-strip share {formatQuickReactionShare(quickReactionClickShare)}.
																					</div>
																					<div class="settings-row-actions">
																						<button
																							class="action-btn secondary"
																							on:click={resetMoreQuickReactsTelemetry}
																							disabled={$quickReactionTelemetryStore.quickStripClicks + $quickReactionTelemetryStore.pickerOpens === 0}
																						>
																							Reset Usage Counters
																						</button>
																					</div>
																				</div>
											{/if}
										</div>
										{/if}
									</section>
									{/if}

									{#if addonSectionHasMatches('appearance')}
									<section class="addon-accordion-section">
										<button
											type="button"
											class="addon-accordion-trigger"
											aria-expanded={isAddonSectionOpen('appearance')}
											aria-controls="addon-section-appearance"
											on:click={() => toggleAddonSection('appearance')}
										>
											<span class="addon-accordion-trigger-main">
												<span class="addon-section-chevron" aria-hidden="true">
													<svg viewBox="0 0 24 24">
														<path d="M9 6l6 6-6 6"></path>
													</svg>
												</span>
												<span class="addon-accordion-label">{ADDON_SECTION_LABELS.appearance}</span>
											</span>
											<span class="addon-accordion-count">{addonSectionMatchCount('appearance')}</span>
										</button>
										{#if isAddonSectionOpen('appearance')}
										<div class="addon-accordion-body" id="addon-section-appearance">
											{#if localAddonControlMatches('timed_theme_mode')}
												<div class="setting-item-full">
																				<div class="setting-info">
																					<span class="setting-label">TimedLightDarkMode</span>
																					<span class="setting-description">Automatically switch between day and night themes using your local device time.</span>
																				</div>
																				<div class="settings-row-actions">
																					<button class="toggle-btn" class:active={timedThemeModeEnabled} on:click={toggleTimedThemeModeAddon}>
																						{timedThemeModeEnabled ? 'ON' : 'OFF'}
																					</button>
																				</div>
																				{#if timedThemeModeEnabled}
																					<div class="timed-theme-grid">
																						<label class="timed-theme-field">
																							<span>Day starts (hour)</span>
																							<input
																								class="theme-select"
																								type="number"
																								min="0"
																								max="23"
																								step="1"
																								value={timedThemeDayStartHour}
																								on:change={(event) => updateTimedThemeDayStartHour(event.currentTarget.value)}
																							/>
																						</label>
																						<label class="timed-theme-field">
																							<span>Night starts (hour)</span>
																							<input
																								class="theme-select"
																								type="number"
																								min="0"
																								max="23"
																								step="1"
																								value={timedThemeNightStartHour}
																								on:change={(event) => updateTimedThemeNightStartHour(event.currentTarget.value)}
																							/>
																						</label>
																						<label class="timed-theme-field">
																							<span>Day theme</span>
																							<select
																								class="theme-select"
																								bind:value={timedThemeLightThemeId}
																								on:change={(event) => updateTimedThemeLightTheme(event.currentTarget.value)}
																							>
																								{#each Object.values(THEMES) as theme}
																									<option value={theme.id}>{theme.name}</option>
																								{/each}
																							</select>
																						</label>
																						<label class="timed-theme-field">
																							<span>Night theme</span>
																							<select
																								class="theme-select"
																								bind:value={timedThemeDarkThemeId}
																								on:change={(event) => updateTimedThemeDarkTheme(event.currentTarget.value)}
																							>
																								{#each Object.values(THEMES) as theme}
																									<option value={theme.id}>{theme.name}</option>
																								{/each}
																							</select>
																						</label>
																					</div>
																					<div class="runtime-note">The app checks and applies scheduled theme changes automatically in the background.</div>
																				{/if}
																			</div>
											{/if}
										</div>
										{/if}
									</section>
									{/if}

									{#if addonSectionHasMatches('utilities')}
									<section class="addon-accordion-section">
										<button
											type="button"
											class="addon-accordion-trigger"
											aria-expanded={isAddonSectionOpen('utilities')}
											aria-controls="addon-section-utilities"
											on:click={() => toggleAddonSection('utilities')}
										>
											<span class="addon-accordion-trigger-main">
												<span class="addon-section-chevron" aria-hidden="true">
													<svg viewBox="0 0 24 24">
														<path d="M9 6l6 6-6 6"></path>
													</svg>
												</span>
												<span class="addon-accordion-label">{ADDON_SECTION_LABELS.utilities}</span>
											</span>
											<span class="addon-accordion-count">{addonSectionMatchCount('utilities')}</span>
										</button>
										{#if isAddonSectionOpen('utilities')}
										<div class="addon-accordion-body" id="addon-section-utilities">
											{#if localAddonControlMatches('translator_addon')}
												{#if translatorAddonDetected}
																				<div class="setting-item-full">
																					<div class="setting-info">
																						<span class="setting-label">Translator Assist Settings</span>
																						<span class="setting-description">Pick a translator model and target language. Source language is auto-detected.</span>
																					</div>
																					<div class="upload-limit-grid">
																						<label class="upload-limit-row">
																							<span>Model</span>
																							<select bind:value={translatorModel} class="theme-select" on:change={saveTranslatorAddonSettings}>
																								{#each TRANSLATOR_MODEL_OPTIONS as modelOption}
																									<option value={modelOption.id}>{modelOption.label}</option>
																								{/each}
																							</select>
																						</label>
																						<label class="upload-limit-row">
																							<span>Target language</span>
																							<input type="text" maxlength="16" bind:value={translatorTargetLang} placeholder="en" on:blur={saveTranslatorAddonSettings} />
																						</label>
																					</div>
																					<div class="runtime-note">Settings save automatically.</div>
																					{#if translatorSettingsSavedAt}
																						<div class="runtime-note">Saved at {translatorSettingsSavedAt}</div>
																					{/if}
																				</div>
											{/if}
											{/if}

											{#if localAddonControlMatches('chat_aliases')}
												<div class="setting-item-full">
																				<div class="setting-info">
																					<span class="setting-label">ChatAliases (MVP)</span>
																					<span class="setting-description">Create slash aliases. Use <code>{'{args}'}</code> in replacement to inject trailing arguments.</span>
																				</div>
																				<div class="settings-row-actions">
																					<input
																						type="text"
																						class="theme-select alias-input"
																						placeholder="/shrug"
																						bind:value={chatAliasTriggerDraft}
																					/>
																					<input
																						type="text"
																						class="theme-select alias-input"
																						placeholder="Replacement text or /command"
																						bind:value={chatAliasReplacementDraft}
																					/>
																					<button
																						class="action-btn"
																						on:click={addChatAliasFromDraft}
																						disabled={!chatAliasTriggerDraft.trim() || !chatAliasReplacementDraft.trim()}
																					>
																						Add Alias
																					</button>
																				</div>
																				{#if $chatAliasesStore.length === 0}
																					<div class="runtime-note">No aliases configured yet.</div>
																				{:else}
																					<div class="addons-list">
																						{#each $chatAliasesStore as alias (alias.id)}
																							<div class="addon-row">
																								<div class="addon-name">{alias.trigger} -> {alias.replacement}</div>
																								<div class="settings-row-actions">
																									<button class="action-btn secondary" on:click={() => toggleChatAliasEnabled(alias)}>
																										{alias.enabled ? 'Disable' : 'Enable'}
																									</button>
																									<button class="action-btn secondary" on:click={() => editChatAlias(alias)}>Edit</button>
																									<button class="action-btn danger" on:click={() => removeChatAlias(alias.id)}>Delete</button>
																								</div>
																							</div>
																						{/each}
																					</div>
																				{/if}
																			</div>
											{/if}

											{#if localAddonControlMatches('chat_filter')}
												<div class="setting-item-full">
																				<div class="setting-info">
																					<span class="setting-label">ChatFilter (MVP)</span>
																					<span class="setting-description">Censor or hide messages containing blocked terms.</span>
																				</div>
																				<div class="settings-row-actions">
																					<button class="toggle-btn" class:active={$chatFilterStore.enabled} on:click={toggleChatFilterEnabled}>
																						{$chatFilterStore.enabled ? 'ON' : 'OFF'}
																					</button>
																					<select
																						class="theme-select"
																						value={$chatFilterStore.mode}
																						on:change={(event) => updateChatFilterMode(event.currentTarget.value as ChatFilterMode)}
																						disabled={!$chatFilterStore.enabled}
																					>
																						<option value="censor">Censor text</option>
																						<option value="hide">Hide full message</option>
																					</select>
																					<button class="action-btn secondary" on:click={editChatFilterTerms}>
																						Edit Terms ({$chatFilterStore.terms.length})
																					</button>
																				</div>
																				<div class="settings-row-actions">
																					<button class="toggle-btn" class:active={$chatFilterStore.applyToIncoming} on:click={toggleChatFilterIncoming}>
																						Incoming {$chatFilterStore.applyToIncoming ? 'ON' : 'OFF'}
																					</button>
																					<button class="toggle-btn" class:active={$chatFilterStore.applyToOutgoing} on:click={toggleChatFilterOutgoing}>
																						Outgoing {$chatFilterStore.applyToOutgoing ? 'ON' : 'OFF'}
																					</button>
																				</div>
																				{#if $chatFilterStore.mode === 'censor'}
																					<label class="upload-limit-row">
																						<span>Replacement token</span>
																						<input
																							type="text"
																							maxlength="24"
																							value={$chatFilterStore.replacement}
																							on:input={(event) => updateChatFilterReplacement(event.currentTarget.value)}
																						/>
																					</label>
																				{/if}
																				<div class="runtime-note">
																					Current blocked terms: {$chatFilterStore.terms.length > 0 ? $chatFilterStore.terms.join(', ') : '(none)'}
																				</div>
																			</div>
											{/if}

											{#if localAddonControlMatches('custom_quoter')}
												<div class="setting-item-full">
																				<div class="setting-info">
																					<span class="setting-label">CustomQuoter (MVP)</span>
																					<span class="setting-description">Template used by message action <strong>Copy Quote</strong>.</span>
																				</div>
																				<textarea
																					class="addon-template-input"
																					rows="3"
																					bind:value={quoteTemplateDraft}
																					placeholder={'> {text}\\n- {user} ({timestamp})'}
																				></textarea>
																				<div class="runtime-note">Placeholders: <code>{'{user}'}</code> <code>{'{text}'}</code> <code>{'{timestamp}'}</code> <code>{'{channel}'}</code> <code>{'{message_id}'}</code></div>
																				<div class="settings-row-actions">
																					<button class="action-btn" on:click={saveQuoteTemplate}>Save Template</button>
																					<button class="action-btn secondary" on:click={resetQuoteTemplateFromSettings}>Reset Default</button>
																				</div>
																			</div>
											{/if}
										</div>
										{/if}
									</section>
									{/if}
									{/if}
								</div>
							</div>
						</div>
					{:else if activeSettingsTab === 'emojis'}
						<div class="settings-section">
							<h3>{$t('settings.sections.custom_emojis')}</h3>
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
													&times;
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
							<h3>{$t('settings.sections.admin_panel')}</h3>
							<p class="admin-help">Manage live user roles from here or from user right-click menus.</p>
							<div class="upload-limits-panel">
								<h4>Upload Limits (MB)</h4>
								<p class="admin-help">Leave a field blank for unlimited. These limits are enforced on the backend.</p>
								<div class="upload-limit-grid">
									{#each uploadRoleOrder as tier}
										<label class="upload-limit-row">
											<span>{uploadRoleLabels[tier]}</span>
											<input
												type="number"
												min="1"
												step="1"
												placeholder="Unlimited"
												bind:value={uploadLimitInputs[tier]}
												disabled={!canManageAdmin || loadingUploadLimits || savingUploadLimits}
											/>
										</label>
									{/each}
									<label class="upload-limit-row">
										<span>Global Cap</span>
										<input
											type="number"
											min="1"
											step="1"
											placeholder="Unlimited"
											bind:value={globalUploadLimitInput}
											disabled={!canManageAdmin || loadingUploadLimits || savingUploadLimits}
										/>
									</label>
								</div>
								<button class="action-btn" on:click={saveUploadLimits} disabled={!canManageAdmin || loadingUploadLimits || savingUploadLimits}>
									{savingUploadLimits ? 'Saving...' : 'Save Upload Limits'}
								</button>
							</div>
							<div class="upload-limits-panel">
								<h4>Server Donations</h4>
								<p class="admin-help">Configure a single server donation route. Users will see transparency totals and a donate flow based on this setup.</p>
								<div class="setting-item">
									<div class="setting-info">
										<span class="setting-label">Enable Donations</span>
										<span class="setting-description">Show the server donation entry and allow donation-tagged payment requests.</span>
									</div>
									<button
										class="toggle-btn"
										class:active={adminDonationConfig.enabled}
										on:click={() => adminDonationConfig = { ...adminDonationConfig, enabled: !adminDonationConfig.enabled }}
									>
										{adminDonationConfig.enabled ? 'ON' : 'OFF'}
									</button>
								</div>
								<div class="quality-mode-row">
									<label for="donation-provider-select">Donation Provider</label>
									<select
										id="donation-provider-select"
										class="theme-select"
										value={adminDonationConfig.providerPluginId || ''}
										on:change={(event) => {
											const providerPluginId = event.currentTarget.value || null;
											const selectedProvider = paymentProviderCapabilities.find((provider) => provider.pluginId === providerPluginId) || null;
											adminDonationConfig = {
												...adminDonationConfig,
												providerPluginId,
												methodId: selectedProvider?.methods[0]?.id || null
											};
										}}
									>
										<option value="">Select provider</option>
										{#each paymentProviderCapabilities as provider}
											<option value={provider.pluginId}>{provider.providerName} ({provider.pluginId})</option>
										{/each}
									</select>
								</div>
								<div class="quality-mode-row">
									<label for="donation-method-select">Donation Method</label>
									<select
										id="donation-method-select"
										class="theme-select"
										value={adminDonationConfig.methodId || ''}
										on:change={(event) => adminDonationConfig = { ...adminDonationConfig, methodId: event.currentTarget.value || null }}
									>
										<option value="">Select method</option>
										{#each adminDonationMethods as method}
											<option value={method.id}>{method.label}</option>
										{/each}
									</select>
								</div>
								<div class="quality-mode-row">
									<label for="donation-currency-select">Currency</label>
									{#if adminDonationCurrencyOptions.length > 0}
										<select
											id="donation-currency-select"
											class="theme-select"
											value={adminDonationConfig.currency}
											on:change={(event) => adminDonationConfig = { ...adminDonationConfig, currency: event.currentTarget.value.toUpperCase() }}
										>
											{#each adminDonationCurrencyOptions as option}
												<option value={option}>{option}</option>
											{/each}
										</select>
									{:else}
										<input
											id="donation-currency-select"
											class="emoji-name-input"
											maxlength="3"
											value={adminDonationConfig.currency}
											on:input={(event) => adminDonationConfig = { ...adminDonationConfig, currency: event.currentTarget.value.toUpperCase() }}
										/>
									{/if}
								</div>
								<div class="quality-mode-row">
									<label for="donation-country-select">Country</label>
									{#if adminDonationCountryOptions.length > 0}
										<select
											id="donation-country-select"
											class="theme-select"
											value={adminDonationConfig.countryCode || ''}
											on:change={(event) => adminDonationConfig = { ...adminDonationConfig, countryCode: event.currentTarget.value.toUpperCase() || null }}
										>
											{#each adminDonationCountryOptions as option}
												<option value={option}>{option}</option>
											{/each}
										</select>
									{:else}
										<input
											id="donation-country-select"
											class="emoji-name-input"
											maxlength="2"
											value={adminDonationConfig.countryCode || ''}
											on:input={(event) => adminDonationConfig = { ...adminDonationConfig, countryCode: event.currentTarget.value.toUpperCase() || null }}
										/>
									{/if}
								</div>
								<div class="donation-audit-panel">
									<div class="donation-audit-header">
										<div>
											<h5>Public Donation Route Preview</h5>
											<p class="admin-help">This is the exact route the public donation sheet will use.</p>
										</div>
										<button class="action-btn" on:click={openServerDonation}>
											Preview Public View
										</button>
									</div>
									<div class="donation-audit-list">
										<div class="donation-audit-item">
											<div class="donation-audit-copy">
												<strong>{adminDonationSelectedProvider?.providerName || 'No provider selected'}</strong>
												<span>{adminDonationSelectedMethod?.label || 'No method selected'}</span>
												<small>{adminDonationConfig.countryCode || 'Any country'} - {adminDonationConfig.currency || 'Any currency'}</small>
												<small>Suggested amounts: {getDonationRouteSummaryList(parseSuggestedAmountsInput(donationSuggestedAmountsInput))}</small>
												{#if adminDonationSelectedProvider?.notes}
													<small>{adminDonationSelectedProvider.notes}</small>
												{/if}
												{#if adminDonationSelectedMethod?.notes}
													<small>{adminDonationSelectedMethod.notes}</small>
												{/if}
											</div>
											<button
												class="action-btn"
												disabled={!donationRoutePreviewReady}
												on:click={openServerDonation}
											>
												{donationRoutePreviewReady ? 'Route Ready' : 'Needs Setup'}
											</button>
										</div>
									</div>
								</div>
								<div class="quality-mode-row">
									<label for="donation-headline-input">Headline</label>
									<input
										id="donation-headline-input"
										class="emoji-name-input"
										maxlength="120"
										value={adminDonationConfig.headline}
										on:input={(event) => adminDonationConfig = { ...adminDonationConfig, headline: event.currentTarget.value }}
									/>
								</div>
								<div class="quality-mode-row">
									<label for="donation-description-input">Description</label>
									<input
										id="donation-description-input"
										class="emoji-name-input"
										maxlength="500"
										value={adminDonationConfig.description}
										on:input={(event) => adminDonationConfig = { ...adminDonationConfig, description: event.currentTarget.value }}
									/>
								</div>
								<div class="quality-mode-row">
									<label for="donation-amounts-input">Suggested Amounts</label>
									<input
										id="donation-amounts-input"
										class="emoji-name-input"
										placeholder="5, 10, 25"
										bind:value={donationSuggestedAmountsInput}
									/>
								</div>
								<button class="action-btn" on:click={saveDonationConfig} disabled={!canManageAdmin || adminDonationConfigLoading || adminDonationConfigSaving}>
									{adminDonationConfigSaving ? 'Saving...' : 'Save Donation Settings'}
								</button>
								<div class="donation-audit-panel">
									<div class="donation-audit-header">
										<div>
											<h5>Donation Audit Trail</h5>
											<p class="admin-help">This covers server donations only. Direct user-to-user payments stay private.</p>
										</div>
										<button
											class="action-btn"
											on:click={() => {
												adminDonationAuditLoaded = false;
												void loadAdminDonationAudit();
											}}
											disabled={adminDonationAuditLoading || adminDonationRefundingIntentId !== ''}
										>
											{adminDonationAuditLoading ? 'Refreshing...' : 'Refresh Audit'}
										</button>
									</div>
									{#if adminDonationAuditLoading && adminDonationAudit.length === 0}
										<p class="admin-help">Loading donation audit trail...</p>
									{:else if adminDonationAudit.length === 0}
										<p class="admin-help">No donation activity yet.</p>
									{:else}
										<div class="donation-audit-list">
											{#each adminDonationAudit as entry (entry.intentId)}
												<div class="donation-audit-item">
													<div class="donation-audit-copy">
														<strong>{entry.donorLabel}</strong>
														<span>{formatDonationAuditAmount(entry.amountMinor, entry.currency)}</span>
														<small>{formatDonationAuditWhen(entry)} | {entry.status}</small>
													</div>
													<button
														class="action-btn"
														disabled={!entry.canRefund || adminDonationRefundingIntentId !== '' || !canManageAdmin}
														on:click={() => refundDonation(entry)}
													>
														{adminDonationRefundingIntentId === entry.intentId ? 'Refunding...' : (entry.canRefund ? 'Refund' : 'Closed')}
													</button>
												</div>
											{/each}
										</div>
									{/if}
								</div>
								<div class="donation-audit-panel">
									<div class="donation-audit-header">
										<div>
											<h5>Offline / Manual Donations</h5>
											<p class="admin-help">Record in-person cash or off-platform donations here. These are visible in server donation transparency, but they are not provider-verified.</p>
										</div>
										<button
											class="action-btn"
											on:click={() => {
												adminOfflineDonationAuditLoaded = false;
												void loadAdminOfflineDonationAudit();
											}}
											disabled={adminOfflineDonationAuditLoading || adminOfflineDonationVoidingSettlementId !== '' || adminOfflineDonationSaving}
										>
											{adminOfflineDonationAuditLoading ? 'Refreshing...' : 'Refresh Offline Log'}
										</button>
									</div>
									<div class="offline-donation-form">
										<label class="upload-limit-row">
											<span>Amount</span>
											<input
												type="text"
												placeholder="10.00"
												bind:value={offlineDonationAmountInput}
												disabled={!canManageAdmin || adminOfflineDonationSaving}
											/>
										</label>
										<label class="upload-limit-row">
											<span>Currency</span>
											<input
												type="text"
												maxlength="3"
												placeholder="USD"
												bind:value={offlineDonationCurrency}
												disabled={!canManageAdmin || adminOfflineDonationSaving}
											/>
										</label>
										<label class="upload-limit-row">
											<span>Masked Donor Label</span>
											<input
												type="text"
												maxlength="120"
												placeholder="Dot"
												bind:value={offlineDonationDonorLabel}
												disabled={!canManageAdmin || adminOfflineDonationSaving}
											/>
										</label>
										<label class="upload-limit-row">
											<span>Note</span>
											<input
												type="text"
												maxlength="280"
												placeholder="Paid in cash after local meetup"
												bind:value={offlineDonationDescription}
												disabled={!canManageAdmin || adminOfflineDonationSaving}
											/>
										</label>
									</div>
									<button class="action-btn" on:click={createOfflineDonationRecord} disabled={!canManageAdmin || adminOfflineDonationSaving}>
										{adminOfflineDonationSaving ? 'Recording...' : 'Record Offline Donation'}
									</button>
									{#if adminOfflineDonationAuditLoading && adminOfflineDonationAudit.length === 0}
										<p class="admin-help">Loading offline donation log...</p>
									{:else if adminOfflineDonationAudit.length === 0}
										<p class="admin-help">No offline donations recorded yet.</p>
									{:else}
										<div class="donation-audit-list">
											{#each adminOfflineDonationAudit as entry (entry.settlementId)}
												<div class="donation-audit-item">
													<div class="donation-audit-copy">
														<strong>{entry.donorLabel}</strong>
														<span>{formatDonationAuditAmount(entry.amountMinor, entry.currency)}</span>
														<small>{formatDonationAuditWhen(entry)} | {entry.status} | {entry.recordedByLabel || 'Admin record'}</small>
														{#if entry.description}
															<small>{entry.description}</small>
														{/if}
													</div>
													<button
														class="action-btn"
														disabled={!entry.canVoid || adminOfflineDonationVoidingSettlementId !== '' || !canManageAdmin}
														on:click={() => voidOfflineDonation(entry)}
													>
														{adminOfflineDonationVoidingSettlementId === entry.settlementId ? 'Voiding...' : (entry.canVoid ? 'Void' : 'Closed')}
													</button>
												</div>
											{/each}
										</div>
									{/if}
								</div>
								<div class="donation-audit-panel">
									<div class="donation-audit-header">
										<div>
											<h5>Community Nodes</h5>
											<p class="admin-help">See which relay-style nodes are up, down, pending, or degraded. This is the live server roster, not a private admin notification.</p>
										</div>
										<button
											class="action-btn"
											on:click={() => {
												adminRelayRosterLoaded = false;
												void loadAdminRelayRoster();
											}}
											disabled={adminRelayRosterLoading || adminRelayApproveBusyId !== null || adminRelayDeleteBusyId !== null}
										>
											{adminRelayRosterLoading ? 'Refreshing...' : 'Refresh Nodes'}
										</button>
									</div>
									<div class="upload-limits-panel">
										<h4>Node Access Policy</h4>
										<p class="admin-help">Control who can activate desktop helper mode on this server.</p>
										<div class="setting-item">
											<label for="community-node-access-mode">Access Mode</label>
											<select
												id="community-node-access-mode"
												bind:value={communityNodeAccess.mode}
												disabled={!canManageAdmin || communityNodeAccessLoading || communityNodeAccessSaving}
											>
												<option value="open">Open</option>
												<option value="approval_required">Approval Required</option>
												<option value="whitelist_only">Whitelist Only</option>
											</select>
										</div>
										{#if communityNodeAccess.mode === 'whitelist_only'}
											<div class="setting-item">
												<label for="community-node-whitelist-online">Add Online User</label>
												<div class="input-with-button">
													<select
														id="community-node-whitelist-online"
														bind:value={communityNodeWhitelistSelectedUserId}
														disabled={!canManageAdmin || communityNodeAccessLoading || communityNodeAccessSaving}
													>
														<option value="">Select a user</option>
														{#each communityNodeWhitelistCandidates as user}
															<option value={String(user.dbUserId)}>#{user.username}</option>
														{/each}
													</select>
													<button
														class="action-btn"
														on:click={addSelectedCommunityNodeWhitelistUser}
														disabled={!communityNodeWhitelistSelectedUserId || !canManageAdmin || communityNodeAccessLoading || communityNodeAccessSaving}
													>
														Add
													</button>
												</div>
											</div>
											<div class="setting-item">
												<label for="community-node-whitelist-username">Add By Username</label>
												<div class="input-with-button">
													<input
														id="community-node-whitelist-username"
														type="text"
														placeholder="Exact registered username"
														bind:value={communityNodeWhitelistUsernameInput}
														disabled={!canManageAdmin || communityNodeAccessLoading || communityNodeAccessSaving}
													/>
													<button
														class="action-btn"
														on:click={addTypedCommunityNodeWhitelistUser}
														disabled={!communityNodeWhitelistUsernameInput.trim() || !canManageAdmin || communityNodeAccessLoading || communityNodeAccessSaving}
													>
														Stage
													</button>
												</div>
												<p class="admin-help">Typed usernames are validated when you save the policy.</p>
											</div>
											<div class="setting-item">
												<div class="setting-label">Allowed Users</div>
												{#if communityNodeAccess.allowedUsers.length === 0 && communityNodeWhitelistPendingUsernames.length === 0}
													<p class="admin-help">No users are currently whitelisted.</p>
												{:else}
													<div class="quick-reaction-custom-list">
														{#each communityNodeAccess.allowedUsers as entry (entry.userId)}
															<div class="quick-reaction-custom-item">
																<span>#{entry.username}</span>
																<button
																	class="action-btn danger"
																	on:click={() => removeCommunityNodeWhitelistUser(entry.userId)}
																	disabled={!canManageAdmin || communityNodeAccessLoading || communityNodeAccessSaving}
																>
																	Remove
																</button>
															</div>
														{/each}
														{#each communityNodeWhitelistPendingUsernames as username (username)}
															<div class="quick-reaction-custom-item">
																<span>#{username} (pending)</span>
																<button
																	class="action-btn danger"
																	on:click={() => removePendingCommunityNodeWhitelistUsername(username)}
																	disabled={!canManageAdmin || communityNodeAccessLoading || communityNodeAccessSaving}
																>
																	Remove
																</button>
															</div>
														{/each}
													</div>
												{/if}
											</div>
										{/if}
										{#if communityNodeAccessStatus}
											<p class="admin-help">{communityNodeAccessStatus}</p>
										{/if}
										<button
											class="action-btn"
											on:click={saveCommunityNodeAccess}
											disabled={!canManageAdmin || communityNodeAccessLoading || communityNodeAccessSaving}
										>
											{communityNodeAccessSaving ? 'Saving...' : 'Save Node Access Policy'}
										</button>
									</div>
									<div class="upload-limits-panel">
										<h4>Node Announcements</h4>
										<p class="admin-help">Optionally post helper up/down events into one channel. Placeholders: {'{node}'}, {'{user}'}, {'{mode}'}, {'{status}'}.</p>
										<label class="setting-toggle">
											<input
												type="checkbox"
												bind:checked={communityNodeAnnouncements.enabled}
												disabled={!canManageAdmin || communityNodeAnnouncementsLoading || communityNodeAnnouncementsSaving}
											/>
											<span>Post community node status messages</span>
										</label>
										<div class="setting-item">
											<label for="community-node-announcement-channel">Announcement Channel</label>
											<select
												id="community-node-announcement-channel"
												bind:value={communityNodeAnnouncements.channelId}
												disabled={!canManageAdmin || communityNodeAnnouncementsLoading || communityNodeAnnouncementsSaving}
											>
												<option value={null}>No channel selected</option>
												{#each communityAnnouncementChannelOptions as channel}
													<option value={channel.id}>#{channel.name}</option>
												{/each}
											</select>
										</div>
										<div class="setting-item">
											<label for="community-node-announcement-online">Online Message</label>
											<input
												id="community-node-announcement-online"
												type="text"
												bind:value={communityNodeAnnouncements.onlineTemplate}
												maxlength="280"
												disabled={!canManageAdmin || communityNodeAnnouncementsLoading || communityNodeAnnouncementsSaving}
											/>
										</div>
										<div class="setting-item">
											<label for="community-node-announcement-offline">Offline Message</label>
											<input
												id="community-node-announcement-offline"
												type="text"
												bind:value={communityNodeAnnouncements.offlineTemplate}
												maxlength="280"
												disabled={!canManageAdmin || communityNodeAnnouncementsLoading || communityNodeAnnouncementsSaving}
											/>
										</div>
										{#if communityNodeAnnouncementsStatus}
											<p class="admin-help">{communityNodeAnnouncementsStatus}</p>
										{/if}
										<button
											class="action-btn"
											on:click={saveCommunityNodeAnnouncements}
											disabled={!canManageAdmin || communityNodeAnnouncementsLoading || communityNodeAnnouncementsSaving}
										>
											{communityNodeAnnouncementsSaving ? 'Saving...' : 'Save Node Announcement Settings'}
										</button>
									</div>
									{#if adminRelayRosterLoading && adminRelayRoster.length === 0}
										<p class="admin-help">Loading community nodes...</p>
									{:else if adminRelayRoster.length === 0}
										<p class="admin-help">No community nodes have registered yet.</p>
									{:else}
										<div class="donation-audit-list">
											{#each adminRelayRoster as relay (relay.relay_id)}
												<div class="donation-audit-item">
													<div class="donation-audit-copy">
														<strong>{relay.name}</strong>
														<span>{getAdminRelayKindLabel(relay)} - {relay.status}</span>
														{#if getAdminRelayOwnerLabel(relay)}
															<small>{getAdminRelayOwnerLabel(relay)}</small>
														{/if}
														<small>{relay.region} - {getAdminRelayCapabilitiesSummary(relay)}</small>
														<small>Last seen: {formatRelaySeenAt(relay.last_health_ping)}</small>
														<small>{relay.url}</small>
														{#if relay.metadata?.reason}
															<small>{relay.metadata.reason}</small>
														{/if}
													</div>
													<div class="admin-user-actions">
														<button
															class="action-btn"
															disabled={relay.approved === 1 || adminRelayApproveBusyId !== null}
															on:click={() => approveRelayNode(relay)}
														>
															{adminRelayApproveBusyId === relay.relay_id ? 'Approving...' : (relay.approved === 1 ? 'Approved' : 'Approve')}
														</button>
														<button
															class="action-btn danger"
															disabled={adminRelayDeleteBusyId !== null}
															on:click={() => deleteRelayNode(relay)}
														>
															{adminRelayDeleteBusyId === relay.relay_id ? 'Removing...' : 'Remove'}
														</button>
													</div>
												</div>
											{/each}
										</div>
									{/if}
								</div>
							</div>
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
											<button
												class="action-btn"
												disabled={!canManageTargetUser(user)}
												on:click={() => promptAdminPasswordReset(user)}
											>
												Reset Password
											</button>
											<button
												class="action-btn"
												disabled={!canManageTargetUser(user)}
												on:click={() => clearUserLoginLockout(user)}
											>
												Clear Lockout
											</button>
										</div>
									</div>
								{/each}
							</div>
						</div>

					{:else if activeSettingsTab === 'about'}
						<div class="settings-section">
							<h3>{$t('settings.sections.about')}</h3>
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
	isOpen={showClearDataConfirm}
	overlayZIndex={'var(--z-settings-nested)'}
	title={$t('settings.confirm.clear_local_title')}
	message={$t('settings.confirm.clear_local_message')}
	confirmText={$t('settings.confirm.clear_local_confirm')}
	variant="danger"
	onConfirm={confirmClearData}
	onCancel={() => showClearDataConfirm = false}
/>

<ConfirmDialog
	isOpen={showClearServerConfirm}
	overlayZIndex={'var(--z-settings-nested)'}
	title={$t('settings.confirm.clear_server_title')}
	message={$t('settings.confirm.clear_server_message')}
	confirmText={$t('settings.confirm.clear_server_confirm')}
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
		z-index: var(--z-settings-shell);
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

	.header-actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.header-locale-label {
		font-size: 0.8rem;
		color: var(--text-secondary);
	}

	.header-locale-select {
		background: var(--bg-primary);
		color: var(--text-primary);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.3rem 0.45rem;
		font-size: 0.8rem;
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

	.setting-item-stack {
		flex-direction: column;
		align-items: stretch;
		gap: 0.8rem;
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

	.warning-text {
		margin: 0 0 0.35rem;
		color: #ffcc80;
		font-size: 0.88rem;
		font-weight: 600;
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

	.addons-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
	}

	.addons-runtime-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
		gap: 1rem;
	}

	.addons-settings-window {
		display: flex;
		flex-direction: column;
		min-height: 0;
		max-height: min(58vh, 1100px);
		border: 1px solid color-mix(in srgb, var(--border) 88%, rgba(var(--accent-rgb), 0.18));
		border-radius: 16px;
		background:
			linear-gradient(180deg, color-mix(in srgb, var(--bg-secondary) 88%, transparent), color-mix(in srgb, var(--bg-tertiary) 94%, transparent)),
			color-mix(in srgb, var(--bg-tertiary) 92%, transparent);
		overflow: hidden;
	}

	.addons-settings-window-header {
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
		padding: 0.9rem 1rem;
		border-bottom: 1px solid var(--border);
		background: color-mix(in srgb, var(--bg-secondary) 88%, rgba(var(--accent-rgb), 0.08));
	}

	.addons-settings-window-body {
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
		padding: 1rem;
		padding-right: 0.8rem;
		overflow-y: auto;
		min-height: 320px;
	}

	.addons-settings-toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: end;
		gap: 0.85rem;
	}

	.addons-search-field {
		display: flex;
		flex: 1 1 260px;
		flex-direction: column;
		gap: 0.35rem;
		min-width: 0;
	}

	.addons-search-label {
		font-size: 0.74rem;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-secondary);
	}

	.addon-search-input {
		width: 100%;
		min-width: 0;
	}

	.addons-search-meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.65rem;
		justify-content: space-between;
	}

	.addon-search-clear {
		padding: 0.55rem 0.8rem;
		font-size: 0.82rem;
	}

	.addon-empty-state {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.65rem;
		padding: 1rem;
		border: 1px dashed color-mix(in srgb, var(--border) 82%, rgba(var(--accent-rgb), 0.22));
		border-radius: 10px;
		background: color-mix(in srgb, var(--bg-secondary) 92%, transparent);
	}

	.addon-empty-state-title {
		font-size: 0.95rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.addon-accordion-section {
		display: flex;
		flex-direction: column;
		border: 1px solid color-mix(in srgb, var(--border) 88%, rgba(var(--accent-rgb), 0.16));
		border-radius: 14px;
		background:
			linear-gradient(180deg, color-mix(in srgb, var(--bg-secondary) 92%, transparent), color-mix(in srgb, var(--bg-tertiary) 94%, transparent)),
			color-mix(in srgb, var(--bg-secondary) 94%, transparent);
		overflow: hidden;
	}

	.addon-accordion-trigger {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		width: 100%;
		padding: 0.82rem 0.95rem;
		border: none;
		background: transparent;
		color: var(--text-primary);
		cursor: pointer;
		text-align: left;
		transition:
			background 0.18s ease,
			border-color 0.18s ease;
	}

	.addon-accordion-trigger:hover {
		background: color-mix(in srgb, var(--bg-hover) 86%, rgba(var(--accent-rgb), 0.06));
	}

	.addon-accordion-trigger[aria-expanded='true'] {
		background: color-mix(in srgb, var(--bg-hover) 82%, rgba(var(--accent-rgb), 0.12));
	}

	.addon-accordion-trigger-main {
		display: flex;
		align-items: center;
		gap: 0.65rem;
		min-width: 0;
	}

	.addon-section-chevron {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 12px;
		height: 12px;
		transform-origin: center;
		transition: transform 0.18s ease;
		color: var(--text-secondary);
	}

	.addon-section-chevron svg {
		width: 12px;
		height: 12px;
		fill: none;
		stroke: currentColor;
		stroke-width: 2.5;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.addon-accordion-trigger[aria-expanded='true'] .addon-section-chevron {
		transform: rotate(90deg);
	}

	.addon-accordion-label {
		font-size: 0.92rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.addon-accordion-count {
		flex-shrink: 0;
		min-width: 1.8rem;
		padding: 0.12rem 0.42rem;
		border-radius: 999px;
		background: color-mix(in srgb, var(--bg-tertiary) 76%, rgba(var(--accent-rgb), 0.14));
		font-size: 0.74rem;
		font-weight: 600;
		color: var(--text-secondary);
		text-align: center;
	}

	.addon-accordion-body {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 0.82rem 0.9rem 0.95rem;
		border-top: 1px solid color-mix(in srgb, var(--border) 84%, transparent);
		background: color-mix(in srgb, var(--bg-secondary) 82%, transparent);
	}

	.addons-list {
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
	}

	.addon-row {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		padding: 0.65rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-tertiary);
	}

	.addon-name {
		font-weight: 600;
		color: var(--text-primary);
	}

	.addon-meta {
		font-size: 0.78rem;
		color: var(--text-secondary);
	}

	.addon-source {
		font-family: monospace;
		font-size: 0.72rem;
		color: var(--text-tertiary);
		word-break: break-all;
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

	.action-btn.secondary {
		background: var(--bg-tertiary);
		color: var(--text-primary);
		border: 1px solid var(--border);
	}

	.action-btn.secondary:hover {
		background: var(--bg-hover);
		transform: translateY(-1px);
	}

	.settings-row-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.55rem;
		margin-bottom: 0.55rem;
	}

	.timed-theme-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 0.55rem;
		margin-bottom: 0.55rem;
	}

	.timed-theme-field {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		font-size: 0.78rem;
		color: var(--text-secondary);
	}

	.alias-input {
		min-width: 220px;
	}

	.addon-template-input {
		width: 100%;
		resize: vertical;
		min-height: 88px;
		font-family: monospace;
		background: var(--bg-secondary);
		color: var(--text-primary);
		border: 1px solid var(--ui-bg-light);
		border-radius: 8px;
		padding: 0.6rem 0.75rem;
	}

	.quick-reaction-settings-list {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
	}

	.custom-status-preset-list {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
	}

	.custom-status-preset-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.55rem;
		padding: 0.55rem 0.65rem;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-secondary);
	}

	.custom-status-preset-main {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		min-width: 0;
	}

	.custom-status-preset-label {
		font-size: 0.9rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.custom-status-preset-meta {
		font-size: 0.82rem;
		color: var(--text-secondary);
		max-width: 42ch;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.quick-reaction-settings-row {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		padding: 0.5rem 0.6rem;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-secondary);
	}

	.quick-reaction-settings-emoji {
		width: 24px;
		height: 24px;
		object-fit: contain;
		flex-shrink: 0;
	}

	.quick-reaction-settings-name {
		font-size: 0.88rem;
		color: var(--text-primary);
		flex: 1;
		min-width: 0;
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

	.action-btn.install {
		background: rgba(var(--accent-rgb), 0.2);
		color: var(--text-primary);
		border: 1px solid rgba(var(--accent-rgb), 0.35);
	}

	.action-btn.install:hover {
		background: rgba(var(--accent-rgb), 0.28);
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

	.upload-limits-panel {
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 0.75rem;
		margin-bottom: 1rem;
	}

	.upload-limits-panel h4 {
		margin: 0 0 0.5rem;
		font-size: 0.95rem;
	}

	.upload-limit-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 0.5rem;
		margin-bottom: 0.75rem;
	}

	.upload-limit-row {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.85rem;
		color: var(--text-secondary);
	}

	.upload-limit-row input {
		padding: 0.45rem 0.55rem;
		border-radius: 8px;
		border: 1px solid var(--border);
		background: var(--bg-primary);
		color: var(--text-primary);
	}

	.donation-audit-panel {
		margin-top: 1rem;
		padding-top: 1rem;
		border-top: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.donation-audit-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.donation-audit-header h5 {
		margin: 0 0 0.25rem;
		font-size: 0.9rem;
	}

	.donation-audit-list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.offline-donation-form {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.75rem;
	}

	.donation-audit-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.65rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-secondary);
	}

	.donation-audit-copy {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		min-width: 0;
	}

	.donation-audit-copy span {
		font-size: 0.9rem;
	}

	.donation-audit-copy small {
		color: var(--text-secondary);
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

	.synth-editor-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 0.75rem;
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

	/* Theme preview cards */
	.theme-cards {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
		gap: 0.65rem;
		width: 100%;
		margin-top: 0.5rem;
	}

	.theme-card {
		display: flex;
		flex-direction: column;
		border-radius: 10px;
		border: 2px solid var(--border);
		overflow: hidden;
		background: transparent;
		cursor: pointer;
		transition: border-color 0.15s, transform 0.12s, box-shadow 0.15s;
		padding: 0;
		text-align: left;
	}

	.theme-card:hover {
		border-color: var(--accent-hex, var(--accent));
		transform: translateY(-2px);
		box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
	}

	.theme-card.active {
		border-color: var(--accent-hex, var(--accent));
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-hex, #5865f2) 25%, transparent);
	}

	.theme-card-preview {
		width: 100%;
		height: 72px;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.theme-preview-top {
		height: 18px;
		flex-shrink: 0;
	}

	.theme-preview-content {
		flex: 1;
		padding: 6px 8px;
		display: flex;
		flex-direction: column;
		gap: 4px;
		justify-content: center;
	}

	.theme-preview-bar {
		height: 4px;
		border-radius: 2px;
	}

	.theme-preview-bar.long { width: 75%; }
	.theme-preview-bar.short { width: 50%; }

	.theme-preview-accent {
		height: 5px;
		width: 28%;
		border-radius: 2px;
		margin-top: 2px;
	}

	.theme-card-footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.35rem 0.55rem;
		background: var(--bg-secondary);
		border-top: 1px solid var(--border);
	}

	.theme-card-name {
		font-size: 0.72rem;
		font-weight: 600;
		color: var(--text-primary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.theme-card-badge {
		font-size: 0.7rem;
		font-weight: 700;
		color: var(--accent-hex, var(--accent));
		flex-shrink: 0;
		margin-left: 0.25rem;
	}

	.density-toggle {
		display: flex;
		gap: 0;
		border-radius: 8px;
		overflow: hidden;
		border: 1px solid var(--border);
		flex-shrink: 0;
	}

	.density-btn {
		padding: 0.45rem 1rem;
		background: var(--bg-secondary);
		border: none;
		color: var(--text-secondary);
		font-size: 0.85rem;
		font-weight: 500;
		cursor: pointer;
		transition: background 0.15s, color 0.15s;
	}

	.density-btn:first-child {
		border-right: 1px solid var(--border);
	}

	.density-btn:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.density-btn.active {
		background: var(--accent-hex, var(--accent));
		color: #fff;
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

		.addons-settings-window {
			max-height: min(52dvh, 760px);
		}

		.addons-settings-toolbar {
			flex-direction: column;
			align-items: stretch;
		}

		.addons-search-meta {
			align-items: flex-start;
		}

		.addons-settings-window-body {
			min-height: 260px;
			padding: 0.85rem;
		}

		.addon-accordion-body {
			padding: 0.85rem;
		}
	}
</style>
