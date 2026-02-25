import { DEFAULT_WORKSPACE_ID } from '../constants.js';
import { getUserRoles } from '../auth/roleMiddleware.js';
import { getRolePriority } from '../db/repositories/roleRepository.js';
import { channelRepository } from '../db/repositories/channelRepository.js';
import { channelMemberRepository } from '../db/repositories/channelMemberRepository.js';
import { albumRepository, type AlbumScopeType, type DbAlbumItem, type DbAlbumWithCounts } from '../db/repositories/albumRepository.js';

async function readJsonBody(req: any): Promise<any> {
	let body = '';
	for await (const chunk of req) {
		body += chunk.toString();
	}
	return body ? JSON.parse(body) : {};
}

function sendJson(res: any, status: number, payload: unknown): void {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(payload));
}

function parseAlbumId(rawAlbumId: string): number | null {
	const parsed = Number(rawAlbumId);
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
		uploadedBy: item.uploaded_by,
		uploadedAt: item.uploaded_at
	};
}

export async function handleListAlbums(req: any, res: any, url: URL, userId: number): Promise<void> {
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

export async function handleCreateAlbum(req: any, res: any, userId: number): Promise<void> {
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
		console.error('[Albums] Failed to create album:', error);
		sendJson(res, 400, { error: 'Invalid album payload' });
	}
}

export async function handleListAlbumItems(req: any, res: any, url: URL, userId: number, rawAlbumId: string): Promise<void> {
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

export async function handleAddAlbumItem(req: any, res: any, userId: number, rawAlbumId: string): Promise<void> {
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

		const now = Date.now();
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
		console.error('[Albums] Failed to add album item:', error);
		sendJson(res, 400, { error: 'Invalid album item payload' });
	}
}
