/**
 * callRecordingSession.ts
 * Call recording session management and state lifecycle
 */

import { get } from 'svelte/store';
import {
	activeCalls,
	activeGroupCall,
	activeVoiceChannel,
	callMode,
	connectionState,
	isInCall,
	isLocalSpeaking,
	isMuted,
	isSharing,
	isVideoOff,
	listeningVoiceChannels,
	localScreenStream,
	localStream,
	screenShares,
	type Call,
	type ScreenShare
} from './calling';
import type {
	CallRecordingMode,
	CallRecordingPreset,
	CallRecordingSnapshot,
	CallRecordingStartOptions,
	RecordingArtifactHandle,
	RecordingExportResult,
	StemArtifactSpec
} from './callRecordingTypes';
import {
	buildMixedAudioInputs,
	buildMicStemInputs,
	buildParticipantStemInputs,
	buildShareStemInputs,
	buildStemFileName,
	buildSuggestedFileName,
	ensureMediaRecorderSupport,
	getDefaultMode,
	getDefaultPreset,
	getDefaultStemMode,
	pickAudioMimeType,
	pickMimeType,
	buildStemLabel
} from './callRecordingUtils';
import {
	createRecordingArtifact,
	disposeRecordingArtifact,
	type RecordingAudioInputResolver
} from './callRecordingArtifact';

export function getCurrentSnapshot(): CallRecordingSnapshot {
	return {
		activeCalls: get(activeCalls),
		screenShares: get(screenShares),
		isInCall: get(isInCall),
		isSharing: get(isSharing),
		isMuted: get(isMuted),
		isVideoOff: get(isVideoOff),
		isLocalSpeaking: get(isLocalSpeaking),
		localStream: get(localStream),
		localScreenStream: get(localScreenStream),
		callMode: get(callMode),
		activeVoiceChannelId: get(activeVoiceChannel)?.id || null,
		activeGroupCallId: get(activeGroupCall)?.id || null,
		listeningVoiceChannelIds: get(listeningVoiceChannels),
		connectionState: get(connectionState)
	};
}

function buildStemArtifactSpecs(snapshot: CallRecordingSnapshot, stemMode: any): StemArtifactSpec[] {
	if (stemMode === 'mixed-only') {
		return [];
	}

	const specs: StemArtifactSpec[] = [];

	if (snapshot.localStream?.getAudioTracks().length) {
		specs.push({
			id: 'stem:mic',
			fileLabel: 'mic',
			resolveInputs: buildMicStemInputs
		});
	}

	if (stemMode !== 'mixed-plus-all-audio') {
		return specs;
	}

	for (const call of snapshot.activeCalls) {
		if (!call.stream.getAudioTracks().length) continue;
		specs.push({
			id: `stem:call:${call.userId}`,
			fileLabel: buildStemLabel('participant', call.username || call.userId, `call:${call.userId}`),
			resolveInputs: buildParticipantStemInputs(call.userId)
		});
	}

	if (snapshot.localScreenStream?.getAudioTracks().length) {
		specs.push({
			id: 'stem:share:local',
			fileLabel: 'screen-share-local',
			resolveInputs: buildShareStemInputs('local', true)
		});
	}

	for (const share of snapshot.screenShares) {
		if (!share.stream.getAudioTracks().length) continue;
		specs.push({
			id: `stem:share:${share.userId}`,
			fileLabel: buildStemLabel('screen-share', share.username || share.userId, `share:${share.userId}`),
			resolveInputs: buildShareStemInputs(share.userId, false)
		});
	}

	return specs;
}

export class CallRecordingSession {
	private readonly artifacts = new Map<string, RecordingArtifactHandle>();
	private readonly startedAt = Date.now();
	private readonly subscriptions: Array<() => void> = [];
	private readonly mode: CallRecordingMode;
	private readonly preset: CallRecordingPreset;
	private readonly stemMode: any;
	private readonly mainMimeType: string;
	private readonly respectLocalMute: boolean | null;

	private constructor(
		mode: CallRecordingMode,
		preset: CallRecordingPreset,
		stemMode: any,
		mainMimeType: string,
		respectLocalMute: boolean | null
	) {
		this.mode = mode;
		this.preset = preset;
		this.stemMode = stemMode;
		this.mainMimeType = mainMimeType;
		this.respectLocalMute = respectLocalMute;
		this.installSubscriptions();
	}

	static async create(options: {
		mode: CallRecordingMode;
		preset: CallRecordingPreset;
		stemMode: any;
		respectLocalMute: boolean | null;
	}): Promise<CallRecordingSession> {
		ensureMediaRecorderSupport();
		const snapshot = getCurrentSnapshot();
		if (!snapshot.isInCall) {
			throw new Error('Join a call before starting a recording.');
		}

		const session = new CallRecordingSession(
			options.mode,
			options.preset,
			options.stemMode,
			pickMimeType(options.mode),
			options.respectLocalMute
		);

		try {
			session.ensureMainArtifact();
			session.ensureStemArtifacts(snapshot);
			session.refresh(snapshot);
			return session;
		} catch (error) {
			await session.dispose();
			throw error;
		}
	}

	private ensureMainArtifact(): void {
		if (this.artifacts.has('mixed')) return;
		this.artifacts.set(
			'mixed',
			createRecordingArtifact({
				id: 'mixed',
				mode: this.mode,
				preset: this.preset,
				fileName: buildSuggestedFileName(this.mode, this.mainMimeType, this.startedAt),
				mimeType: this.mainMimeType,
				resolveInputs: buildMixedAudioInputs,
				respectLocalMute: this.respectLocalMute,
				compressorEnabled: true
			})
		);
	}

	private ensureStemArtifacts(snapshot: CallRecordingSnapshot): void {
		const stemMimeType = pickAudioMimeType();
		for (const spec of buildStemArtifactSpecs(snapshot, this.stemMode)) {
			if (this.artifacts.has(spec.id)) continue;
			this.artifacts.set(
				spec.id,
				createRecordingArtifact({
					id: spec.id,
					mode: 'audio',
					preset: this.preset,
					fileName: buildStemFileName(spec.fileLabel, stemMimeType, this.startedAt),
					mimeType: stemMimeType,
					resolveInputs: spec.resolveInputs,
					respectLocalMute: this.respectLocalMute,
					compressorEnabled: false
				})
			);
		}
	}

	private installSubscriptions(): void {
		const sync = () => {
			const snapshot = getCurrentSnapshot();
			if (!snapshot.isInCall) {
				// Will be handled by calling module
				return;
			}
			this.refresh(snapshot);
		};

		this.subscriptions.push(activeCalls.subscribe(() => sync()));
		this.subscriptions.push(screenShares.subscribe(() => sync()));
		this.subscriptions.push(isSharing.subscribe(() => sync()));
		this.subscriptions.push(isMuted.subscribe(() => sync()));
		this.subscriptions.push(isVideoOff.subscribe(() => sync()));
		this.subscriptions.push(isLocalSpeaking.subscribe(() => sync()));
		this.subscriptions.push(localStream.subscribe(() => sync()));
		this.subscriptions.push(localScreenStream.subscribe(() => sync()));
		this.subscriptions.push(isInCall.subscribe(() => sync()));
	}

	private clearSubscriptions(): void {
		for (const unsubscribe of this.subscriptions) {
			unsubscribe();
		}
		this.subscriptions.length = 0;
	}

	refresh(snapshot = getCurrentSnapshot()): void {
		this.ensureStemArtifacts(snapshot);
		for (const artifact of this.artifacts.values()) {
			artifact.audioMixer.sync(snapshot);
			artifact.videoComposer?.sync(snapshot);
		}
	}

	getState(): Pick<any, 'mode' | 'preset' | 'stemMode' | 'mimeType' | 'fileName' | 'startedAt'> {
		const mainArtifact = this.artifacts.get('mixed');
		return {
			mode: this.mode,
			preset: this.preset,
			stemMode: this.stemMode,
			mimeType: this.mainMimeType || null,
			fileName: mainArtifact?.fileName || null,
			startedAt: this.startedAt
		};
	}

	async stop(): Promise<RecordingExportResult> {
		this.clearSubscriptions();
		const artifacts = [...this.artifacts.values()];
		for (const artifact of artifacts) {
			if (artifact.recorder.state !== 'inactive') {
				artifact.recorder.stop();
			}
		}

		const exports = await Promise.all(artifacts.map((artifact) => artifact.stopPromise));
		const mainExport = exports[0];
		return {
			savedPath: mainExport?.savedPath || exports.find((entry) => entry.savedPath)?.savedPath || null,
			savedPaths: exports.map((entry) => entry.savedPath).filter((value): value is string => Boolean(value)),
			savedFileCount: exports.length,
			saveTarget: mainExport?.saveTarget || 'browser'
		};
	}

	private async dispose(): Promise<void> {
		this.clearSubscriptions();

		const disposals = [...this.artifacts.values()].map((artifact) => disposeRecordingArtifact(artifact));
		this.artifacts.clear();
		await Promise.allSettled(disposals);
	}
}
