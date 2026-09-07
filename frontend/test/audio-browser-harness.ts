import { WabidbMediaRelay } from '../src/lib/wabidbMediaRelay';
import { ensureCallAudioGraph } from '../src/lib/callAudioGraph';
import { addPeerMicrophone, gatePeerMicrophone, replacePeerMicrophone, releasePeerMicrophones } from '../src/lib/peerMicrophone';
import { waitForPeerConnection } from '../src/lib/peerConnectionReady';
import { createAudioCaptureSession, disposeAudioCaptureSession } from '../src/lib/audioCapture';
import { setAudioProcessingMode } from '../src/lib/mediaRuntime';
import { registerPeerAudioReceiver, releasePeerAudioReceivers, selectRelayAudio } from '../src/lib/peerAudioPlayback';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string) {
	for (let i = 0; i < 100; i++) { if (check()) return; await pause(100); }
	throw new Error(`Timed out: ${label}`);
}
function assert(value: unknown, label: string) { if (!value) throw new Error(label); }
class Socket {
	connected = true;
	other!: Socket;
	listeners = new Map<string, Set<(data: any) => void>>();
	constructor(public id: string) {}
	on(event: string, handler: (data: any) => void) {
		if (!this.listeners.has(event)) this.listeners.set(event, new Set());
		this.listeners.get(event)!.add(handler);
	}
	off(event: string, handler: (data: any) => void) { this.listeners.get(event)?.delete(handler); }
	emit(event: string, data: any) {
		if (event === 'wabidb-media') {
			queueMicrotask(() => this.other.listeners.get(event)?.forEach(handler => handler({ ...data, senderSocket: this.id })));
		}
	}
}

async function run() {
	const results: string[] = [];
	// Privacy tripwire: this test uses ONLY generated tracks. If a recorder
	// attempts to acquire a real/default microphone, fail rather than permit it.
	let microphoneRequests = 0;
	navigator.mediaDevices.getUserMedia = async () => { microphoneRequests++; throw new Error('Unexpected microphone acquisition'); };
	const context = new AudioContext({ sampleRate: 48000 });
	await context.resume();
	const graph = ensureCallAudioGraph()!;
	graph.master.gain.value = 0; // inaudible test; meters tap upstream of master
	await graph.ctx.resume();
	const tones: Array<{ oscillator: OscillatorNode; stream: MediaStream }> = [];
	function tone(frequency: number) {
		const oscillator = context.createOscillator();
		oscillator.frequency.value = frequency;
		const gain = context.createGain(); gain.gain.value = 0.2;
		const destination = context.createMediaStreamDestination();
		oscillator.connect(gain).connect(destination); oscillator.start();
		const value = { oscillator, stream: destination.stream }; tones.push(value); return value.stream;
	}
	function meter(ctx: AudioContext, source: AudioNode) {
		const analyser = ctx.createAnalyser(); analyser.fftSize = 2048;
		source.connect(analyser);
		const time = new Float32Array(analyser.fftSize);
		const spectrum = new Float32Array(analyser.frequencyBinCount);
		return {
			rms: () => { analyser.getFloatTimeDomainData(time); return Math.sqrt(time.reduce((sum, x) => sum + x * x, 0) / time.length); },
			peak: () => {
				analyser.getFloatFrequencyData(spectrum);
				let peak = 0; for (let i = 1; i < spectrum.length; i++) if (spectrum[i] > spectrum[peak]) peak = i;
				return peak * ctx.sampleRate / analyser.fftSize;
			}
		};
	}
	const a = new Socket('a'), b = new Socket('b'); a.other = b; b.other = a;
	const mic = tone(440), screen = tone(880), replacement = tone(660);
	const errors: string[] = [];
	const tx = new WabidbMediaRelay({ sessionId: 'smoke', userId: '1', socket: a, onError: e => errors.push(e.message) });
	const rx = new WabidbMediaRelay({ sessionId: 'smoke', userId: '2', socket: b, capture: false, onError: e => errors.push(e.message) });
	const pcA = new RTCPeerConnection({ iceServers: [] }), pcB = new RTCPeerConnection({ iceServers: [] });
	try {
		await rx.start(new MediaStream()); await rx.setRoomReady(true);
		await tx.start(mic); await tx.setRoomReady(true); await tx.startScreenAudioCapture(screen);
		await until(() => (rx as any).userPlaybackChains.size === 2, 'both relay sources decoded');
		const micChain = (rx as any).userPlaybackChains.get(JSON.stringify(['1', 'a', false]));
		const screenChain = (rx as any).userPlaybackChains.get(JSON.stringify(['1', 'a', true]));
		const voiceMeter = meter(graph.ctx, micChain.gain), screenMeter = meter(graph.ctx, screenChain.gain);
		await until(() => voiceMeter.rms() > 0.02 && screenMeter.rms() > 0.02, 'both relay sources rendered');
		assert(Math.abs(voiceMeter.peak() - 440) < 40, 'relay selects microphone tone');
		assert(Math.abs(screenMeter.peak() - 880) < 40, 'relay selects screen tone');
		results.push('relay: distinct microphone and screen tones decoded/rendered');
		await tx.setCapture(false); await pause(800);
		assert(voiceMeter.rms() < 0.001 && screenMeter.rms() > 0.02, 'muted mic does not leak through screen lane');
		results.push('relay: mic mute leaves only screen sound');
		mic.removeTrack(mic.getAudioTracks()[0]); mic.addTrack(replacement.getAudioTracks()[0]);
		await tx.setCapture(true);
		await until(() => voiceMeter.rms() > 0.02 && Math.abs(voiceMeter.peak() - 660) < 40, 'relay microphone replacement');
		results.push('relay: input replacement reaches existing call');
		await tx.setRoomReady(false); await pause(800);
		assert(voiceMeter.rms() < 0.001 && screenMeter.rms() < 0.001, 'room loss gates both sources');
		await tx.setRoomReady(true);
		await until(() => voiceMeter.rms() > 0.02 && screenMeter.rms() > 0.02, 'fresh headers after room rejoin');
		results.push('relay: room loss/rejoin restores both sources');

		// Real local WebRTC connection using the production per-peer mic owner.
		const sender = addPeerMicrophone(pcA, replacement.getAudioTracks()[0], replacement);
		gatePeerMicrophone(pcA, true);
		const returnSender = addPeerMicrophone(pcB, screen.getAudioTracks()[0], screen);
		gatePeerMicrophone(pcB, true);
		let remote: MediaStream | undefined;
		let returnRemote: MediaStream | undefined;
		pcB.ontrack = event => { remote = event.streams[0]; };
		pcA.ontrack = event => { returnRemote = event.streams[0]; };
		const pendingA: RTCIceCandidate[] = [], pendingB: RTCIceCandidate[] = [];
		pcA.onicecandidate = event => { if (event.candidate) pendingB.push(event.candidate); };
		pcB.onicecandidate = event => { if (event.candidate) pendingA.push(event.candidate); };
		await pcA.setLocalDescription(await pcA.createOffer());
		await until(() => pcA.iceGatheringState === 'complete', 'caller ICE gathering');
		await pcB.setRemoteDescription(pcA.localDescription!);
		for (const candidate of pendingB) await pcB.addIceCandidate(candidate);
		await pcB.setLocalDescription(await pcB.createAnswer());
		await until(() => pcB.iceGatheringState === 'complete', 'callee ICE gathering');
		await pcA.setRemoteDescription(pcB.localDescription!);
		for (const candidate of pendingA) await pcA.addIceCandidate(candidate);
		await Promise.all([waitForPeerConnection(pcA), waitForPeerConnection(pcB)]);
		assert(remote, 'P2P remote stream');
		const remoteElement = document.createElement('audio');
		remoteElement.muted = true;
		remoteElement.srcObject = remote!;
		document.body.append(remoteElement);
		await remoteElement.play();
		const node = context.createMediaStreamSource(remote!);
		const silent = context.createGain(); silent.gain.value = 0; node.connect(silent).connect(context.destination);
		const p2pMeter = meter(context, node);
		assert(returnRemote, 'P2P reverse-direction stream');
		const returnElement = document.createElement('audio');
		returnElement.muted = true; returnElement.srcObject = returnRemote!;
		document.body.append(returnElement); await returnElement.play();
		const returnNode = context.createMediaStreamSource(returnRemote!);
		returnNode.connect(silent);
		const returnMeter = meter(context, returnNode);
		await until(() => returnMeter.rms() > 0.02 && Math.abs(returnMeter.peak() - 880) < 40, 'P2P reverse direction renders');
		try { await until(() => p2pMeter.rms() > 0.02, 'P2P renders selected microphone'); }
		catch (error) {
			console.error(JSON.stringify({ contextState: context.state, rms: p2pMeter.rms(),
				track: { enabled: sender.track?.enabled, state: sender.track?.readyState },
				send: [...(await pcA.getStats()).values()].filter(s => s.type === 'outbound-rtp' || s.type === 'media-source'),
				receive: [...(await pcB.getStats()).values()].filter(s => s.type === 'inbound-rtp') }));
			throw error;
		}
		gatePeerMicrophone(pcA, false); await pause(800);
		assert(p2pMeter.rms() < 0.001, 'P2P mute silences receiver');
		assert(returnMeter.rms() > 0.02, 'muting one direction does not mute the other participant');
		await replacePeerMicrophone(sender, screen.getAudioTracks()[0]);
		await pause(300); assert(p2pMeter.rms() < 0.001, 'replacement stays muted');
		gatePeerMicrophone(pcA, true);
		await until(() => p2pMeter.rms() > 0.02 && Math.abs(p2pMeter.peak() - 880) < 40, 'P2P replacement unmute');
		results.push('P2P: real bidirectional ICE/media, independent mute, replacement while muted, unmute');
		registerPeerAudioReceiver(pcB, 'smoke', '1', remote!.getAudioTracks()[0]);
		selectRelayAudio(rx, 'smoke', '1', true);
		await pause(800);
		assert(p2pMeter.rms() < 0.001, 'relay selection suppresses duplicate P2P reception');
		assert(sender.track?.enabled && pcA.connectionState === 'connected', 'outbound mic survives receive handover');
		assert(returnSender.track?.enabled && returnMeter.rms() > 0.02, 'reverse-direction microphone still renders during receive handover');
		selectRelayAudio(rx, 'smoke', '1', false);
		await until(() => p2pMeter.rms() > 0.02, 'P2P reception resumes after relay loss');
		results.push('handover: duplicate P2P reception suppressed/restored without closing sender');
		assert(microphoneRequests === 0, 'no extra microphone acquisition');
		assert(errors.length === 0, errors.join('; '));
		results.push('privacy: zero getUserMedia requests');

		// Exercise the actual browser/Tauri-webview DSP capture path without
		// permission or hardware. Only this explicit call may use the stub.
		const rejectAcquisition = navigator.mediaDevices.getUserMedia;
		navigator.mediaDevices.getUserMedia = async () => tone(550);
		setAudioProcessingMode('dsp');
		const dsp = await createAudioCaptureSession();
		navigator.mediaDevices.getUserMedia = rejectAcquisition;
		try {
			assert(dsp.pipeline, 'DSP pipeline created');
			const pipeline = dsp.pipeline!;
			const dspMeter = meter(context, context.createMediaStreamSource(new MediaStream([dsp.outputTrack])));
			await until(() => dspMeter.rms() > 0.02, 'DSP microphone produces audio');
			await pipeline.context.suspend();
			document.dispatchEvent(new Event('pointerdown'));
			await until(() => pipeline.context.state === 'running' && dspMeter.rms() > 0.02, 'DSP context recovers on interaction');
			results.push('DSP: actual processed microphone renders and resumes its own context');
		} finally { disposeAudioCaptureSession(dsp); }
		assert(dsp.sourceStream.getTracks().every(track => track.readyState === 'ended'), 'DSP disposal releases source microphone');
		return results;
	} finally {
		tx.stop(); rx.stop();
		releasePeerAudioReceivers(pcA); releasePeerAudioReceivers(pcB);
		releasePeerMicrophones(pcA); releasePeerMicrophones(pcB); pcA.close(); pcB.close();
		for (const source of tones) { source.oscillator.stop(); source.stream.getTracks().forEach(track => track.stop()); }
		await context.close(); await graph.ctx.close();
	}
}

document.querySelector('button')!.addEventListener('click', () => {
	(window as any).__audioSmoke = { status: 'running' };
	void run().then(results => {
		(window as any).__audioSmoke = { status: 'passed', results };
	}, error => {
		(window as any).__audioSmoke = { status: 'failed', error: String(error), stack: error.stack };
	});
});
(window as any).__audioSmoke = { status: 'ready' };
