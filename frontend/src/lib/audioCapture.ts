/**
 * audioCapture.ts
 * Audio capture, DSP pipeline setup, and camera stream management
 */

import { get } from 'svelte/store';
import { brandName } from './branding';
import { audioProcessingRuntimeStatus } from './callingStateStores';
import {
	CAMERA_CONSTRAINTS,
	type EffectiveAudioProcessingMode,
	type LocalAudioCaptureSession,
	type DspAudioPipeline
} from './callingTypes';
import { buildRTCConfig } from './turnConfig';
import {
	getAudioCaptureConstraints,
	getStoredAudioProcessingMode,
	getPreferredMicDeviceId,
	setPreferredMicDeviceId,
	getPreferredCameraDeviceId,
	setPreferredCameraDeviceId,
	type AudioProcessingMode
} from './mediaRuntime';

let activeAudioCaptureSession: LocalAudioCaptureSession | null = null;
let speakingAudioContext: AudioContext | null = null;

export function getRTCConfig(): RTCConfiguration {
	return buildRTCConfig();
}

export function supportsNoiseSuppressionConstraint(): boolean {
	if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getSupportedConstraints) return false;
	const supported = navigator.mediaDevices.getSupportedConstraints();
	return supported.noiseSuppression === true;
}

export function resolveEffectiveAudioProcessingMode(
	requested: AudioProcessingMode = getStoredAudioProcessingMode()
): EffectiveAudioProcessingMode {
	audioProcessingRuntimeStatus.update(state => ({
		...state,
		selected: requested
	}));

	if (typeof window === 'undefined') {
		return 'dsp';
	}

	const runtimeAudioModeOverride = (globalThis as any).__runtimeAudioModeOverride;
	if (runtimeAudioModeOverride) {
		audioProcessingRuntimeStatus.update(state => ({
			...state,
			effective: runtimeAudioModeOverride as EffectiveAudioProcessingMode,
			fallbackActive: true,
			reason: 'performance_guard'
		}));
		return runtimeAudioModeOverride;
	}

	if (requested === 'auto') {
		const effective = supportsNoiseSuppressionConstraint() ? 'rnn' : 'dsp';
		audioProcessingRuntimeStatus.update(state => ({
			...state,
			effective,
			fallbackActive: false,
			reason: effective === 'dsp' ? 'native_not_supported' : null
		}));
		return effective;
	}
	if (requested === 'rnn' && !supportsNoiseSuppressionConstraint()) {
		audioProcessingRuntimeStatus.update(state => ({
			...state,
			effective: 'dsp',
			fallbackActive: true,
			reason: 'native_not_supported'
		}));
		return 'dsp';
	}
	audioProcessingRuntimeStatus.update(state => ({
		...state,
		effective: requested,
		fallbackActive: false,
		reason: null
	}));
	return requested;
}

function createDspAudioPipeline(sourceStream: MediaStream): DspAudioPipeline {
	const context = new AudioContext({ sampleRate: 48000 });
	const sourceNode = context.createMediaStreamSource(sourceStream);
	const highPass = context.createBiquadFilter();
	highPass.type = 'highpass';
	highPass.frequency.value = 90;
	highPass.Q.value = 0.8;

	const notch = context.createBiquadFilter();
	notch.type = 'notch';
	notch.frequency.value = 60;
	notch.Q.value = 10;

	const lowPass = context.createBiquadFilter();
	lowPass.type = 'lowpass';
	lowPass.frequency.value = 11000;
	lowPass.Q.value = 0.7;

	const compressor = context.createDynamicsCompressor();
	compressor.threshold.value = -24;
	compressor.knee.value = 20;
	compressor.ratio.value = 3;
	compressor.attack.value = 0.003;
	compressor.release.value = 0.18;

	const destination = context.createMediaStreamDestination();
	sourceNode.connect(highPass);
	highPass.connect(notch);
	notch.connect(lowPass);
	lowPass.connect(compressor);
	compressor.connect(destination);

	const outputTrack = destination.stream.getAudioTracks()[0];
	if (!outputTrack) {
		throw new Error('DSP pipeline did not produce an audio track');
	}

	return {
		context,
		sourceNode,
		highPass,
		lowPass,
		notch,
		compressor,
		destination,
		outputTrack
	};
}

function disposeDspAudioPipeline(pipeline: DspAudioPipeline): void {
	try {
		pipeline.sourceNode.disconnect();
		pipeline.highPass.disconnect();
		pipeline.notch.disconnect();
		pipeline.lowPass.disconnect();
		pipeline.compressor.disconnect();
	} catch {
		// no-op
	}
	try {
		pipeline.outputTrack.stop();
	} catch {
		// no-op
	}
	void pipeline.context.close().catch(() => undefined);
}

export function disposeAudioCaptureSession(session: LocalAudioCaptureSession): void {
	if (session.pipeline) {
		disposeDspAudioPipeline(session.pipeline);
	} else {
		try {
			session.outputTrack.stop();
		} catch {
			// no-op
		}
	}
	try {
		session.sourceStream.getTracks().forEach(track => track.stop());
	} catch {
		// no-op
	}
}

export function clearActiveAudioCaptureSession(): void {
	if (!activeAudioCaptureSession) return;
	disposeAudioCaptureSession(activeAudioCaptureSession);
	activeAudioCaptureSession = null;
}

export async function createAudioCaptureSession(): Promise<LocalAudioCaptureSession> {
	const mode = resolveEffectiveAudioProcessingMode();
	const sourceStream = await requestAudioSourceStream(mode);

	if (mode === 'dsp') {
		const pipeline = createDspAudioPipeline(sourceStream);
		return {
			sourceStream,
			outputTrack: pipeline.outputTrack,
			mode,
			pipeline
		};
	}

	const outputTrack = sourceStream.getAudioTracks()[0];
	if (!outputTrack) {
		sourceStream.getTracks().forEach(track => track.stop());
		throw new Error('Microphone stream has no audio track');
	}

	return {
		sourceStream,
		outputTrack,
		mode
	};
}

function isRecoverableMediaDeviceError(error: unknown): error is DOMException {
	return (
		error instanceof DOMException &&
		(error.name === 'NotFoundError' ||
			error.name === 'OverconstrainedError' ||
			error.name === 'NotReadableError' ||
			error.name === 'AbortError')
	);
}

/**
 * Browsers only expose navigator.mediaDevices in a secure context
 * (https://, http://localhost, http://127.0.0.1). Plain LAN HTTP like
 * http://192.168.x.x:5173 leaves mediaDevices undefined and crashes getUserMedia.
 */
export function assertMediaDevicesAvailable(kind: 'microphone' | 'camera' | 'media' = 'media'): void {
	if (typeof navigator === 'undefined') {
		throw new Error('Media capture is only available in a browser.');
	}
	const host =
		typeof window !== 'undefined' && window.location
			? `${window.location.protocol}//${window.location.host}`
			: 'this page';
	const isLocalhost =
		typeof window !== 'undefined' &&
		(window.location.hostname === 'localhost' ||
			window.location.hostname === '127.0.0.1' ||
			window.location.hostname === '[::1]');
	const secure =
		typeof window !== 'undefined' &&
		(window.isSecureContext === true || isLocalhost || window.location.protocol === 'https:');

	if (!navigator.mediaDevices?.getUserMedia) {
		const reason = !secure
			? `This page is not a secure context (${host}). Browsers hide the microphone/camera API on plain HTTP LAN URLs.`
			: 'navigator.mediaDevices is unavailable in this browser.';
		throw new Error(
			`${reason} Open ${brandName} via http://127.0.0.1:5173 or https://… to use ${kind}/calls. ` +
				`Do not use http://192.168.x.x or http://100.x.x.x without HTTPS.`
		);
	}
}

async function requestAudioSourceStream(mode: EffectiveAudioProcessingMode): Promise<MediaStream> {
	assertMediaDevicesAvailable('microphone');
	const baseAudioConstraints: MediaTrackConstraints = getAudioCaptureConstraints(mode as AudioProcessingMode);
	const preferredMicId = getPreferredMicDeviceId();
	const attempts: Array<{
		label: string;
		audio: MediaTrackConstraints | true;
		clearPreferredDevice?: boolean;
	}> = [];

	if (preferredMicId) {
		attempts.push({
			label: 'preferred microphone',
			audio: {
				...baseAudioConstraints,
				deviceId: preferredMicId
			},
			clearPreferredDevice: true
		});
	}

	attempts.push(
		{
			label: 'default microphone',
			audio: { ...baseAudioConstraints }
		},
		{
			label: 'basic microphone',
			audio: true
		}
	);

	let lastError: unknown = null;
	for (const attempt of attempts) {
		try {
			return await navigator.mediaDevices.getUserMedia({
				audio: attempt.audio,
				video: false
			});
		} catch (error) {
			lastError = error;
			if (!isRecoverableMediaDeviceError(error)) {
				throw error;
			}
			if (attempt.clearPreferredDevice) {
				console.warn('[WebRTC] Preferred microphone failed, clearing saved mic device preference:', error);
				setPreferredMicDeviceId(null);
			} else {
				console.warn(`[WebRTC] Audio capture attempt failed (${attempt.label}), retrying with fallback.`, error);
			}
		}
	}

	throw lastError instanceof Error ? lastError : new Error('Unable to capture microphone audio');
}

export async function requestCameraStream(): Promise<MediaStream> {
	assertMediaDevicesAvailable('camera');
	const preferredCameraId = getPreferredCameraDeviceId();
	const attempts: Array<{
		label: string;
		video: MediaTrackConstraints | true;
		clearPreferredDevice?: boolean;
	}> = [];

	if (preferredCameraId) {
		attempts.push({
			label: 'preferred camera',
			video: {
				...CAMERA_CONSTRAINTS,
				deviceId: preferredCameraId
			},
			clearPreferredDevice: true
		});
	}

	attempts.push(
		{
			label: 'default camera',
			video: { ...CAMERA_CONSTRAINTS }
		},
		{
			label: 'basic camera',
			video: true
		}
	);

	let lastError: unknown = null;
	for (const attempt of attempts) {
		try {
			return await navigator.mediaDevices.getUserMedia({
				video: attempt.video,
				audio: false
			});
		} catch (error) {
			lastError = error;
			if (!isRecoverableMediaDeviceError(error)) {
				throw error;
			}
			if (attempt.clearPreferredDevice) {
				console.warn('[WebRTC] Preferred camera failed, clearing saved camera preference:', error);
				setPreferredCameraDeviceId(null);
			} else {
				console.warn(`[WebRTC] Camera capture attempt failed (${attempt.label}), retrying with fallback.`, error);
			}
		}
	}

	throw lastError instanceof Error ? lastError : new Error('Unable to capture camera video');
}

export function ensureSpeakingAudioContext(): AudioContext | null {
	if (typeof window === 'undefined') return null;
	if (speakingAudioContext) return speakingAudioContext;
	try {
		speakingAudioContext = new (window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)();
		return speakingAudioContext;
	} catch (error) {
		console.warn('[WebRTC] Speaking detection unavailable:', error);
		return null;
	}
}

export function getActiveAudioCaptureSession(): LocalAudioCaptureSession | null {
	return activeAudioCaptureSession;
}

export function setActiveAudioCaptureSession(session: LocalAudioCaptureSession | null): void {
	activeAudioCaptureSession = session;
}
