import { IncomingMessage, ServerResponse } from 'http';
import { DEFAULT_WORKSPACE_ID } from '../constants.js';
import { getUserRoles } from '../auth/roleMiddleware.js';
import { getRolePriority } from '../db/repositories/roleRepository.js';
import { UPLOADS_DIR } from '../constants.js';
import { existsSync, unlinkSync } from 'fs';
import { basename, resolve, sep } from 'path';
import {
	stateChannelStore as channelRepository,
	stateChannelMemberStore as channelMemberRepository
} from '../state-plane/index.js';
import { albumRepository, type AlbumScopeType, type DbAlbumItem, type DbAlbumWithCounts } from '../db/repositories/albumRepository.js';
import {
	sanitizeAlbumUploadLimitConfig,
	type AlbumUploadLimitConfig
} from '../services/albumUploadLimits.js';
import {
	isInvalidJsonBodyError as isInvalidJsonError,
	isRequestBodyTooLargeError as isPayloadTooLargeError,
	readJsonObjectBody
} from '../utils/requestBodies.js';

const ALBUM_UPLOAD_RATE_WINDOW_MS = 60_000;
const MAX_ALBUM_BODY_BYTES = Math.max(
	1024,
	Math.min(1024 * 1024, Number(process.env.ALBUM_MAX_BODY_BYTES || 64 * 1024))
);

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	return await readJsonObjectBody(req, MAX_ALBUM_BODY_BYTES);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(payload));
}

function parseAlbumId(rawAlbumId: string): number | null {
	const parsed = Number(rawAlbumId);
	if (!Number.isInteger(parsed) || parsed <= 0) return null;
	return parsed;
}

function parseAlbumItemId(rawItemId: string): number | null {
	const parsed = Number(rawItemId);
	if (!Number.isInteger(parsed) || parsed <= 0) return null;
	return parsed;
}

function sanitizeScopeType(input: unknown): AlbumScopeType | null {
	if (input === 'channel' || input === 'dm') return input;
	return null;
}

function sanitizeScopeId(input: unknown): string {
	if (typeof input !== 'string') return '';
	return input.trim();
}

function sanitizeName(input: unknown): string {
	if (typeof input !== 'string') return '';
	return input.trim();
}

function sanitizeAttachmentUrl(input: unknown): string {
	if (typeof input !== 'string') return '';
	return input.trim();
}

function normalizeUploadFileIdFromUrl(fileUrl: string | undefined): string | null {
	if (typeof fileUrl !== 'string' || !fileUrl.startsWith('/uploads/')) return null;
	const raw = fileUrl.slice('/uploads/'.length);
	if (!raw) return null;

	let decoded = raw;
	try {
		decoded = decodeURIComponent(raw);
	} catch {
		return null;
	}

	const normalized = decoded.replace(/\\/g, '/');
	if (normalized.includes('/')) return null;
	const fileId = basename(normalized);
	if (!fileId || fileId === '.' || fileId === '..') return null;
	return fileId;
}

function resolveUploadPath(fileId: string): string | null {
	const uploadsRoot = resolve(UPLOADS_DIR);
	const candidate = resolve(uploadsRoot, basename(fileId));
	if (candidate !== uploadsRoot && !candidate.startsWith(`${uploadsRoot}${sep}`)) {
		return null;
	}
	return candidate;
}

function canHardDeleteAttachmentUrl(fileUrl: string | undefined): boolean {
	return normalizeUploadFileIdFromUrl(fileUrl) !== null;
}

function deleteUploadFileByUrl(fileUrl: string | undefined): boolean {
	const fileId = normalizeUploadFileIdFromUrl(fileUrl);
	if (!fileId) return false;
	const filePath = resolveUploadPath(fileId);
	if (!filePath) return false;

	try {
		if (existsSync(filePath)) unlinkSync(filePath);
		return true;
	} catch (error) {
		console.error(`[Albums] Failed to delete upload file (${fileId}):`, error);
		return false;
	}
}

function sanitizeAttachmentName(input: unknown): string {
	if (typeof input !== 'string') return '';
	return input.trim();
}

function sanitizeOptionalString(input: unknown, maxLen: number): string | null {
	if (typeof input !== 'string') return null;
	const trimmed = input.trim();
	if (!trimmed) return null;
	return trimmed.slice(0, maxLen);
}

function sanitizeOptionalSize(input: unknown): number | null {
	if (input === undefined || input === null || input === '') return null;
	const parsed = Number(input);
	if (!Number.isFinite(parsed) || parsed < 0) return null;
	return Math.floor(parsed);
}

function sanitizeFeaturedFlag(input: unknown): boolean | null {
	if (typeof input === 'boolean') return input;
	if (input === 'true') return true;
	if (input === 'false') return false;
	return null;
}

function sanitizeItemIdList(input: unknown): number[] {
	if (!Array.isArray(input)) return [];
	return input
		.map((value) => Number(value))
		.filter((value) => Number.isInteger(value) && value > 0)
		.map((value) => Math.floor(value));
}

function normalizeLimit(input: unknown, defaultValue: number, min: number, max: number): number {
	const parsed = Number(input);
	if (!Number.isFinite(parsed)) return defaultValue;
	return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function getHighestRoleForUser(userId: number): string {
	const roles = getUserRoles(userId, DEFAULT_WORKSPACE_ID);
	if (roles.length === 0) return 'member';

	let highestRole = 'member';
	let highestPriority = getRolePriority(highestRole, DEFAULT_WORKSPACE_ID);

	for (const role of roles) {
		const rolePriority = getRolePriority(role, DEFAULT_WORKSPACE_ID);
		if (rolePriority > highestPriority) {
			highestRole = role;
			highestPriority = rolePriority;
		}
	}

	return highestRole;
}

function userCanModerateAlbums(userId: number): boolean {
	const roles = getUserRoles(userId, DEFAULT_WORKSPACE_ID);
	return roles.includes('owner') || roles.includes('admin') || roles.includes('mod');
}

function resolveAlbumPolicyTier(userId: number): AlbumPolicyTier {
	const roles = getUserRoles(userId, DEFAULT_WORKSPACE_ID);
	if (roles.includes('owner')) return 'owner';
	if (roles.includes('admin')) return 'admin';
	if (roles.includes('mod')) return 'moderator';
	return 'trusted';
}

function userCanAccessScope(
	userId: number,
	scopeType: AlbumScopeType,
	scopeId: string
): { allowed: true } | { allowed: false; status: number; error: string } {
	const channel = channelRepository.findById(scopeId);
	if (!channel) {
		return { allowed: false, status: 404, error: 'Scope channel not found' };
	}

	const isDmLike = channel.channel_type === 'dm' || channel.channel_type === 'group';
	if (scopeType === 'dm' && !isDmLike) {
		return { allowed: false, status: 400, error: 'scopeType dm requires a DM/group channel' };
	}
	if (scopeType === 'channel' && isDmLike) {
		return { allowed: false, status: 400, error: 'scopeType channel cannot target a DM/group channel' };
	}

	if (isDmLike) {
		const stableUserId = `user-${userId}`;
		if (!channelMemberRepository.isMember(scopeId, stableUserId)) {
			return { allowed: false, status: 403, error: 'Not a member of this DM/group scope' };
		}
		return { allowed: true };
	}

	const requiredRole = channel.min_role || 'guest';
	const userRole = getHighestRoleForUser(userId);
	const userPriority = getRolePriority(userRole, DEFAULT_WORKSPACE_ID);
	const requiredPriority = getRolePriority(requiredRole, DEFAULT_WORKSPACE_ID);

	if (userPriority < requiredPriority) {
		return { allowed: false, status: 403, error: 'Insufficient role for this channel scope' };
	}

	return { allowed: true };
}

function toClientAlbum(album: DbAlbumWithCounts) {
	return {
		id: album.id,
		scopeType: album.scope_type,
		scopeId: album.scope_id,
		name: album.name,
		createdBy: album.created_by,
		createdAt: album.created_at,
		updatedAt: album.updated_at,
		isFeatured: album.is_featured === 1,
		itemCount: album.item_count
	};
}

function toClientAlbumItem(item: DbAlbumItem) {
	return {
		id: item.id,
		albumId: item.album_id,
		attachmentUrl: item.attachment_url,
		attachmentName: item.attachment_name,
		attachmentSize: item.attachment_size ?? null,
		attachmentMime: item.attachment_mime ?? null,
		messageId: item.message_id ?? null,
		caption: item.caption ?? null,
		sortOrder: item.sort_order,
		uploadedBy: item.uploaded_by,
		uploadedAt: item.uploaded_at
	};
}

export async function handleListAlbums(
	_req: IncomingMessage,
	res: ServerResponse,
	url: URL,
	userId: number
): Promise<void> {
	try {
		const scopeType = sanitizeScopeType(url.searchParams.get('scopeType'));
		const scopeId = sanitizeScopeId(url.searchParams.get('scopeId'));
		if (!scopeType || !scopeId) {
			sendJson(res, 400, { error: 'scopeType and scopeId are required' });
			return;
		}

		const access = userCanAccessScope(userId, scopeType, scopeId);
		if (!access.allowed) {
			sendJson(res, access.status, { error: access.error });
			return;
		}

		const limit = normalizeLimit(url.searchParams.get('limit'), 100, 1, 500);
		const albums = albumRepository.listByScope(scopeType, scopeId, limit).map(toClientAlbum);
		sendJson(res, 200, { albums });
	} catch (error) {
		console.error('[Albums] Failed to list albums:', error);
		sendJson(res, 500, { error: 'Failed to list albums' });
	}
}

export async function handleCreateAlbum(
	req: IncomingMessage,
	res: ServerResponse,
	userId: number
): Promise<void> {
	try {
		const body = await readJsonBody(req);
		const scopeType = sanitizeScopeType(body?.scopeType);
		const scopeId = sanitizeScopeId(body?.scopeId);
		const name = sanitizeName(body?.name);

		if (!scopeType || !scopeId || !name) {
			sendJson(res, 400, { error: 'scopeType, scopeId, and name are required' });
			return;
		}
		if (name.length > 80) {
			sendJson(res, 400, { error: 'Album name too long (max 80 chars)' });
			return;
		}

		const access = userCanAccessScope(userId, scopeType, scopeId);
		if (!access.allowed) {
			sendJson(res, access.status, { error: access.error });
			return;
		}

		const existing = albumRepository
			.listByScope(scopeType, scopeId, 500)
			.find((album) => album.name.toLowerCase() === name.toLowerCase());
		if (existing) {
			sendJson(res, 409, { error: 'An album with that name already exists in this scope' });
			return;
		}

		const now = Date.now();
		const created = albumRepository.create({
			scope_type: scopeType,
			scope_id: scopeId,
			name,
			created_by: userId,
			created_at: now
		});

		const hydrated = albumRepository.findById(created.id as number);
		if (!hydrated) {
			sendJson(res, 500, { error: 'Album was created but could not be loaded' });
			return;
		}

		sendJson(res, 201, { album: toClientAlbum(hydrated) });
	} catch (error) {
		if (isPayloadTooLargeError(error)) {
			sendJson(res, 413, { error: 'Album payload too large' });
			return;
		}
		if (isInvalidJsonError(error)) {
			sendJson(res, 400, { error: 'Invalid album payload' });
			return;
		}
		console.error('[Albums] Failed to create album:', error);
		sendJson(res, 400, { error: 'Invalid album payload' });
	}
}

export async function handleListAlbumItems(
	_req: IncomingMessage,
	res: ServerResponse,
	url: URL,
	userId: number,
	rawAlbumId: string
): Promise<void> {
	try {
		const albumId = parseAlbumId(rawAlbumId);
		if (!albumId) {
			sendJson(res, 400, { error: 'Invalid album id' });
			return;
		}

		const album = albumRepository.findById(albumId);
		if (!album) {
			sendJson(res, 404, { error: 'Album not found' });
			return;
		}

		const access = userCanAccessScope(userId, album.scope_type, album.scope_id);
		if (!access.allowed) {
			sendJson(res, access.status, { error: access.error });
			return;
		}

		const limit = normalizeLimit(url.searchParams.get('limit'), 300, 1, 1000);
		const items = albumRepository.listItems(albumId, limit).map(toClientAlbumItem);
		sendJson(res, 200, {
			album: toClientAlbum(album),
			items
		});
	} catch (error) {
		console.error('[Albums] Failed to list album items:', error);
		sendJson(res, 500, { error: 'Failed to list album items' });
	}
}

export async function handleAddAlbumItem(
	req: IncomingMessage,
	res: ServerResponse,
	userId: number,
	rawAlbumId: string,
	limitConfig?: AlbumUploadLimitConfig | null
): Promise<void> {
	try {
		const albumId = parseAlbumId(rawAlbumId);
		if (!albumId) {
			sendJson(res, 400, { error: 'Invalid album id' });
			return;
		}

		const album = albumRepository.findById(albumId);
		if (!album) {
			sendJson(res, 404, { error: 'Album not found' });
			return;
		}

		const access = userCanAccessScope(userId, album.scope_type, album.scope_id);
		if (!access.allowed) {
			sendJson(res, access.status, { error: access.error });
			return;
		}

		const body = await readJsonBody(req);
		const attachmentUrl = sanitizeAttachmentUrl(body?.attachmentUrl);
		const attachmentName = sanitizeAttachmentName(body?.attachmentName);
		const attachmentSize = sanitizeOptionalSize(body?.attachmentSize);
		const attachmentMime = sanitizeOptionalString(body?.attachmentMime, 120);
		const messageId = sanitizeOptionalString(body?.messageId, 128);
		const caption = sanitizeOptionalString(body?.caption, 500);

		if (!attachmentUrl || !attachmentName) {
			sendJson(res, 400, { error: 'attachmentUrl and attachmentName are required' });
			return;
		}
		if (attachmentUrl.length > 2048) {
			sendJson(res, 400, { error: 'attachmentUrl is too long' });
			return;
		}
		if (attachmentName.length > 255) {
			sendJson(res, 400, { error: 'attachmentName is too long' });
			return;
		}
		if (!canHardDeleteAttachmentUrl(attachmentUrl)) {
			sendJson(res, 400, {
				error: 'Album items must reference local uploads to guarantee hard-delete semantics'
			});
			return;
		}

		const policy = sanitizeAlbumUploadLimitConfig(limitConfig);
		const roleTier = resolveAlbumPolicyTier(userId);
		const maxBytesForRole = policy.perRoleMaxBytesPerItem[roleTier];
		if (maxBytesForRole !== null && attachmentSize !== null && attachmentSize > maxBytesForRole) {
			sendJson(res, 413, {
				error: `Album item is too large for your role (max ${maxBytesForRole} bytes per item).`,
				code: 'ALBUM_UPLOAD_SIZE_LIMIT',
				retryAfterSeconds: 0,
				details: {
					roleTier,
					maxBytes: maxBytesForRole,
					receivedBytes: attachmentSize
				}
			});
			return;
		}

		const now = Date.now();
		const windowStart = now - ALBUM_UPLOAD_RATE_WINDOW_MS;
		const userRateLimit = policy.perRoleItemsPerMinute[roleTier];
		const userRecentCount = albumRepository.countItemsByUploaderInScopeSince(
			album.scope_type,
			album.scope_id,
			userId,
			windowStart
		);
		if (userRecentCount >= userRateLimit) {
			sendJson(res, 429, {
				error: `Album upload rate limit reached (${userRateLimit} items/min for your role).`,
				code: 'ALBUM_UPLOAD_RATE_LIMIT_USER',
				retryAfterSeconds: Math.ceil(ALBUM_UPLOAD_RATE_WINDOW_MS / 1000),
				details: {
					roleTier,
					limit: userRateLimit,
					current: userRecentCount
				}
			});
			return;
		}

		const scopeRecentCount = albumRepository.countItemsInScopeSince(
			album.scope_type,
			album.scope_id,
			windowStart
		);
		if (scopeRecentCount >= policy.perScopeItemsPerMinute) {
			sendJson(res, 429, {
				error: `Album scope is temporarily saturated (${policy.perScopeItemsPerMinute} items/min).`,
				code: 'ALBUM_UPLOAD_RATE_LIMIT_SCOPE',
				retryAfterSeconds: Math.ceil(ALBUM_UPLOAD_RATE_WINDOW_MS / 1000),
				details: {
					limit: policy.perScopeItemsPerMinute,
					current: scopeRecentCount
				}
			});
			return;
		}

		const item = albumRepository.createItem({
			album_id: albumId,
			attachment_url: attachmentUrl,
			attachment_name: attachmentName,
			attachment_size: attachmentSize,
			attachment_mime: attachmentMime,
			message_id: messageId,
			caption,
			uploaded_by: userId,
			uploaded_at: now
		});
		albumRepository.setUpdatedAt(albumId, now);

		sendJson(res, 201, { item: toClientAlbumItem(item) });
	} catch (error) {
		if (isPayloadTooLargeError(error)) {
			sendJson(res, 413, { error: 'Album item payload too large' });
			return;
		}
		if (isInvalidJsonError(error)) {
			sendJson(res, 400, { error: 'Invalid album item payload' });
			return;
		}
		console.error('[Albums] Failed to add album item:', error);
		sendJson(res, 400, { error: 'Invalid album item payload' });
	}
}

export async function handleSetAlbumFeatured(
	req: IncomingMessage,
	res: ServerResponse,
	userId: number,
	rawAlbumId: string
): Promise<void> {
	try {
		const albumId = parseAlbumId(rawAlbumId);
		if (!albumId) {
			sendJson(res, 400, { error: 'Invalid album id' });
			return;
		}

		const album = albumRepository.findById(albumId);
		if (!album) {
			sendJson(res, 404, { error: 'Album not found' });
			return;
		}

		const access = userCanAccessScope(userId, album.scope_type, album.scope_id);
		if (!access.allowed) {
			sendJson(res, access.status, { error: access.error });
			return;
		}

		const canModerate = userCanModerateAlbums(userId);
		const isAlbumOwner = album.created_by === userId;
		if (!isAlbumOwner && !canModerate) {
			sendJson(res, 403, { error: 'Only album owner or moderators can change featured album state' });
			return;
		}

		const body = await readJsonBody(req);
		const featured = sanitizeFeaturedFlag(body?.featured);
		if (featured === null) {
			sendJson(res, 400, { error: 'featured must be a boolean' });
			return;
		}

		const changes = albumRepository.setFeatured(albumId, featured, Date.now());
		if (changes === 0) {
			sendJson(res, 404, { error: 'Album not found or unavailable' });
			return;
		}

		const hydrated = albumRepository.findById(albumId);
		if (!hydrated) {
			sendJson(res, 500, { error: 'Featured state updated but album could not be loaded' });
			return;
		}

		sendJson(res, 200, { album: toClientAlbum(hydrated) });
	} catch (error) {
		if (isPayloadTooLargeError(error)) {
			sendJson(res, 413, { error: 'Featured album payload too large' });
			return;
		}
		if (isInvalidJsonError(error)) {
			sendJson(res, 400, { error: 'Invalid featured album payload' });
			return;
		}
		console.error('[Albums] Failed to update featured album state:', error);
		sendJson(res, 400, { error: 'Invalid featured album payload' });
	}
}

export async function handleReorderAlbumItems(
	req: IncomingMessage,
	res: ServerResponse,
	userId: number,
	rawAlbumId: string
): Promise<void> {
	try {
		const albumId = parseAlbumId(rawAlbumId);
		if (!albumId) {
			sendJson(res, 400, { error: 'Invalid album id' });
			return;
		}

		const album = albumRepository.findById(albumId);
		if (!album) {
			sendJson(res, 404, { error: 'Album not found' });
			return;
		}

		const access = userCanAccessScope(userId, album.scope_type, album.scope_id);
		if (!access.allowed) {
			sendJson(res, access.status, { error: access.error });
			return;
		}

		const canModerate = userCanModerateAlbums(userId);
		const isAlbumOwner = album.created_by === userId;
		if (!isAlbumOwner && !canModerate) {
			sendJson(res, 403, { error: 'Only album owner or moderators can reorder album items' });
			return;
		}

		const body = await readJsonBody(req);
		const itemIds = sanitizeItemIdList(body?.itemIds);
		if (itemIds.length === 0) {
			sendJson(res, 400, { error: 'itemIds must be a non-empty array of item ids' });
			return;
		}
		if (itemIds.length > 1000) {
			sendJson(res, 400, { error: 'itemIds exceeds maximum allowed size (1000)' });
			return;
		}

		const seen = new Set<number>();
		for (const itemId of itemIds) {
			if (seen.has(itemId)) {
				sendJson(res, 400, { error: 'itemIds must not contain duplicates' });
				return;
			}
			seen.add(itemId);
		}

		const existingItems = albumRepository.listItems(albumId, 1000);
		if (existingItems.length !== itemIds.length) {
			sendJson(res, 400, { error: 'itemIds must include every item in the album exactly once' });
			return;
		}
		const existingIds = new Set(existingItems.map((item) => item.id));
		for (const itemId of itemIds) {
			if (!existingIds.has(itemId)) {
				sendJson(res, 400, { error: 'itemIds must only include items from this album' });
				return;
			}
		}

		const changes = albumRepository.reorderItems(albumId, itemIds);
		if (changes === 0) {
			sendJson(res, 400, { error: 'Failed to reorder album items' });
			return;
		}
		albumRepository.setUpdatedAt(albumId, Date.now());

		sendJson(res, 200, { items: albumRepository.listItems(albumId, 1000).map(toClientAlbumItem) });
	} catch (error) {
		if (isPayloadTooLargeError(error)) {
			sendJson(res, 413, { error: 'Album reorder payload too large' });
			return;
		}
		if (isInvalidJsonError(error)) {
			sendJson(res, 400, { error: 'Invalid album reorder payload' });
			return;
		}
		console.error('[Albums] Failed to reorder album items:', error);
		sendJson(res, 400, { error: 'Invalid album reorder payload' });
	}
}

export async function handleDeleteAlbum(
	_req: IncomingMessage,
	res: ServerResponse,
	userId: number,
	rawAlbumId: string
): Promise<void> {
	try {
		const albumId = parseAlbumId(rawAlbumId);
		if (!albumId) {
			sendJson(res, 400, { error: 'Invalid album id' });
			return;
		}

		const album = albumRepository.findById(albumId);
		if (!album) {
			sendJson(res, 404, { error: 'Album not found' });
			return;
		}

		const access = userCanAccessScope(userId, album.scope_type, album.scope_id);
		if (!access.allowed) {
			sendJson(res, access.status, { error: access.error });
			return;
		}

		const canModerate = userCanModerateAlbums(userId);
		const isAlbumOwner = album.created_by === userId;
		if (!isAlbumOwner && !canModerate) {
			sendJson(res, 403, { error: 'Only album owner or moderators can delete albums' });
			return;
		}

		const items = albumRepository.listItems(albumId, 1000);
		const undeletable = items.filter((item) => !canHardDeleteAttachmentUrl(item.attachment_url));
		if (undeletable.length > 0) {
			sendJson(res, 409, {
				error: 'Album contains items that cannot be hard-deleted safely',
				code: 'ALBUM_HARD_DELETE_BLOCKED',
				details: { undeletableCount: undeletable.length }
			});
			return;
		}
		for (const item of items) {
			const deleted = deleteUploadFileByUrl(item.attachment_url);
			if (!deleted) {
				sendJson(res, 500, {
					error: 'Failed to hard-delete one or more album files; album was not deleted',
					code: 'ALBUM_HARD_DELETE_FAILED'
				});
				return;
			}
		}

		const changes = albumRepository.deleteAlbum(albumId);
		if (changes === 0) {
			sendJson(res, 404, { error: 'Album not found or already deleted' });
			return;
		}

		sendJson(res, 200, { success: true, deletedAlbumId: albumId });
	} catch (error) {
		console.error('[Albums] Failed to delete album:', error);
		sendJson(res, 500, { error: 'Failed to delete album' });
	}
}

export async function handleDeleteAlbumItem(
	_req: IncomingMessage,
	res: ServerResponse,
	userId: number,
	rawAlbumId: string,
	rawItemId: string
): Promise<void> {
	try {
		const albumId = parseAlbumId(rawAlbumId);
		const itemId = parseAlbumItemId(rawItemId);
		if (!albumId || !itemId) {
			sendJson(res, 400, { error: 'Invalid album or item id' });
			return;
		}

		const album = albumRepository.findById(albumId);
		if (!album) {
			sendJson(res, 404, { error: 'Album not found' });
			return;
		}

		const access = userCanAccessScope(userId, album.scope_type, album.scope_id);
		if (!access.allowed) {
			sendJson(res, access.status, { error: access.error });
			return;
		}

		const item = albumRepository.findItemById(itemId);
		if (!item || item.album_id !== albumId) {
			sendJson(res, 404, { error: 'Album item not found' });
			return;
		}

		const canModerate = userCanModerateAlbums(userId);
		const isAlbumOwner = album.created_by === userId;
		const isItemOwner = item.uploaded_by === userId;
		if (!isItemOwner && !isAlbumOwner && !canModerate) {
			sendJson(res, 403, { error: 'Only item owner, album owner, or moderators can delete album items' });
			return;
		}

		if (!canHardDeleteAttachmentUrl(item.attachment_url)) {
			sendJson(res, 409, {
				error: 'This album item cannot be hard-deleted safely',
				code: 'ALBUM_HARD_DELETE_BLOCKED'
			});
			return;
		}
		const deleted = deleteUploadFileByUrl(item.attachment_url);
		if (!deleted) {
			sendJson(res, 500, {
				error: 'Failed to hard-delete album file; item was not deleted',
				code: 'ALBUM_HARD_DELETE_FAILED'
			});
			return;
		}
		const changes = albumRepository.deleteItem(albumId, itemId);
		if (changes === 0) {
			sendJson(res, 404, { error: 'Album item not found' });
			return;
		}
		albumRepository.setUpdatedAt(albumId, Date.now());

		sendJson(res, 200, { success: true, deletedItemId: itemId });
	} catch (error) {
		console.error('[Albums] Failed to delete album item:', error);
		sendJson(res, 500, { error: 'Failed to delete album item' });
	}
}
