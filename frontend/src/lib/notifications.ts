/**
 * notifications.ts (unified re-export)
 * Maintains 100% backward compatibility
 *
 * Re-exports from:
 * - notificationAudio.ts: Audio context and synth ringtones
 * - notificationDisplay.ts: Notification UI and display logic
 * - notificationSettings.ts: Settings and preferences management
 */

// ============================================================================
// RE-EXPORTS FROM notificationAudio.ts
// ============================================================================

export {
	stopCallRingtone,
	getDefaultCustomSynthRingtonePreset,
	sanitizeCustomSynthRingtonePreset,
	type CallRingtoneMode,
	type CustomSynthWaveform,
	type CustomSynthRingtonePreset
} from './notificationAudio';

// ============================================================================
// RE-EXPORTS FROM notificationDisplay.ts
// ============================================================================

export {
	showNotification,
	showCallNotification,
	messageMentionsUser,
	requestNotificationPermission,
	playCallRingtone,
	playNotificationSound
} from './notificationDisplay';

// ============================================================================
// RE-EXPORTS FROM notificationSettings.ts
// ============================================================================

export {
	getNotificationSound,
	getNotificationVolume,
	getCallRingtoneMode,
	getCallRingtoneCustomAudio,
	getStoredCustomSynthRingtonePreset,
	getCallRingtoneVolume,
	getNotificationSquelchSettings,
	areNotificationsEnabled,
	isNotificationPreviewEnabled
} from './notificationSettings';
