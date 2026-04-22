import { appPolicyRepository } from './db/repositories/appPolicyRepository.js';
import type { CommunityNodeAnnouncementsPolicy } from '../../shared/adminPolicyContracts.js';

export type { CommunityNodeAnnouncementsPolicy } from '../../shared/adminPolicyContracts.js';

export interface CommunityNodeAnnouncementContext {
	nodeName: string;
	ownerUsername?: string | null;
	mode?: string | null;
	status: 'online' | 'offline';
}

const COMMUNITY_NODE_ANNOUNCEMENTS_POLICY_KEY = 'policy:community_node_announcements';

const DEFAULT_COMMUNITY_NODE_ANNOUNCEMENTS_POLICY: CommunityNodeAnnouncementsPolicy = {
	enabled: false,
	channelId: null,
	onlineTemplate: '[{node}] is now online and helping this server. Thank you, {user}.',
	offlineTemplate: '[{node}] went offline.'
};

type AnnouncementDispatcher = (payload: { channelId: string; text: string }) => Promise<void> | void;

let dispatcher: AnnouncementDispatcher | null = null;

function normalizeTemplate(value: unknown, fallback: string): string {
	if (typeof value !== 'string') return fallback;
	const trimmed = value.trim();
	return trimmed ? trimmed.slice(0, 280) : fallback;
}

export function sanitizeCommunityNodeAnnouncementsPolicy(raw: unknown): CommunityNodeAnnouncementsPolicy {
	const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
	const channelId =
		typeof input.channelId === 'string' && input.channelId.trim() ? input.channelId.trim().slice(0, 120) : null;
	return {
		enabled: input.enabled === true,
		channelId,
		onlineTemplate: normalizeTemplate(
			input.onlineTemplate,
			DEFAULT_COMMUNITY_NODE_ANNOUNCEMENTS_POLICY.onlineTemplate
		),
		offlineTemplate: normalizeTemplate(
			input.offlineTemplate,
			DEFAULT_COMMUNITY_NODE_ANNOUNCEMENTS_POLICY.offlineTemplate
		)
	};
}

export function cloneDefaultCommunityNodeAnnouncementsPolicy(): CommunityNodeAnnouncementsPolicy {
	return { ...DEFAULT_COMMUNITY_NODE_ANNOUNCEMENTS_POLICY };
}

export function getCommunityNodeAnnouncementsPolicy(): CommunityNodeAnnouncementsPolicy {
	const raw = appPolicyRepository.getRaw(COMMUNITY_NODE_ANNOUNCEMENTS_POLICY_KEY);
	if (!raw) return cloneDefaultCommunityNodeAnnouncementsPolicy();
	try {
		return sanitizeCommunityNodeAnnouncementsPolicy(JSON.parse(raw));
	} catch {
		return cloneDefaultCommunityNodeAnnouncementsPolicy();
	}
}

export function registerCommunityNodeAnnouncementDispatcher(next: AnnouncementDispatcher): void {
	dispatcher = next;
}

function humanizeMode(mode: string | null | undefined): string {
	if (mode === 'files-only') return 'Files Only';
	if (mode === 'desktop-assist') return 'Desktop Assist';
	return 'Unknown';
}

function renderTemplate(template: string, context: CommunityNodeAnnouncementContext): string {
	return template
		.replace(/\{node\}/g, context.nodeName)
		.replace(/\{user\}/g, context.ownerUsername || 'a community member')
		.replace(/\{mode\}/g, humanizeMode(context.mode))
		.replace(/\{status\}/g, context.status);
}

export async function announceCommunityNodeStatusChange(
	context: CommunityNodeAnnouncementContext
): Promise<void> {
	if (!dispatcher) return;
	const policy = getCommunityNodeAnnouncementsPolicy();
	if (!policy.enabled || !policy.channelId) return;
	const template = context.status === 'online' ? policy.onlineTemplate : policy.offlineTemplate;
	const text = renderTemplate(template, context).trim();
	if (!text) return;
	try {
		await dispatcher({ channelId: policy.channelId, text });
	} catch (error) {
		console.error('[CommunityNodes] Failed to dispatch node announcement:', error);
	}
}
