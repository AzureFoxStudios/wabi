import {
	DEFAULT_ACTIVE_SPEAKER_STATE,
	computeCallLayout,
	type ActiveSpeakerState,
	type CallLayoutInput
} from './callLayoutManager';

interface LayoutTestResult {
	name: string;
	passed: boolean;
	error?: string;
}

function assert(condition: boolean, message: string): void {
	if (!condition) {
		throw new Error(message);
	}
}

function makeInput(participantCount: number, overrides: Partial<CallLayoutInput> = {}): CallLayoutInput {
	const participants = Array.from({ length: participantCount }, (_, index) => ({
		id: `u${index + 1}`,
		hasVideo: true
	}));
	return {
		participants,
		shares: [],
		pins: [],
		activeSpeakerLevels: {},
		nowMs: 0,
		activeSpeakerState: DEFAULT_ACTIVE_SPEAKER_STATE,
		...overrides
	};
}

export function runCallLayoutManagerTests(): LayoutTestResult[] {
	const results: LayoutTestResult[] = [];

	try {
		const layout = computeCallLayout({
			participants: [
				{ id: 'u1', hasVideo: false },
				{ id: 'u2', hasVideo: false }
			],
			shares: [],
			pins: [],
			activeSpeakerLevels: {},
			nowMs: 0,
			activeSpeakerState: DEFAULT_ACTIVE_SPEAKER_STATE
		});
		assert(layout.template === 'floating-bubbles', '0 video + 0 share should use floating-bubbles');
		assert(layout.tileIds.length === 2, 'all participants should render as avatar bubbles');
		results.push({ name: '0 video + 0 share => floating bubbles', passed: true });
	} catch (error) {
		results.push({
			name: '0 video + 0 share => floating bubbles',
			passed: false,
			error: error instanceof Error ? error.message : String(error)
		});
	}

	try {
		const layout = computeCallLayout(makeInput(1));
		assert(layout.template === 'single-hero', '1 video should use single-hero template');
		assert(layout.heroIds[0] === 'video:u1', 'single video should be hero');
		results.push({ name: '1 video => single hero', passed: true });
	} catch (error) {
		results.push({
			name: '1 video => single hero',
			passed: false,
			error: error instanceof Error ? error.message : String(error)
		});
	}

	try {
		const layout = computeCallLayout(makeInput(2));
		assert(layout.template === 'split', '2 videos should use split template');
		assert(layout.heroIds.length === 0, 'split template should not force heroes');
		results.push({ name: '2 videos => 50/50 split', passed: true });
	} catch (error) {
		results.push({
			name: '2 videos => 50/50 split',
			passed: false,
			error: error instanceof Error ? error.message : String(error)
		});
	}

	try {
		const layout = computeCallLayout(makeInput(3));
		assert(layout.template === 'hero-stack', '3 videos should use hero-stack template');
		assert(layout.heroIds.length === 1, 'hero-stack should pick one hero');
		results.push({ name: '3 videos => hero + 2 stack', passed: true });
	} catch (error) {
		results.push({
			name: '3 videos => hero + 2 stack',
			passed: false,
			error: error instanceof Error ? error.message : String(error)
		});
	}

	try {
		const noSpeaker = computeCallLayout(makeInput(5));
		assert(noSpeaker.template === 'uniform-grid', '5 videos without pin/speaker should fallback to uniform-grid');
		const withSpeaker = computeCallLayout(makeInput(5, {
			nowMs: 1300,
			activeSpeakerLevels: { u3: 0.9 },
			activeSpeakerState: {
				heroParticipantId: null,
				candidateParticipantId: 'u3',
				candidateSinceMs: 0,
				lastSwitchAtMs: null
			}
		}));
		assert(withSpeaker.template === 'double-hero-triple', '5 videos with clear speaker should use double-hero-triple');
		results.push({ name: '5 videos => fallback or double-hero-triple', passed: true });
	} catch (error) {
		results.push({
			name: '5 videos => fallback or double-hero-triple',
			passed: false,
			error: error instanceof Error ? error.message : String(error)
		});
	}

	try {
		const layout = computeCallLayout({
			participants: [
				{ id: 'u1', hasVideo: true },
				{ id: 'u2', hasVideo: true }
			],
			shares: [{ id: 'u2', participantId: 'u2' }],
			pins: [],
			activeSpeakerLevels: {},
			nowMs: 0,
			activeSpeakerState: DEFAULT_ACTIVE_SPEAKER_STATE
		});
		assert(layout.template === 'screen-hero', 'screen share should force screen-hero template');
		assert(layout.heroIds[0] === 'share:u2', 'screen share should be hero by default');
		results.push({ name: 'screenshare is dominant hero', passed: true });
	} catch (error) {
		results.push({
			name: 'screenshare is dominant hero',
			passed: false,
			error: error instanceof Error ? error.message : String(error)
		});
	}

	try {
		const layout = computeCallLayout({
			participants: [
				{ id: 'u1', hasVideo: true },
				{ id: 'u2', hasVideo: true }
			],
			shares: [{ id: 'u2', participantId: 'u2' }],
			pins: ['video:u1'],
			activeSpeakerLevels: {},
			nowMs: 0,
			activeSpeakerState: DEFAULT_ACTIVE_SPEAKER_STATE
		});
		assert(layout.heroIds[0] === 'video:u1', 'pin should override auto hero selection');
		results.push({ name: 'pin override wins over auto selection', passed: true });
	} catch (error) {
		results.push({
			name: 'pin override wins over auto selection',
			passed: false,
			error: error instanceof Error ? error.message : String(error)
		});
	}

	try {
		const initialState: ActiveSpeakerState = {
			heroParticipantId: null,
			candidateParticipantId: null,
			candidateSinceMs: null,
			lastSwitchAtMs: null
		};

		const beforeHold = computeCallLayout(makeInput(3, {
			nowMs: 1000,
			activeSpeakerLevels: { u2: 0.9 },
			activeSpeakerState: initialState
		}));
		assert(beforeHold.heroIds.length === 1 && beforeHold.heroIds[0] === 'video:u1', 'before hold, hero should remain deterministic fallback');

		const afterHold = computeCallLayout(makeInput(3, {
			nowMs: 1400,
			activeSpeakerLevels: { u2: 0.9 },
			activeSpeakerState: {
				...beforeHold.nextActiveSpeakerState,
				candidateParticipantId: 'u2',
				candidateSinceMs: 100
			}
		}));
		assert(afterHold.heroIds[0] === 'video:u2', 'after hold, active speaker should become hero');

		const cooldownBlocked = computeCallLayout(makeInput(3, {
			nowMs: 3000,
			activeSpeakerLevels: { u3: 0.95 },
			activeSpeakerState: {
				heroParticipantId: 'u2',
				candidateParticipantId: 'u3',
				candidateSinceMs: 1600,
				lastSwitchAtMs: 1400
			}
		}));
		assert(cooldownBlocked.heroIds[0] === 'video:u2', 'cooldown should block immediate hero switch');
		results.push({ name: 'active speaker hysteresis hold+cooldown', passed: true });
	} catch (error) {
		results.push({
			name: 'active speaker hysteresis hold+cooldown',
			passed: false,
			error: error instanceof Error ? error.message : String(error)
		});
	}

	try {
		const layout = computeCallLayout(makeInput(3, {
			nowMs: 2500,
			activeSpeakerLevels: { u1: 0.88, u2: 0.88 },
			activeSpeakerState: {
				heroParticipantId: null,
				candidateParticipantId: 'u1',
				candidateSinceMs: 1000,
				lastSwitchAtMs: null
			}
		}));
		assert(layout.heroIds[0] === 'video:u1', 'equal speaker levels should tie-break by participant id');
		results.push({ name: 'speaker tie-break is deterministic by participant id', passed: true });
	} catch (error) {
		results.push({
			name: 'speaker tie-break is deterministic by participant id',
			passed: false,
			error: error instanceof Error ? error.message : String(error)
		});
	}

	return results;
}
