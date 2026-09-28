import type { FieldCheckin, FieldParticipant } from '$lib/api/field';

export function parseManualPin(xInput: string, yInput: string): { x: number; y: number } | null {
	if (!xInput.trim() || !yInput.trim()) return null;
	const x = Number(xInput);
	const y = Number(yInput);
	if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 100 || y < 0 || y > 100) return null;
	return { x: Number((x / 100).toFixed(4)), y: Number((y / 100).toFixed(4)) };
}

export function hasPartialManualPin(xInput: string, yInput: string): boolean {
	return Boolean(xInput.trim()) !== Boolean(yInput.trim());
}

export function fieldAge(timestamp: number | null | undefined, now: number): string {
	if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) return 'unknown age';
	const elapsed = Math.max(0, now - timestamp);
	if (elapsed < 60_000) return 'less than a minute ago';
	const minutes = Math.floor(elapsed / 60_000);
	if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
	const days = Math.floor(hours / 24);
	return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function needsLeaderAcknowledgement(checkin: FieldCheckin | null): boolean {
	return checkin?.status === 'help' && checkin.acknowledgedAt == null;
}

export function openHelp(participant: FieldParticipant): FieldCheckin | null {
	return participant.pendingHelp && needsLeaderAcknowledgement(participant.pendingHelp)
		? participant.pendingHelp
		: null;
}

export function markerPosition(participant: FieldParticipant): { x: number; y: number } | null {
	const position = participant.lastPosition;
	if (!participant.consented || !position) return null;
	const { x, y } = position;
	if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
	return { x, y };
}
