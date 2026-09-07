import { describe, expect, test } from 'bun:test';
import { addPeerMicrophone, gatePeerMicrophone, replacePeerMicrophone, releasePeerMicrophones } from './peerMicrophone';
import { waitForPeerConnection } from './peerConnectionReady';

class Track {
	kind = 'audio'; enabled = true; readyState = 'live';
	constructor(public id = 'selected-mic') {}
	clone() { return new Track(this.id); }
	stop() { this.readyState = 'ended'; }
}
function peer() {
	const senders: any[] = [];
	const pc = {
		addTrack(track: Track) {
			const sender = { track, async replaceTrack(next: Track) { this.track = next; },
				setParameters() { throw new Error('WebView parameter update unsupported'); } };
			senders.push(sender); return sender;
		},
		getSenders: () => senders
	} as any;
	return pc;
}
describe('P2P microphone isolation', () => {
	test('mute/routing gates synchronously without touching source, other peers or screen sound', () => {
		const source = new Track();
		const a = peer(), b = peer();
		const sa = addPeerMicrophone(a, source as any, {} as any);
		const sb = addPeerMicrophone(b, source as any, {} as any);
		const screen = a.addTrack(new Track('screen-audio'));
		expect(sa.track!.enabled).toBe(false);
		gatePeerMicrophone(a, true); gatePeerMicrophone(b, true);
		gatePeerMicrophone(a, false);
		expect(sa.track!.enabled).toBe(false);
		expect(sb.track!.enabled).toBe(true);
		expect(source.enabled).toBe(true);
		expect(screen.track.enabled).toBe(true);
		releasePeerMicrophones(a); releasePeerMicrophones(b);
		expect(source.readyState).toBe('live');
		expect(screen.track.readyState).toBe('live');
	});
	test('mute applies to pending replacement and only owned clones are released', async () => {
		const pc = peer();
		const source = new Track();
		const sender = addPeerMicrophone(pc, source as any, {} as any);
		const old = sender.track!;
		gatePeerMicrophone(pc, true);
		let complete!: () => void;
		(sender as any).replaceTrack = async (next: Track) => {
			await new Promise<void>(r => { complete = r; });
			(sender as any).track = next;
		};
		const replacement = replacePeerMicrophone(sender, new Track('new-device') as any);
		await Promise.resolve();
		gatePeerMicrophone(pc, false);
		complete(); await replacement;
		expect(sender.track!.enabled).toBe(false);
		expect(sender.track!.id).toBe('new-device');
		expect(old.readyState).toBe('ended');
		releasePeerMicrophones(pc);
		expect(sender.track!.readyState).toBe('ended');
		expect(source.readyState).toBe('live');
	});
	test('replacement failure fails closed instead of continuing the old microphone', async () => {
		const pc = peer();
		const sender = addPeerMicrophone(pc, new Track() as any, {} as any);
		gatePeerMicrophone(pc, true);
		sender.replaceTrack = async () => { throw new Error('replacement failed'); };
		await expect(replacePeerMicrophone(sender, new Track('new-device') as any)).rejects.toThrow('replacement failed');
		expect(sender.track!.enabled).toBe(false);
		expect(sender.track!.readyState).toBe('ended');
		releasePeerMicrophones(pc);
	});
});

describe('P2P readiness', () => {
	test('does not resolve on signaling and does not overwrite the owner handler', async () => {
		const pc = Object.assign(new EventTarget(), { connectionState: 'connecting' });
		let ready = false;
		const wait = waitForPeerConnection(pc as any).then(() => { ready = true; });
		await Promise.resolve(); expect(ready).toBe(false);
		pc.connectionState = 'connected'; pc.dispatchEvent(new Event('connectionstatechange'));
		await wait; expect(ready).toBe(true);
	});
	test('closed, failed and timed-out candidates reject', async () => {
		for (const connectionState of ['closed', 'failed', 'connecting']) {
			const pc = Object.assign(new EventTarget(), { connectionState });
			await expect(waitForPeerConnection(pc as any, 5)).rejects.toThrow();
		}
	});
});
