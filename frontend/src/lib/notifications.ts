import { browser } from '$app/environment';
import type { Message } from '$lib/socket';

// Simple notification sound using Web Audio API
let audioContext: AudioContext | null = null;

function initAudio() {
	if (!browser) return;
	if (!audioContext) {
		audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
	}
}

export function playNotificationSound() {
	if (!browser) return;

	initAudio();
	if (!audioContext) return;

	// Create a simple pleasant notification sound
	const oscillator = audioContext.createOscillator();
	const gainNode = audioContext.createGain();

	oscillator.connect(gainNode);
	gainNode.connect(audioContext.destination);

	// Set frequency (higher pitch for notification)
	oscillator.frequency.value = 800;
	oscillator.type = 'sine';

	// Set volume (0.1 = 10% volume)
	gainNode.gain.setValueAtTime(0.1, audioContext.currentTime);
	gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.1);

	// Play for 100ms
	oscillator.start(audioContext.currentTime);
	oscillator.stop(audioContext.currentTime + 0.1);
}

export function showNotification(message: Message, isCurrentUser: boolean) {
	if (!browser) return;

	// Don't notify for own messages
	if (isCurrentUser) return;

	// Check if notifications are enabled
	const notificationsEnabled = localStorage.getItem('notificationsEnabled') === 'true';
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

	switch (message.type) {
		case 'text':
			title = message.user;
			body = message.text;
			break;
		case 'gif':
			title = message.user;
			body = '🎬 Sent a GIF';
			break;
		case 'file':
			title = message.user;
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

export function requestNotificationPermission(): Promise<NotificationPermission> {
	if (!browser || !('Notification' in window)) {
		return Promise.resolve('denied');
	}

	if (Notification.permission === 'granted') {
		return Promise.resolve('granted');
	}

	return Notification.requestPermission();
}
