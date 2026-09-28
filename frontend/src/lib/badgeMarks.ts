import type { FrontendAppMetadataPolicy } from '$lib/api';

export const DEFAULT_OWNER_BADGE_MARK = '👑';
export const DEFAULT_STAFF_BADGE_MARK = '💎';

export function ownerBadgeMark(metadata?: FrontendAppMetadataPolicy | null): string {
	return usableMark(metadata?.ownerBadgeMark, DEFAULT_OWNER_BADGE_MARK);
}

export function staffBadgeMark(metadata?: FrontendAppMetadataPolicy | null): string {
	return usableMark(metadata?.staffBadgeMark, DEFAULT_STAFF_BADGE_MARK);
}

function usableMark(value: string | null | undefined, fallback: string): string {
	const mark = value?.trim();
	return mark ? mark.slice(0, 16) : fallback;
}
