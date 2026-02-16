import { browser } from '$app/environment';
import type { Message } from '$lib/socket-types';

let notificationAudio: HTMLAudioElement | null = null;
let audioContext: AudioContext | null = null;
let ringtoneTimeout: NodeJS.Timeout | null = null;

function getNotificationSquelchSettings() {
	if (!browser) {
		return {
			suppressEveryoneHere: false,
			suppressRoleMentions: false
		};
	}

	return {
		suppressEveryoneHere: localStorage.getItem('suppressEveryoneHereMentions') === 'true',
		suppressRoleMentions: localStorage.getItem('suppressRoleMentions') === 'true'
	};
}

function shouldSquelchNotification(message: Message): boolean {
	const text = String(message?.text || '');
	if (!text) return false;

	const { suppressEveryoneHere, suppressRoleMentions } = getNotificationSquelchSettings();

	if (suppressEveryoneHere && /\B@(everyone|here|all)\b/i.test(text)) {
		return true;
	}

	// Support common role-mention syntaxes.
	if (suppressRoleMentions && (/<@&\d+>/.test(text) || /\B@&[\w-]+\b/.test(text))) {
		return true;
	}

	return false;
}

function initAudio() {
	if (audioContext) return;
	try {
		audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
	} catch (e) {
		console.error('Web Audio API is not supported in this browser');
	}
}

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

	// Clear any existing ringtone timeouts
	if (ringtoneTimeout) {
		clearTimeout(ringtoneTimeout);
		ringtoneTimeout = null;
	}

	// 1950s rotary phone bell ring
	const playRingBurst = () => {
		const ctx = audioContext!;
		const now = ctx.currentTime;
		const duration = 0.8;

		// Envelope: overall volume with fade-out
		const envelope = ctx.createGain();
		envelope.connect(ctx.destination);
		envelope.gain.setValueAtTime(0.15, now);
		envelope.gain.setValueAtTime(0.15, now + duration - 0.03);
		envelope.gain.exponentialRampToValueAtTime(0.001, now + duration);

		// 20 Hz tremolo simulating the mechanical bell striker
		const tremolo = ctx.createGain();
		tremolo.connect(envelope);
		tremolo.gain.setValueAtTime(0.5, now);

		const lfo = ctx.createOscillator();
		const lfoDepth = ctx.createGain();
		lfo.type = 'sine';
		lfo.frequency.value = 20;
		lfoDepth.gain.value = 0.5;
		lfo.connect(lfoDepth);
		lfoDepth.connect(tremolo.gain);

		// Dual bell tones (characteristic 1950s dual-gong ring)
		const bell1 = ctx.createOscillator();
		bell1.type = 'sine';
		bell1.frequency.value = 425;
		bell1.connect(tremolo);

		const bell2 = ctx.createOscillator();
		bell2.type = 'sine';
		bell2.frequency.value = 575;
		bell2.connect(tremolo);

		// Upper harmonics for metallic bell timbre
		const harm1 = ctx.createOscillator();
		harm1.type = 'sine';
		harm1.frequency.value = 850;
		const mix1 = ctx.createGain();
		mix1.gain.value = 0.25;
		harm1.connect(mix1);
		mix1.connect(tremolo);

		const harm2 = ctx.createOscillator();
		harm2.type = 'sine';
		harm2.frequency.value = 1150;
		const mix2 = ctx.createGain();
		mix2.gain.value = 0.12;
		harm2.connect(mix2);
		mix2.connect(tremolo);

		// Start and stop all oscillators
		const oscs = [lfo, bell1, bell2, harm1, harm2];
		oscs.forEach(o => o.start(now));
		oscs.forEach(o => o.stop(now + duration));
	};

	// Ring pattern: two bursts with a pause (like a real rotary phone)
	playRingBurst();
	ringtoneTimeout = setTimeout(() => {
		playRingBurst();
		ringtoneTimeout = null;
	}, 1200);
}

export function stopCallRingtone() {
    if (ringtoneTimeout) {
        clearTimeout(ringtoneTimeout);
        ringtoneTimeout = null;
    }
    // Also stop any currently playing audio context sounds
    if (audioContext) {
        audioContext.close().then(() => {
            audioContext = null;
        }).catch(err => console.error('Error closing audio context:', err));
    }
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

	if (shouldSquelchNotification(message)) {
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
		requireInteraction: false, // No interactive buttons, so no need to require interaction
		silent: false
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
