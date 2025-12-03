import { browser } from '$app/environment';
import type { Message } from '$lib/socket';

// Audio element for playing notification sounds
let notificationAudio: HTMLAudioElement | null = null;

// Get the notification sound from settings (default to ProjectSound.ogg)
function getNotificationSound(): string {
	if (!browser) return '/sounds/ProjectSound.ogg';
	return localStorage.getItem('notificationSound') || '/sounds/ProjectSound.ogg';
}

// Get notification volume from settings (default to 50%)
function getNotificationVolume(): number {
	if (!browser) return 0.5;
	const volume = localStorage.getItem('notificationVolume');
	return volume ? parseFloat(volume) : 0.5;
}

export function playNotificationSound() {
	if (!browser) return;

	try {
		// Create or reuse audio element
		if (!notificationAudio) {
			notificationAudio = new Audio();
		}

		// Set the sound file and volume
		notificationAudio.src = getNotificationSound();
		notificationAudio.volume = getNotificationVolume();

		// Play the sound
		notificationAudio.play().catch(err => {
			console.error('Failed to play notification sound:', err);
		});
	} catch (err) {
		console.error('Error setting up notification sound:', err);
	}
}

export function playCallRingtone() {
	if (!browser) return;

	initAudio();
	if (!audioContext) return;

	// Create a repeating ringtone pattern
	const playRingPattern = () => {
		const oscillator1 = audioContext!.createOscillator();
		const oscillator2 = audioContext!.createOscillator();
		const gainNode = audioContext!.createGain();

		oscillator1.connect(gainNode);
		oscillator2.connect(gainNode);
		gainNode.connect(audioContext!.destination);

		// Two-tone ringtone
		oscillator1.frequency.value = 480;
		oscillator2.frequency.value = 620;
		oscillator1.type = 'sine';
		oscillator2.type = 'sine';

		// Volume
		gainNode.gain.setValueAtTime(0.15, audioContext!.currentTime);
		gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext!.currentTime + 0.8);

		// Play for 800ms
		oscillator1.start(audioContext!.currentTime);
		oscillator2.start(audioContext!.currentTime);
		oscillator1.stop(audioContext!.currentTime + 0.8);
		oscillator2.stop(audioContext!.currentTime + 0.8);
	};

	// Play pattern twice with a gap
	playRingPattern();
	setTimeout(playRingPattern, 1000);
}

export function showNotification(message: Message, isCurrentUser: boolean, channelName?: string) {
	if (!browser) return;

	// Don't notify for own messages
	if (isCurrentUser) return;

	// Check if notifications are enabled (defaults to true if not set)
	const notificationsEnabled = localStorage.getItem('notificationsEnabled') !== 'false';
	if (!notificationsEnabled) {
		console.log('Notifications disabled in settings');
		return;
	}

	// Check if permission is granted
	if (Notification.permission !== 'granted') {
		console.log('Notification permission not granted:', Notification.permission);
		return;
	}

	// Play sound regardless of visibility
	playNotificationSound();

	// Only show desktop notification if window is not focused (user is in another tab/app)
	if (!document.hidden) {
		console.log('Page is visible, skipping desktop notification');
		return;
	}

	let title = '';
	let body = '';
	let icon = '/icon-192.png';

	// Format title with channel name if provided
	const userPrefix = channelName ? `${message.user} in #${channelName}` : message.user;

	switch (message.type) {
		case 'text':
			title = userPrefix;
			body = message.text;
			break;
		case 'gif':
			title = userPrefix;
			body = '🎬 Sent a GIF';
			break;
		case 'file':
			title = userPrefix;
			body = `📎 Sent a file: ${message.fileName}`;
			break;
	}

	const notification = new Notification(title, {
		body,
		icon,
		badge: icon,
		tag: `message-${message.id}`, // Prevents duplicate notifications
		requireInteraction: false,
		silent: false
	});

	// Click notification to focus window
	notification.onclick = () => {
		window.focus();
		notification.close();
	};

	// Auto-close after 5 seconds
	setTimeout(() => {
		notification.close();
	}, 5000);
}

export function showCallNotification(
	callerName: string,
	isVideoCall: boolean,
	onAnswer?: () => void,
	onReject?: () => void
) {
	if (!browser) return null;

	// Check if notifications are enabled (defaults to true if not set)
	const notificationsEnabled = localStorage.getItem('notificationsEnabled') !== 'false';
	if (!notificationsEnabled) {
		console.log('Notifications disabled in settings');
		return null;
	}

	// Check if permission is granted
	if (Notification.permission !== 'granted') {
		console.log('Notification permission not granted');
		return null;
	}

	// Play ringtone
	playCallRingtone();

	const title = `Incoming ${isVideoCall ? 'Video' : 'Voice'} Call`;
	const body = `${callerName} is calling...`;
	const icon = '/icon-192.png';

	const notification = new Notification(title, {
		body,
		icon,
		badge: icon,
		tag: `call-${callerName}`,
		requireInteraction: true, // Keeps notification visible until user acts
		silent: false,
		actions: [
			{ action: 'answer', title: 'Answer' },
			{ action: 'reject', title: 'Decline' }
		]
	});

	// Handle notification clicks
	notification.onclick = () => {
		window.focus();
		if (onAnswer) onAnswer();
		notification.close();
	};

	return notification;
}

export function requestNotificationPermission(): Promise<NotificationPermission> {
	if (!browser || !('Notification' in window)) {
		return Promise.resolve('denied');
	}

	if (Notification.permission === 'granted') {
		return Promise.resolve('granted');
	}

	return Notification.requestPermission();
}
