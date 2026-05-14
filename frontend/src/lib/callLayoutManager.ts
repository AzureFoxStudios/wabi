export type CallLayoutTemplate =
	| 'floating-bubbles'
	| 'screen-hero'
	| 'single-hero'
	| 'split'
	| 'hero-stack'
	| 'grid-2x2'
	| 'double-hero-triple'
	| 'uniform-grid'
	| 'scroll-grid';

export interface CallLayoutParticipant {
	id: string;
	hasVideo: boolean;
}

export interface CallLayoutShare {
	id: string;
	participantId: string;
}

export interface ActiveSpeakerState {
	heroParticipantId: string | null;
	candidateParticipantId: string | null;
	candidateSinceMs: number | null;
	lastSwitchAtMs: number | null;
}

export interface CallLayoutInput {
	participants: CallLayoutParticipant[];
	shares: CallLayoutShare[];
	pins: string[];
	activeSpeakerLevels: Record<string, number>;
	nowMs: number;
	activeSpeakerState?: ActiveSpeakerState;
}

export interface CallLayoutResult {
	template: CallLayoutTemplate;
	tileIds: string[];
	heroIds: string[];
	secondaryIds: string[];
	pinnedTileIds: string[];
	nextActiveSpeakerState: ActiveSpeakerState;
}

const AUDIO_THRESHOLD = 0.55;
const SPEAKER_HOLD_MS = 1200;
const SWITCH_COOLDOWN_MS = 2500;

export const DEFAULT_ACTIVE_SPEAKER_STATE: ActiveSpeakerState = {
	heroParticipantId: null,
	candidateParticipantId: null,
	candidateSinceMs: null,
	lastSwitchAtMs: null
};

function compareStrings(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

function uniqueSorted(values: string[]): string[] {
	return Array.from(new Set(values)).sort(compareStrings);
}

function toVideoTileId(participantId: string): string {
	return `video:${participantId}`;
}

function toAvatarTileId(participantId: string): string {
	return `avatar:${participantId}`;
}

function toShareTileId(shareId: string): string {
	return `share:${shareId}`;
}

function participantIdFromTileId(tileId: string): string | null {
	if (tileId.startsWith('video:')) return tileId.slice(6);
	if (tileId.startsWith('avatar:')) return tileId.slice(7);
	return null;
}

function normalizePins(pins: string[], knownTileIds: Set<string>): string[] {
	const unique: string[] = [];
	for (const pin of pins) {
		if (unique.length >= 2) break;
		if (!knownTileIds.has(pin)) continue;
		if (unique.includes(pin)) continue;
		unique.push(pin);
	}
	return unique;
}

function sortSpeakerCandidates(
	participants: string[],
	levels: Record<string, number>
): string[] {
	return [...participants]
		.filter((participantId) => (levels[participantId] ?? 0) >= AUDIO_THRESHOLD)
		.sort((a, b) => {
			const levelDelta = (levels[b] ?? 0) - (levels[a] ?? 0);
			if (levelDelta !== 0) return levelDelta;
			return compareStrings(a, b);
		});
}

function resolveActiveSpeakerHero(
	videoParticipantIds: string[],
	activeSpeakerLevels: Record<string, number>,
	previous: ActiveSpeakerState,
	nowMs: number
): { heroParticipantId: string | null; nextState: ActiveSpeakerState } {
	const validVideoSet = new Set(videoParticipantIds);
	const baseState: ActiveSpeakerState = {
		heroParticipantId:
			previous.heroParticipantId && validVideoSet.has(previous.heroParticipantId)
				? previous.heroParticipantId
				: null,
		candidateParticipantId:
			previous.candidateParticipantId && validVideoSet.has(previous.candidateParticipantId)
				? previous.candidateParticipantId
				: null,
		candidateSinceMs:
			previous.candidateParticipantId && validVideoSet.has(previous.candidateParticipantId)
				? previous.candidateSinceMs
				: null,
		lastSwitchAtMs: previous.lastSwitchAtMs
	};

	const speakerCandidates = sortSpeakerCandidates(videoParticipantIds, activeSpeakerLevels);
	const strongestSpeaker = speakerCandidates[0] ?? null;
	if (!strongestSpeaker) {
		return {
			heroParticipantId: baseState.heroParticipantId,
			nextState: {
				...baseState,
				candidateParticipantId: null,
				candidateSinceMs: null
			}
		};
	}

	if (baseState.heroParticipantId === strongestSpeaker) {
		return {
			heroParticipantId: baseState.heroParticipantId,
			nextState: {
				...baseState,
				candidateParticipantId: null,
				candidateSinceMs: null
			}
		};
	}

	const candidateId =
		baseState.candidateParticipantId === strongestSpeaker
			? baseState.candidateParticipantId
			: strongestSpeaker;
	const candidateSince =
		baseState.candidateParticipantId === strongestSpeaker
			? baseState.candidateSinceMs
			: nowMs;

	const holdElapsed = candidateSince !== null && nowMs - candidateSince >= SPEAKER_HOLD_MS;
	const cooldownElapsed =
		baseState.lastSwitchAtMs === null || nowMs - baseState.lastSwitchAtMs >= SWITCH_COOLDOWN_MS;

	if (holdElapsed && cooldownElapsed) {
		return {
			heroParticipantId: strongestSpeaker,
			nextState: {
				heroParticipantId: strongestSpeaker,
				candidateParticipantId: null,
				candidateSinceMs: null,
				lastSwitchAtMs: nowMs
			}
		};
	}

	return {
		heroParticipantId: baseState.heroParticipantId,
		nextState: {
			...baseState,
			candidateParticipantId: candidateId,
			candidateSinceMs: candidateSince
		}
	};
}

function orderTiles(tileIds: string[], pins: string[]): string[] {
	const pinRank = new Map<string, number>();
	pins.forEach((pin, index) => pinRank.set(pin, index));
	return [...tileIds].sort((a, b) => {
		const aRank = pinRank.has(a) ? pinRank.get(a)! : Number.POSITIVE_INFINITY;
		const bRank = pinRank.has(b) ? pinRank.get(b)! : Number.POSITIVE_INFINITY;
		if (aRank !== bRank) return aRank - bRank;
		return compareStrings(a, b);
	});
}

function composeOrderedLayout(tileIds: string[], heroIds: string[]): { tileIds: string[]; secondaryIds: string[] } {
	const heroSet = new Set(heroIds);
	const secondaryIds = tileIds.filter((tileId) => !heroSet.has(tileId));
	return {
		tileIds: [...heroIds, ...secondaryIds],
		secondaryIds
	};
}

function fillToTwoHeroIds(primary: string[], pool: string[]): string[] {
	const heroes = [...primary];
	for (const candidate of pool) {
		if (heroes.length >= 2) break;
		if (!heroes.includes(candidate)) heroes.push(candidate);
	}
	return heroes.slice(0, 2);
}

export function computeCallLayout(input: CallLayoutInput): CallLayoutResult {
	const participants = [...input.participants].sort((a, b) => compareStrings(a.id, b.id));
	const shares = [...input.shares].sort((a, b) => compareStrings(a.id, b.id));
	const videoParticipantIds = uniqueSorted(participants.filter((p) => p.hasVideo).map((p) => p.id));
	const hasShares = shares.length > 0;
	const nowMs = input.nowMs;
	const previousSpeakerState = input.activeSpeakerState ?? DEFAULT_ACTIVE_SPEAKER_STATE;

	const shareTileIds = shares.map((share) => toShareTileId(share.id));
	const videoTileIds = videoParticipantIds.map((participantId) => toVideoTileId(participantId));
	const allMediaTileIds = [...shareTileIds, ...videoTileIds];
	const avatarTileIds = participants.map((participant) => toAvatarTileId(participant.id));
	const nonVideoAvatarTileIds = participants
		.filter((participant) => !participant.hasVideo)
		.map((participant) => toAvatarTileId(participant.id));

	// Keep non-video participants visible as avatar tiles even when media tiles are present.
	const sourceTileIds = allMediaTileIds.length > 0
		? [...allMediaTileIds, ...nonVideoAvatarTileIds]
		: avatarTileIds;
	const knownTiles = new Set(sourceTileIds);
	const pinnedTileIds = normalizePins(input.pins, knownTiles);
	const orderedTileIds = orderTiles(sourceTileIds, pinnedTileIds);

	const speakerResolution = resolveActiveSpeakerHero(
		videoParticipantIds,
		input.activeSpeakerLevels,
		previousSpeakerState,
		nowMs
	);
	const hasSpeakerSignal = sortSpeakerCandidates(videoParticipantIds, input.activeSpeakerLevels).length > 0;
	const speakerHeroTileId = speakerResolution.heroParticipantId
		? toVideoTileId(speakerResolution.heroParticipantId)
		: null;

	if (allMediaTileIds.length === 0) {
		const ordered = composeOrderedLayout(orderedTileIds, []);
		return {
			template: 'floating-bubbles',
			tileIds: ordered.tileIds,
			heroIds: [],
			secondaryIds: ordered.secondaryIds,
			pinnedTileIds,
			nextActiveSpeakerState: speakerResolution.nextState
		};
	}

	if (hasShares) {
		const defaultHero = orderedTileIds.find((tileId) => tileId.startsWith('share:')) ?? orderedTileIds[0] ?? null;
		const heroIds = pinnedTileIds.length > 0 ? pinnedTileIds.slice(0, 2) : (defaultHero ? [defaultHero] : []);
		const ordered = composeOrderedLayout(orderedTileIds, heroIds);
		return {
			template: 'screen-hero',
			tileIds: ordered.tileIds,
			heroIds,
			secondaryIds: ordered.secondaryIds,
			pinnedTileIds,
			nextActiveSpeakerState: speakerResolution.nextState
		};
	}

	const videoCount = videoTileIds.length;
	if (videoCount === 1) {
		const defaultHero = videoTileIds[0];
		const heroIds = pinnedTileIds.length > 0 ? pinnedTileIds.slice(0, 2) : [defaultHero];
		const ordered = composeOrderedLayout(orderedTileIds, heroIds);
		return {
			template: 'single-hero',
			tileIds: ordered.tileIds,
			heroIds,
			secondaryIds: ordered.secondaryIds,
			pinnedTileIds,
			nextActiveSpeakerState: speakerResolution.nextState
		};
	}

	if (videoCount === 2) {
		// In 1:1 (local + one remote), favor a centered hero instead of left/right split.
		if (videoTileIds.includes('video:local')) {
			const remoteHero =
				(speakerHeroTileId && speakerHeroTileId !== 'video:local'
					? speakerHeroTileId
					: videoTileIds.find((tileId) => tileId !== 'video:local')) ?? videoTileIds[0];
			const heroIds = pinnedTileIds.length > 0 ? pinnedTileIds.slice(0, 1) : [remoteHero];
			const ordered = composeOrderedLayout(orderedTileIds, heroIds);
			return {
				template: 'single-hero',
				tileIds: ordered.tileIds,
				heroIds,
				secondaryIds: ordered.secondaryIds,
				pinnedTileIds,
				nextActiveSpeakerState: speakerResolution.nextState
			};
		}
		const ordered = composeOrderedLayout(orderedTileIds, []);
		return {
			template: 'split',
			tileIds: ordered.tileIds,
			heroIds: [],
			secondaryIds: ordered.secondaryIds,
			pinnedTileIds,
			nextActiveSpeakerState: speakerResolution.nextState
		};
	}

	if (videoCount === 3) {
		const fallbackHero = orderedTileIds[0];
		const heroIds = pinnedTileIds.length > 0
			? pinnedTileIds.slice(0, 1)
			: speakerHeroTileId
				? [speakerHeroTileId]
				: [fallbackHero];
		const ordered = composeOrderedLayout(orderedTileIds, heroIds);
		return {
			template: 'hero-stack',
			tileIds: ordered.tileIds,
			heroIds,
			secondaryIds: ordered.secondaryIds,
			pinnedTileIds,
			nextActiveSpeakerState: speakerResolution.nextState
		};
	}

	if (videoCount === 4) {
		const ordered = composeOrderedLayout(orderedTileIds, []);
		return {
			template: 'grid-2x2',
			tileIds: ordered.tileIds,
			heroIds: [],
			secondaryIds: ordered.secondaryIds,
			pinnedTileIds,
			nextActiveSpeakerState: speakerResolution.nextState
		};
	}

	if (videoCount === 5) {
		if (pinnedTileIds.length > 0) {
			const heroIds = fillToTwoHeroIds(pinnedTileIds, orderedTileIds);
			const ordered = composeOrderedLayout(orderedTileIds, heroIds);
			return {
				template: 'double-hero-triple',
				tileIds: ordered.tileIds,
				heroIds,
				secondaryIds: ordered.secondaryIds,
				pinnedTileIds,
				nextActiveSpeakerState: speakerResolution.nextState
			};
		}
		if (speakerHeroTileId && hasSpeakerSignal) {
			const heroIds = fillToTwoHeroIds([speakerHeroTileId], orderedTileIds);
			const ordered = composeOrderedLayout(orderedTileIds, heroIds);
			return {
				template: 'double-hero-triple',
				tileIds: ordered.tileIds,
				heroIds,
				secondaryIds: ordered.secondaryIds,
				pinnedTileIds,
				nextActiveSpeakerState: speakerResolution.nextState
			};
		}
		const ordered = composeOrderedLayout(orderedTileIds, []);
		return {
			template: 'uniform-grid',
			tileIds: ordered.tileIds,
			heroIds: [],
			secondaryIds: ordered.secondaryIds,
			pinnedTileIds,
			nextActiveSpeakerState: speakerResolution.nextState
		};
	}

	if (videoCount >= 10) {
		const ordered = composeOrderedLayout(orderedTileIds, []);
		return {
			template: 'scroll-grid',
			tileIds: ordered.tileIds,
			heroIds: [],
			secondaryIds: ordered.secondaryIds,
			pinnedTileIds,
			nextActiveSpeakerState: speakerResolution.nextState
		};
	}

	const ordered = composeOrderedLayout(orderedTileIds, []);
	return {
		template: 'uniform-grid',
		tileIds: ordered.tileIds,
		heroIds: [],
		secondaryIds: ordered.secondaryIds,
		pinnedTileIds,
		nextActiveSpeakerState: speakerResolution.nextState
	};
}

export function tileOwnerParticipantId(tileId: string): string {
	if (tileId.startsWith('share:')) return tileId.slice(6);
	const participantId = participantIdFromTileId(tileId);
	return participantId ?? tileId;
}
