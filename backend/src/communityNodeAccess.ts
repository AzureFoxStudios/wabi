import { appPolicyRepository } from './db/repositories/appPolicyRepository.js';
import { stateUserStore } from './state-plane/index.js';
import type {
	CommunityNodeAccessMode,
	CommunityNodeAllowedUser,
	CommunityNodeAccessPolicy
} from '../../shared/adminPolicyContracts.js';

export type {
	CommunityNodeAccessMode,
	CommunityNodeAllowedUser,
	CommunityNodeAccessPolicy
} from '../../shared/adminPolicyContracts.js';

const COMMUNITY_NODE_ACCESS_POLICY_KEY = 'policy:community_node_access';

const DEFAULT_COMMUNITY_NODE_ACCESS_POLICY: CommunityNodeAccessPolicy = {
	mode: 'open',
	allowedUsers: []
};

function normalizeMode(value: unknown): CommunityNodeAccessMode {
	return value === 'approval_required' || value === 'whitelist_only' ? value : 'open';
}

function resolveAllowedUser(value: unknown): CommunityNodeAllowedUser | null {
	if (typeof value === 'number' && Number.isFinite(value)) {
		const user = stateUserStore.findById(Math.floor(value));
		return user?.user_id && user.username ? { userId: user.user_id, username: user.username } : null;
	}
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (!trimmed) return null;
		const numeric = Number(trimmed);
		if (Number.isFinite(numeric)) {
			const user = stateUserStore.findById(Math.floor(numeric));
			return user?.user_id && user.username ? { userId: user.user_id, username: user.username } : null;
		}
		const user = stateUserStore.findByUsername(trimmed);
		return user?.user_id && user.username ? { userId: user.user_id, username: user.username } : null;
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const input = value as Record<string, unknown>;
	const maybeUsername = typeof input.username === 'string' ? input.username.trim() : '';
	const maybeUserId =
		typeof input.userId === 'number'
			? Math.floor(input.userId)
			: typeof input.userId === 'string'
				? Math.floor(Number(input.userId))
				: NaN;
	if (Number.isFinite(maybeUserId) && maybeUserId > 0) {
		const user = stateUserStore.findById(maybeUserId);
		return user?.user_id && user.username ? { userId: user.user_id, username: user.username } : null;
	}
	if (maybeUsername) {
		const user = stateUserStore.findByUsername(maybeUsername);
		return user?.user_id && user.username ? { userId: user.user_id, username: user.username } : null;
	}
	return null;
}

export function sanitizeCommunityNodeAccessPolicy(raw: unknown): CommunityNodeAccessPolicy {
	const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
	const allowedUsersRaw = Array.isArray(input.allowedUsers) ? input.allowedUsers : [];
	const deduped = new Map<number, CommunityNodeAllowedUser>();
	for (const entry of allowedUsersRaw) {
		const resolved = resolveAllowedUser(entry);
		if (!resolved) continue;
		deduped.set(resolved.userId, resolved);
	}
	return {
		mode: normalizeMode(input.mode),
		allowedUsers: Array.from(deduped.values()).sort((a, b) => a.username.localeCompare(b.username))
	};
}

export function cloneDefaultCommunityNodeAccessPolicy(): CommunityNodeAccessPolicy {
	return {
		mode: DEFAULT_COMMUNITY_NODE_ACCESS_POLICY.mode,
		allowedUsers: []
	};
}

export function getCommunityNodeAccessPolicy(): CommunityNodeAccessPolicy {
	const raw = appPolicyRepository.getRaw(COMMUNITY_NODE_ACCESS_POLICY_KEY);
	if (!raw) return cloneDefaultCommunityNodeAccessPolicy();
	try {
		return sanitizeCommunityNodeAccessPolicy(JSON.parse(raw));
	} catch {
		return cloneDefaultCommunityNodeAccessPolicy();
	}
}
