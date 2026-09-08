import { mount, unmount } from 'svelte';
import AudioSettingsTab from '../src/lib/components/settings/AudioSettingsTab.svelte';
import { setAudioProcessingMode } from '../src/lib/mediaRuntime';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
async function until(check: () => boolean, label: string) {
	for (let n = 0; n < 100; n++) { if (check()) return; await pause(80); }
	throw new Error(`Timed out: ${label}`);
}

async function run() {
	const results: string[] = [];
	const context = new AudioContext();
	await context.resume();
	const sources: Array<{ stream: MediaStream; oscillator: OscillatorNode }> = [];
	const makeSource = () => {
		const oscillator = context.createOscillator();
		const destination = context.createMediaStreamDestination();
		oscillator.connect(destination); oscillator.start(); // no speaker connection
		sources.push({ stream: destination.stream, oscillator });
		return destination.stream;
	};
	const constraints: MediaStreamConstraints[] = [];
	let pendingPermission: ((stream: MediaStream) => void) | null = null;
	let deferPermission = false;
	navigator.mediaDevices.getUserMedia = async requested => {
		constraints.push(requested ?? {});
		if (deferPermission) return new Promise<MediaStream>(resolve => { pendingPermission = resolve; });
		return makeSource();
	};
	navigator.mediaDevices.enumerateDevices = async () => ['mic-a', 'mic-b'].map(deviceId => ({ deviceId, kind: 'audioinput', groupId: 'synthetic', label: deviceId, toJSON() { return {}; } })) as MediaDeviceInfo[];
	window.fetch = Object.assign(async () => new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } }), { preconnect() {} });
	const alerts: string[] = [];
	window.alert = message => alerts.push(String(message));
	const urls = new Set<string>();
	const createUrl = URL.createObjectURL.bind(URL), revokeUrl = URL.revokeObjectURL.bind(URL);
	URL.createObjectURL = object => { const url = createUrl(object); urls.add(url); return url; };
	URL.revokeObjectURL = url => { urls.delete(url); revokeUrl(url); };
	setAudioProcessingMode('dsp');
	const target = document.querySelector('#settings')!;
	let component: ReturnType<typeof mount> | null = null;
	const recordButton = () => [...target.querySelectorAll('button')].find(button => button.textContent?.includes('Record 4s Sample'))!;
	try {
		component = mount(AudioSettingsTab, { target });
		await until(() => target.querySelectorAll('#mic-device-select option').length === 3, 'settings device list renders');
		const switches = [...target.querySelectorAll<HTMLButtonElement>('button[role="switch"]')];
		assert(switches.length === 4, 'only the four effective switches remain');
		assert(switches.every(button => Boolean(button.getAttribute('aria-label')) && ['true', 'false'].includes(button.getAttribute('aria-checked') ?? '')), 'all switches expose their names and state');
		assert(![...target.querySelectorAll('.setting-label')].some(node => ['Sound Effects', 'Microphone', 'Camera', 'wabiDB Call Relay'].includes(node.textContent ?? '')), 'obsolete no-op permission/sound/relay switches are not offered');
		const spatial = target.querySelector<HTMLButtonElement>('button[aria-label="Spatial audio"]')!;
		spatial.closest('details')!.open = true;
		const wasEnabled = spatial.getAttribute('aria-checked');
		spatial.click();
		await until(() => spatial.getAttribute('aria-checked') !== wasEnabled, 'spatial switch publishes updated checked state');
		assert(target.querySelector<HTMLSelectElement>('#spatial-audio-mode')!.disabled === (spatial.getAttribute('aria-checked') === 'false'), 'dependent spatial settings follow the real switch');
		spatial.click();
		await until(() => spatial.getAttribute('aria-checked') === wasEnabled, 'spatial preference restored');
		assert(target.querySelector<HTMLButtonElement>('button[aria-label="SRT gateway"]')!.disabled, 'web runtime retains the native gateway capability gate');
		assert(!target.querySelector('#desktop-helper-name'), 'desktop helper controls remain desktop-only');
		assert(target.querySelector<HTMLInputElement>('input#spatial-strength')?.labels?.length === 1, 'spatial range has a real label');
		results.push('settings: truthful controls, named switches, dependent state and native gates');
		const select = target.querySelector<HTMLSelectElement>('#mic-device-select')!;
		select.value = 'mic-b'; select.dispatchEvent(new Event('change', { bubbles: true }));
		await until(() => (window as any).__settingsApplyCount === 1, 'device selector requests active-call replacement');
		assert(select.value === 'mic-b', 'selected device is reactive');
		results.push('settings: real Svelte component renders and device change invokes call update');
		recordButton().click();
		await until(() => Boolean(target.querySelector('audio[src]')), 'four-second test completes');
		assert((constraints[0].audio as MediaTrackConstraints).deviceId === 'mic-b', 'test uses selected microphone');
		assert(sources[0].stream.getAudioTracks()[0].readyState === 'ended', 'completed test releases microphone');
		assert(urls.size === 1, 'one preview URL owned');
		results.push('settings: selected-device DSP sample records and releases capture');

		deferPermission = true;
		recordButton().click();
		await until(() => pendingPermission !== null, 'permission pending');
		await unmount(component); component = null;
		const late = makeSource();
		pendingPermission!(late);
		await until(() => late.getAudioTracks()[0].readyState === 'ended', 'unmounted settings disposes late permission result');
		assert(urls.size === 0 && alerts.length === 0, 'no late preview or error dialog after close');
		results.push('settings: close during permission disposes late microphone and preview URLs');
		return results;
	} finally {
		if (component) await unmount(component);
		for (const source of sources) { source.oscillator.stop(); source.stream.getTracks().forEach(track => track.stop()); }
		await context.close();
		URL.createObjectURL = createUrl; URL.revokeObjectURL = revokeUrl;
	}
}

document.querySelector('#run')!.addEventListener('click', () => {
	(window as any).__audioSmoke = { status: 'running' };
	void run().then(results => { (window as any).__audioSmoke = { status: 'passed', results }; }, error => {
		(window as any).__audioSmoke = { status: 'failed', error: String(error), stack: error.stack };
	});
});
(window as any).__audioSmoke = { status: 'ready' };
