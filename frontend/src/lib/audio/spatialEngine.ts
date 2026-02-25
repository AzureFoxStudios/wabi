export type SpatialRenderMode = 'pan_distance' | 'full_3d' | 'stereo';

export interface SpatialPosition {
	x: number;
	y: number;
	z: number;
}

interface SpatialSourceNodes {
	id: string;
	stream: MediaStream;
	streamSignature: string;
	sourceNode: MediaStreamAudioSourceNode;
	gainNode: GainNode;
	pannerNode: PannerNode | StereoPannerNode | null;
	position: SpatialPosition;
}

interface SpatialEngineOptions {
	masterStrength: number;
	distanceScale: number;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function buildStreamSignature(stream: MediaStream): string {
	return stream.getTracks().map((track) => `${track.kind}:${track.id}`).sort().join('|');
}

export class SpatialAudioEngine {
	private context: AudioContext;
	private mode: SpatialRenderMode;
	private masterGain: GainNode;
	private options: SpatialEngineOptions;
	private sources = new Map<string, SpatialSourceNodes>();

	constructor(mode: SpatialRenderMode, options: SpatialEngineOptions) {
		this.context = new AudioContext({ sampleRate: 48000 });
		this.mode = mode;
		this.options = {
			masterStrength: clamp(options.masterStrength, 0, 1),
			distanceScale: clamp(options.distanceScale, 0.4, 4)
		};
		this.masterGain = this.context.createGain();
		this.masterGain.gain.value = this.options.masterStrength;
		this.masterGain.connect(this.context.destination);

		try {
			this.context.listener.positionX.value = 0;
			this.context.listener.positionY.value = 0;
			this.context.listener.positionZ.value = 0;
			this.context.listener.forwardX.value = 0;
			this.context.listener.forwardY.value = 0;
			this.context.listener.forwardZ.value = -1;
			this.context.listener.upX.value = 0;
			this.context.listener.upY.value = 1;
			this.context.listener.upZ.value = 0;
		} catch {
			// Some browsers may not expose full listener positioning API.
		}
	}

	getMode(): SpatialRenderMode {
		return this.mode;
	}

	getSourceIds(): string[] {
		return Array.from(this.sources.keys());
	}

	async resume(): Promise<void> {
		if (this.context.state !== 'running') {
			await this.context.resume();
		}
	}

	setOptions(options: Partial<SpatialEngineOptions>): void {
		if (typeof options.masterStrength === 'number') {
			this.options.masterStrength = clamp(options.masterStrength, 0, 1);
			this.masterGain.gain.value = this.options.masterStrength;
		}
		if (typeof options.distanceScale === 'number') {
			this.options.distanceScale = clamp(options.distanceScale, 0.4, 4);
			for (const source of this.sources.values()) {
				this.updateSourcePosition(source.id, source.position);
			}
		}
	}

	setMode(mode: SpatialRenderMode): void {
		if (mode === this.mode) return;
		this.mode = mode;
		const cached = Array.from(this.sources.values()).map((source) => ({
			id: source.id,
			stream: source.stream,
			position: source.position
		}));
		for (const sourceId of Array.from(this.sources.keys())) {
			this.detachSource(sourceId);
		}
		for (const source of cached) {
			this.attachSource(source.id, source.stream, source.position);
		}
	}

	attachSource(id: string, stream: MediaStream, position: SpatialPosition): void {
		const existing = this.sources.get(id);
		const incomingSignature = buildStreamSignature(stream);
		if (existing && existing.streamSignature === incomingSignature) {
			this.updateSourcePosition(id, position);
			return;
		}
		this.detachSource(id);
		const liveAudio = stream.getAudioTracks().some((track) => track.readyState === 'live');
		if (!liveAudio) return;

		const sourceNode = this.context.createMediaStreamSource(stream);
		const gainNode = this.context.createGain();
		gainNode.gain.value = 1;

		let pannerNode: PannerNode | StereoPannerNode | null = null;
		if (this.mode === 'full_3d') {
			const panner = this.context.createPanner();
			panner.panningModel = 'HRTF';
			panner.distanceModel = 'inverse';
			panner.refDistance = 1;
			panner.maxDistance = 50;
			panner.rolloffFactor = 1.2;
			panner.coneInnerAngle = 360;
			panner.coneOuterAngle = 360;
			sourceNode.connect(panner);
			panner.connect(gainNode);
			pannerNode = panner;
		} else if (this.mode === 'pan_distance') {
			const stereo = this.context.createStereoPanner();
			sourceNode.connect(stereo);
			stereo.connect(gainNode);
			pannerNode = stereo;
		} else {
			sourceNode.connect(gainNode);
		}

		gainNode.connect(this.masterGain);
		const nodes: SpatialSourceNodes = {
			id,
			stream,
			streamSignature: incomingSignature,
			sourceNode,
			gainNode,
			pannerNode,
			position
		};
		this.sources.set(id, nodes);
		this.updateSourcePosition(id, position);
	}

	updateSourcePosition(id: string, position: SpatialPosition): void {
		const nodes = this.sources.get(id);
		if (!nodes) return;
		nodes.position = position;
		const now = this.context.currentTime;
		const transitionWindow = 0.08;

		const scaledX = clamp(position.x * this.options.distanceScale, -20, 20);
		const scaledY = clamp(position.y * this.options.distanceScale, -8, 8);
		const scaledZ = clamp(position.z * this.options.distanceScale, -20, 20);

		if (!nodes.pannerNode) {
			nodes.gainNode.gain.value = 1;
			return;
		}

		if ('positionX' in nodes.pannerNode) {
			const panner = nodes.pannerNode as PannerNode;
			panner.positionX.cancelScheduledValues(now);
			panner.positionY.cancelScheduledValues(now);
			panner.positionZ.cancelScheduledValues(now);
			panner.positionX.linearRampToValueAtTime(scaledX, now + transitionWindow);
			panner.positionY.linearRampToValueAtTime(scaledY, now + transitionWindow);
			panner.positionZ.linearRampToValueAtTime(scaledZ, now + transitionWindow);
			return;
		}

		const stereo = nodes.pannerNode as StereoPannerNode;
		stereo.pan.cancelScheduledValues(now);
		stereo.pan.linearRampToValueAtTime(clamp(scaledX / 6, -1, 1), now + transitionWindow);
		const distance = Math.sqrt((scaledX * scaledX) + (scaledZ * scaledZ));
		nodes.gainNode.gain.cancelScheduledValues(now);
		nodes.gainNode.gain.linearRampToValueAtTime(clamp(1 - (distance / 24), 0.45, 1), now + transitionWindow);
	}

	detachSource(id: string): void {
		const nodes = this.sources.get(id);
		if (!nodes) return;
		try {
			nodes.sourceNode.disconnect();
			nodes.pannerNode?.disconnect();
			nodes.gainNode.disconnect();
		} catch {
			// no-op
		}
		this.sources.delete(id);
	}

	dispose(): void {
		for (const sourceId of Array.from(this.sources.keys())) {
			this.detachSource(sourceId);
		}
		try {
			this.masterGain.disconnect();
		} catch {
			// no-op
		}
		void this.context.close().catch(() => undefined);
	}
}
