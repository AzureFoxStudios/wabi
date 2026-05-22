import type { ActiveSpeakerState } from '$lib/callLayoutManager';

export function sanitizePinnedIds(pinned: string[], tiles: Map<string, unknown>): string[] {
	const next: string[] = [];
	for (const tileId of pinned) {
		if (next.length >= 2) break;
		if (!tiles.has(tileId)) continue;
		if (next.includes(tileId)) continue;
		next.push(tileId);
	}
	return next;
}

export function isSameIdList(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

export function isSameSpeakerState(a: ActiveSpeakerState, b: ActiveSpeakerState): boolean {
	return (
		a.heroParticipantId === b.heroParticipantId &&
		a.candidateParticipantId === b.candidateParticipantId &&
		a.candidateSinceMs === b.candidateSinceMs &&
		a.lastSwitchAtMs === b.lastSwitchAtMs
	);
}

export function hashString(value: string): number {
	let hash = 0;
	for (let i = 0; i < value.length; i += 1) {
		hash = value.charCodeAt(i) + ((hash << 5) - hash);
	}
	return Math.abs(hash);
}

export function formatRecordingElapsed(elapsedMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) {
		return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
	}
	return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

export function formatRecordingPresenceCopy(
	participants: Array<{ userId: string; username?: string }>,
	selfStableId: string | null
): string {
	if (participants.length === 0) return '';
	const labels = participants.map((participant) =>
		selfStableId && participant.userId === selfStableId ? 'You' : (participant.username || participant.userId)
	);
	if (labels.length === 1) {
		return `${labels[0]} ${labels[0] === 'You' ? 'are' : 'is'} recording. Everyone in this call can see it.`;
	}
	if (labels.length === 2) {
		return `${labels[0]} and ${labels[1]} are recording.`;
	}
	return `${labels[0]}, ${labels[1]}, and ${labels.length - 2} more are recording.`;
}
