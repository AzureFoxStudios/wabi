import type { UploadRoleTier } from '../../../shared/runtimeAdminContracts.js';

export interface AlbumUploadLimitConfig {
	perRoleItemsPerMinute: Record<UploadRoleTier, number>;
	perRoleMaxBytesPerItem: Record<UploadRoleTier, number | null>;
	perScopeItemsPerMinute: number;
}

const MB = 1024 * 1024;
const ALBUM_POLICY_TIERS: UploadRoleTier[] = ['new', 'trusted', 'moderator', 'admin', 'owner'];

export const DEFAULT_ALBUM_UPLOAD_LIMIT_CONFIG: AlbumUploadLimitConfig = {
	perRoleItemsPerMinute: {
		new: 6,
		trusted: 24,
		moderator: 90,
		admin: 180,
		owner: 240
	},
	perRoleMaxBytesPerItem: {
		new: 25 * MB,
		trusted: 300 * MB,
		moderator: 1024 * MB,
		admin: null,
		owner: null
	},
	perScopeItemsPerMinute: 420
};

function normalizeCountLimit(input: unknown, fallback: number, min: number, max: number): number {
	const parsed = Number(input);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function normalizeByteLimit(input: unknown, fallback: number | null): number | null {
	if (input === null || input === undefined || input === '') return fallback;
	const parsed = Number(input);
	if (!Number.isFinite(parsed) || parsed <= 0) return null;
	return Math.floor(parsed);
}

export function cloneDefaultAlbumUploadLimits(): AlbumUploadLimitConfig {
	return {
		perRoleItemsPerMinute: { ...DEFAULT_ALBUM_UPLOAD_LIMIT_CONFIG.perRoleItemsPerMinute },
		perRoleMaxBytesPerItem: { ...DEFAULT_ALBUM_UPLOAD_LIMIT_CONFIG.perRoleMaxBytesPerItem },
		perScopeItemsPerMinute: DEFAULT_ALBUM_UPLOAD_LIMIT_CONFIG.perScopeItemsPerMinute
	};
}

export function sanitizeAlbumUploadLimitConfig(rawConfig: unknown): AlbumUploadLimitConfig {
	if (!rawConfig || typeof rawConfig !== 'object') {
		return cloneDefaultAlbumUploadLimits();
	}

	const input = rawConfig as Partial<AlbumUploadLimitConfig>;
	const policy = cloneDefaultAlbumUploadLimits();
	const perRoleRates = input.perRoleItemsPerMinute as Partial<Record<UploadRoleTier, unknown>> | undefined;
	const perRoleMaxBytes = input.perRoleMaxBytesPerItem as Partial<Record<UploadRoleTier, unknown>> | undefined;

	for (const tier of ALBUM_POLICY_TIERS) {
		if (perRoleRates && Object.prototype.hasOwnProperty.call(perRoleRates, tier)) {
			policy.perRoleItemsPerMinute[tier] = normalizeCountLimit(
				perRoleRates[tier],
				policy.perRoleItemsPerMinute[tier],
				1,
				5000
			);
		}
		if (perRoleMaxBytes && Object.prototype.hasOwnProperty.call(perRoleMaxBytes, tier)) {
			policy.perRoleMaxBytesPerItem[tier] = normalizeByteLimit(
				perRoleMaxBytes[tier],
				policy.perRoleMaxBytesPerItem[tier]
			);
		}
	}

	policy.perScopeItemsPerMinute = normalizeCountLimit(
		input.perScopeItemsPerMinute,
		policy.perScopeItemsPerMinute,
		1,
		20000
	);

	return policy;
}
