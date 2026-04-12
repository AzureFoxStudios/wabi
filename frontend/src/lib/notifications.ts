import { browser } from '$app/environment';
import type { Message } from '$lib/socket-types';

interface SimpleNotification {
	title: string;
	body: string;
}

let notificationAudio: HTMLAudioElement | null = null;
let callRingtoneAudio: HTMLAudioElement | null = null;
let audioContext: AudioContext | null = null;
let ringtoneTimeout: NodeJS.Timeout | null = null;
let ringtoneLoopTimeout: NodeJS.Timeout | null = null;

export type CallRingtoneMode = 'classic-bell' | 'soft-chime' | 'pulse' | 'custom-synth' | 'custom-audio';
export type CustomSynthWaveform = 'sine' | 'square' | 'sawtooth' | 'triangle';
export interface CustomSynthRingtonePreset {
	name: string;
	waveform: CustomSynthWaveform;
	primaryToneHz: number;
	secondaryToneHz: number;
	harmonicMultiplier: number;
	harmonicGain: number;
	burstDurationMs: number;
	burstCount: number;
	burstSpacingMs: number;
	cycleMs: number;
	level: number;
	fadeOutMs: number;
	tremoloHz: number;
	tremoloDepth: number;
}

const DEFAULT_NOTIFICATION_SOUND = '/sounds/ProjectSound.ogg';
const DEFAULT_NOTIFICATION_VOLUME = 0.5;
const DEFAULT_CALL_RINGTONE_MODE: CallRingtoneMode = 'classic-bell';
const DEFAULT_CALL_RINGTONE_VOLUME = 0.65;
const DEFAULT_CUSTOM_SYNTH_RINGTONE_PRESET: CustomSynthRingtonePreset = {
	name: 'Custom Synth',
	waveform: 'triangle',
	primaryToneHz: 480,
	secondaryToneHz: 720,
	harmonicMultiplier: 2,
	harmonicGain: 0.12,
	burstDurationMs: 260,
	burstCount: 2,
	burstSpacingMs: 420,
	cycleMs: 2800,
	level: 0.09,
	fadeOutMs: 55,
	tremoloHz: 8,
	tremoloDepth: 0.22
};
const CALL_RINGTONE_MODES: CallRingtoneMode[] = [
	'classic-bell',
	'soft-chime',
	'pulse',
	'custom-synth',
	'custom-audio'
];

interface SynthBurstConfig {
	delayMs: number;
	duration: number;
	tones: number[];
	harmonics?: Array<{ frequency: number; gain: number }>;
	waveform?: OscillatorType;
	volume: number;
	fadeOut?: number;
	tremoloHz?: number;
	tremoloDepth?: number;
}

interface SynthPatternConfig {
	cycleMs: number;
	bursts: SynthBurstConfig[];
}

type BuiltInSynthRingtoneMode = Exclude<CallRingtoneMode, 'custom-audio' | 'custom-synth'>;

const SYNTH_RINGTONE_PRESETS: Record<BuiltInSynthRingtoneMode, SynthPatternConfig> = {
	'classic-bell': {
		cycleMs: 4200,
		bursts: [
			{
				delayMs: 0,
				duration: 0.8,
				tones: [425, 575],
				harmonics: [
					{ frequency: 850, gain: 0.25 },
					{ frequency: 1150, gain: 0.12 }
				],
				volume: 0.15,
				fadeOut: 0.03,
				tremoloHz: 20,
				tremoloDepth: 0.5
			},
			{
				delayMs: 1200,
				duration: 0.8,
				tones: [425, 575],
				harmonics: [
					{ frequency: 850, gain: 0.25 },
					{ frequency: 1150, gain: 0.12 }
				],
				volume: 0.15,
				fadeOut: 0.03,
				tremoloHz: 20,
				tremoloDepth: 0.5
			}
		]
	},
	'soft-chime': {
		cycleMs: 3600,
		bursts: [
			{
				delayMs: 0,
				duration: 1.4,
				tones: [660, 880],
				harmonics: [{ frequency: 1320, gain: 0.18 }],
				waveform: 'triangle',
				volume: 0.1,
				fadeOut: 0.18
			},
			{
				delayMs: 1500,
				duration: 1.2,
				tones: [740, 988],
				harmonics: [{ frequency: 1480, gain: 0.14 }],
				waveform: 'triangle',
				volume: 0.085,
				fadeOut: 0.16
			}
		]
	},
	pulse: {
		cycleMs: 2600,
		bursts: [
			{
				delayMs: 0,
				duration: 0.18,
				tones: [520, 780],
				harmonics: [{ frequency: 1040, gain: 0.1 }],
				waveform: 'square',
				volume: 0.08,
				fadeOut: 0.04,
				tremoloHz: 12,
				tremoloDepth: 0.3
			},
			{
				delayMs: 360,
				duration: 0.18,
				tones: [520, 780],
				harmonics: [{ frequency: 1040, gain: 0.1 }],
				waveform: 'square',
				volume: 0.08,
				fadeOut: 0.04,
				tremoloHz: 12,
				tremoloDepth: 0.3
			},
			{
				delayMs: 720,
				duration: 0.24,
				tones: [480, 720],
				harmonics: [{ frequency: 960, gain: 0.08 }],
				waveform: 'triangle',
				volume: 0.075,
				fadeOut: 0.05
			}
		]
	}
};

function clampNumber(value: number, min: number, max: number, fallback: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}

export function getDefaultCustomSynthRingtonePreset(): CustomSynthRingtonePreset {
	return { ...DEFAULT_CUSTOM_SYNTH_RINGTONE_PRESET };
}

export function sanitizeCustomSynthRingtonePreset(value: unknown): CustomSynthRingtonePreset {
	if (!value || typeof value !== 'object') {
		return getDefaultCustomSynthRingtonePreset();
	}

	const candidate = value as Record<string, unknown>;
	const waveform = typeof candidate.waveform === 'string'
		&& ['sine', 'square', 'sawtooth', 'triangle'].includes(candidate.waveform)
		? candidate.waveform as CustomSynthWaveform
		: DEFAULT_CUSTOM_SYNTH_RINGTONE_PRESET.waveform;
	const primaryToneHz = clampNumber(Number(candidate.primaryToneHz), 120, 2200, DEFAULT_CUSTOM_SYNTH_RINGTONE_PRESET.primaryToneHz);
	const secondaryToneHz = clampNumber(Number(candidate.secondaryToneHz), 0, 2600, DEFAULT_CUSTOM_SYNTH_RINGTONE_PRESET.secondaryToneHz);
	const burstDurationMs = clampNumber(Number(candidate.burstDurationMs), 60, 2500, DEFAULT_CUSTOM_SYNTH_RINGTONE_PRESET.burstDurationMs);
	const burstCount = Math.round(clampNumber(Number(candidate.burstCount), 1, 6, DEFAULT_CUSTOM_SYNTH_RINGTONE_PRESET.burstCount));
	const burstSpacingMs = clampNumber(Number(candidate.burstSpacingMs), 80, 4000, DEFAULT_CUSTOM_SYNTH_RINGTONE_PRESET.burstSpacingMs);
	const minimumCycle = (burstCount - 1) * burstSpacingMs + burstDurationMs + 180;

	return {
		name: typeof candidate.name === 'string' && candidate.name.trim()
			? candidate.name.trim().slice(0, 48)
			: DEFAULT_CUSTOM_SYNTH_RINGTONE_PRESET.name,
		waveform,
		primaryToneHz,
		secondaryToneHz,
		harmonicMultiplier: clampNumber(Number(candidate.harmonicMultiplier), 1, 8, DEFAULT_CUSTOM_SYNTH_RINGTONE_PRESET.harmonicMultiplier),
		harmonicGain: clampNumber(Number(candidate.harmonicGain), 0, 0.4, DEFAULT_CUSTOM_SYNTH_RINGTONE_PRESET.harmonicGain),
		burstDurationMs,
		burstCount,
		burstSpacingMs,
		cycleMs: clampNumber(Number(candidate.cycleMs), minimumCycle, 8000, Math.max(DEFAULT_CUSTOM_SYNTH_RINGTONE_PRESET.cycleMs, minimumCycle)),
		level: clampNumber(Number(candidate.level), 0.02, 0.25, DEFAULT_CUSTOM_SYNTH_RINGTONE_PRESET.level),
		fadeOutMs: clampNumber(Number(candidate.fadeOutMs), 10, burstDurationMs - 10, Math.min(DEFAULT_CUSTOM_SYNTH_RINGTONE_PRESET.fadeOutMs, burstDurationMs - 10)),
		tremoloHz: clampNumber(Number(candidate.tremoloHz), 0, 30, DEFAULT_CUSTOM_SYNTH_RINGTONE_PRESET.tremoloHz),
		tremoloDepth: clampNumber(Number(candidate.tremoloDepth), 0, 0.95, DEFAULT_CUSTOM_SYNTH_RINGTONE_PRESET.tremoloDepth)
	};
}

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

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function messageMentionsUser(message: Message, username?: string | null): boolean {
	const text = String(message?.text || '');
	if (!text) return false;

	// Broad mentions count as mention pings for everyone.
	if (/\B@(everyone|here|all)\b/i.test(text)) {
		return true;
	}

	if (!username) return false;
	const userPattern = new RegExp(`(^|[\\s(])@${escapeRegExp(username)}\\b`, 'i');
	return userPattern.test(text);
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
	if (!browser) return DEFAULT_NOTIFICATION_SOUND;
	return localStorage.getItem('notificationSound') || DEFAULT_NOTIFICATION_SOUND;
}

// Get notification volume from settings (default to 50%)
function getNotificationVolume(): number {
	if (!browser) return DEFAULT_NOTIFICATION_VOLUME;
	const volume = localStorage.getItem('notificationVolume');
	return volume ? parseFloat(volume) : DEFAULT_NOTIFICATION_VOLUME;
}

function getCallRingtoneMode(): CallRingtoneMode {
	if (!browser) return DEFAULT_CALL_RINGTONE_MODE;
	const storedMode = localStorage.getItem('callRingtoneMode');
	if (storedMode && CALL_RINGTONE_MODES.includes(storedMode as CallRingtoneMode)) {
		return storedMode as CallRingtoneMode;
	}
	return DEFAULT_CALL_RINGTONE_MODE;
}

function getCallRingtoneCustomAudio(): string | null {
	if (!browser) return null;
	const value = localStorage.getItem('callRingtoneCustomAudio');
	return value && value.startsWith('data:audio') ? value : null;
}

function getStoredCustomSynthRingtonePreset(): CustomSynthRingtonePreset {
	if (!browser) return getDefaultCustomSynthRingtonePreset();
	const raw = localStorage.getItem('callRingtoneCustomSynth');
	if (!raw) return getDefaultCustomSynthRingtonePreset();
	try {
		return sanitizeCustomSynthRingtonePreset(JSON.parse(raw));
	} catch (error) {
		console.warn('Failed to parse custom synth ringtone preset:', error);
		return getDefaultCustomSynthRingtonePreset();
	}
}

function getCallRingtoneVolume(): number {
	if (!browser) return DEFAULT_CALL_RINGTONE_VOLUME;
	const stored = localStorage.getItem('callRingtoneVolume');
	const parsed = stored ? parseFloat(stored) : DEFAULT_CALL_RINGTONE_VOLUME;
	if (!Number.isFinite(parsed)) {
		return DEFAULT_CALL_RINGTONE_VOLUME;
	}
	return Math.min(1, Math.max(0, parsed));
}

function playSynthBurst(
	ctx: AudioContext,
	startTime: number,
	config: SynthBurstConfig,
	volumeMultiplier: number
) {
	const endTime = startTime + config.duration;
	const fadeOut = config.fadeOut ?? 0.05;
	const envelope = ctx.createGain();
	envelope.connect(ctx.destination);
	envelope.gain.setValueAtTime(config.volume * volumeMultiplier, startTime);
	envelope.gain.setValueAtTime(config.volume * volumeMultiplier, Math.max(startTime, endTime - fadeOut));
	envelope.gain.exponentialRampToValueAtTime(0.001, endTime);

	let destination: AudioNode = envelope;
	const oscillators: OscillatorNode[] = [];

	if (config.tremoloHz && config.tremoloDepth) {
		const tremolo = ctx.createGain();
		tremolo.connect(envelope);
		tremolo.gain.setValueAtTime(1 - config.tremoloDepth, startTime);
		const lfo = ctx.createOscillator();
		const lfoDepth = ctx.createGain();
		lfo.type = 'sine';
		lfo.frequency.value = config.tremoloHz;
		lfoDepth.gain.value = config.tremoloDepth;
		lfo.connect(lfoDepth);
		lfoDepth.connect(tremolo.gain);
		lfo.start(startTime);
		lfo.stop(endTime);
		oscillators.push(lfo);
		destination = tremolo;
	}

	for (const frequency of config.tones) {
		const osc = ctx.createOscillator();
		osc.type = config.waveform || 'sine';
		osc.frequency.value = frequency;
		osc.connect(destination);
		osc.start(startTime);
		osc.stop(endTime);
		oscillators.push(osc);
	}

	for (const harmonic of config.harmonics || []) {
		const osc = ctx.createOscillator();
		const mix = ctx.createGain();
		mix.gain.value = harmonic.gain;
		osc.type = config.waveform || 'sine';
		osc.frequency.value = harmonic.frequency;
		osc.connect(mix);
		mix.connect(destination);
		osc.start(startTime);
		osc.stop(endTime);
		oscillators.push(osc);
	}
}

function buildCustomSynthPattern(preset: CustomSynthRingtonePreset): SynthPatternConfig {
	const safePreset = sanitizeCustomSynthRingtonePreset(preset);
	const harmonics = safePreset.harmonicGain > 0
		? [
			{
				frequency: safePreset.primaryToneHz * safePreset.harmonicMultiplier,
				gain: safePreset.harmonicGain
			},
			...(safePreset.secondaryToneHz > 0
				? [{
					frequency: safePreset.secondaryToneHz * safePreset.harmonicMultiplier,
					gain: Math.max(0.01, Math.min(0.4, safePreset.harmonicGain * 0.72))
				}]
				: [])
		]
		: undefined;
	const bursts: SynthBurstConfig[] = [];
	for (let index = 0; index < safePreset.burstCount; index += 1) {
		bursts.push({
			delayMs: index * safePreset.burstSpacingMs,
			duration: safePreset.burstDurationMs / 1000,
			tones: [
				safePreset.primaryToneHz,
				...(safePreset.secondaryToneHz > 0 ? [safePreset.secondaryToneHz] : [])
			],
			harmonics,
			waveform: safePreset.waveform,
			volume: safePreset.level,
			fadeOut: safePreset.fadeOutMs / 1000,
			tremoloHz: safePreset.tremoloHz > 0 ? safePreset.tremoloHz : undefined,
			tremoloDepth: safePreset.tremoloDepth > 0 ? safePreset.tremoloDepth : undefined
		});
	}
	return {
		cycleMs: safePreset.cycleMs,
		bursts
	};
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

	if ((callRingtoneAudio && !callRingtoneAudio.paused) || ringtoneTimeout || ringtoneLoopTimeout) {
		return;
	}

	const ringtoneMode = getCallRingtoneMode();
	const volume = getCallRingtoneVolume();

	if (ringtoneMode === 'custom-audio') {
		const customAudio = getCallRingtoneCustomAudio();
		if (!customAudio) {
			localStorage.removeItem('callRingtoneMode');
			playCallRingtone();
			return;
		}
		try {
			if (!callRingtoneAudio) {
				callRingtoneAudio = new Audio();
				callRingtoneAudio.loop = true;
			}
			callRingtoneAudio.src = customAudio;
			callRingtoneAudio.volume = volume;
			callRingtoneAudio.currentTime = 0;
			callRingtoneAudio.play().catch(err => {
				console.error('Failed to play custom call ringtone:', err);
			});
		} catch (err) {
			console.error('Error setting up custom call ringtone:', err);
		}
		return;
	}

	initAudio();
	if (!audioContext) return;

	if (audioContext.state === 'suspended') {
		audioContext.resume().catch(err => {
			console.error('Failed to resume audio context for call ringtone:', err);
		});
	}

	const preset = ringtoneMode === 'custom-synth'
		? buildCustomSynthPattern(getStoredCustomSynthRingtonePreset())
		: SYNTH_RINGTONE_PRESETS[ringtoneMode as BuiltInSynthRingtoneMode];
	const scheduleRingPattern = () => {
		const ctx = audioContext!;
		const now = ctx.currentTime;
		for (const burst of preset.bursts) {
			playSynthBurst(ctx, now + burst.delayMs / 1000, burst, volume);
		}
		ringtoneLoopTimeout = setTimeout(() => {
			ringtoneLoopTimeout = null;
			scheduleRingPattern();
		}, preset.cycleMs);
	};

	scheduleRingPattern();
}

export function stopCallRingtone() {
	if (ringtoneTimeout) {
		clearTimeout(ringtoneTimeout);
		ringtoneTimeout = null;
	}
	if (ringtoneLoopTimeout) {
		clearTimeout(ringtoneLoopTimeout);
		ringtoneLoopTimeout = null;
	}
	if (callRingtoneAudio) {
		callRingtoneAudio.pause();
		callRingtoneAudio.currentTime = 0;
	}
	// Also stop any currently playing audio context sounds
	if (audioContext) {
		audioContext
			.close()
			.then(() => {
				audioContext = null;
			})
			.catch(err => console.error('Error closing audio context:', err));
	}
}

export function showNotification(
	message: Message | SimpleNotification,
	isCurrentUser: boolean,
	channelName?: string,
	options?: {
		isMention?: boolean;
		isCurrentChannelActive?: boolean;
		onClick?: () => void;
		serverName?: string | null;
		iconUrl?: string | null;
		forceDesktop?: boolean;
		tagPrefix?: string;
	}
) {
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

	const isMention = options?.isMention ?? false;
	const isCurrentChannelActive = options?.isCurrentChannelActive ?? false;
	const forceDesktop = options?.forceDesktop === true;
	const shouldPlaySound = forceDesktop || document.hidden || !isCurrentChannelActive || isMention;

	// Check if permission is granted
	if (Notification.permission !== 'granted') {
		console.log('Notification permission not granted:', Notification.permission);
		return;
	}

	if (shouldPlaySound) {
		playNotificationSound();
	}

	// Only show desktop notification if window is not focused (user is in another tab/app)
	if (!document.hidden && !forceDesktop) {
		console.log('Page is visible, skipping desktop notification');
		return;
	}

	let title = '';
	let body = '';
	let icon = options?.iconUrl?.trim() || '/icon-192.png';

	// Handle simple { title, body } notifications
	if ('title' in message && 'body' in message && !('user' in message)) {
		title = message.title;
		body = message.body;

		if (Notification.permission !== 'granted') {
			console.log('Notification permission not granted:', Notification.permission);
			return;
		}

		if (!document.hidden && !forceDesktop) {
			console.log('Page is visible, skipping desktop notification');
			return;
		}

		const notification = new Notification(title, { body, icon });
		if (options?.onClick) {
			notification.addEventListener('click', options.onClick);
		}
		setTimeout(() => {
			notification.close();
		}, 5000);
		return;
	}

	const msg = message as Message;
	const showMessagePreview = localStorage.getItem('notificationPreviewEnabled') === 'true';
	const rawText = typeof msg.text === 'string' ? msg.text.trim() : '';
	const looksLikeCiphertext =
		rawText.length >= 48 &&
		!/[\s]/.test(rawText) &&
		/^[A-Za-z0-9+/=_-]+$/.test(rawText);
	const shouldHidePreview = Boolean(msg.encrypted || msg.iv || looksLikeCiphertext);
	const fallbackTitle = typeof (msg as unknown as { title?: string }).title === 'string'
		? String((msg as unknown as { title?: string }).title).trim()
		: '';
	const fallbackBody = typeof (msg as unknown as { body?: string }).body === 'string'
		? String((msg as unknown as { body?: string }).body).trim()
		: '';

	// Format title with channel name if provided
	const locationParts: string[] = [];
	if (channelName) locationParts.push(`#${channelName}`);
	if (options?.serverName) locationParts.push(options.serverName);
	const locationSuffix =
		locationParts.length > 0
			? ` in ${locationParts[0]}${locationParts.length > 1 ? ` · ${locationParts.slice(1).join(' · ')}` : ''}`
			: options?.serverName
				? ` · ${options.serverName}`
				: '';
	const userPrefix = `${msg.user || 'Someone'}${locationSuffix}`;

	switch (msg.type) {
		case 'text':
			title = isMention ? `Mention from ${userPrefix}` : userPrefix;
			body = showMessagePreview && !shouldHidePreview ? msg.text : 'New message';
			break;
		case 'gif':
			title = userPrefix;
			body = showMessagePreview && !shouldHidePreview ? 'Sent a GIF' : 'New message';
			break;
		case 'file':
			title = userPrefix;
			body = showMessagePreview && !shouldHidePreview ? `Sent a file: ${msg.fileName}` : 'New message';
			break;
	}

	if (!title) {
		title = fallbackTitle || userPrefix || 'Wabi';
	}
	if (!body) {
		body = fallbackBody || 'New activity';
	}

	const notification = new Notification(title, {
		body,
		icon,
		badge: icon,
		tag: `${options?.tagPrefix || 'message'}-${msg.id || fallbackTitle || 'activity'}`,
		requireInteraction: false,
		silent: false
	});

	// Click notification to focus window
	notification.onclick = () => {
		window.focus();
		options?.onClick?.();
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

