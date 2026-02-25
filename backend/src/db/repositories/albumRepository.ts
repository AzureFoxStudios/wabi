import db from '../database.js';

export type AlbumScopeType = 'channel' | 'dm';

export interface DbAlbum {
	id?: number;
	scope_type: AlbumScopeType;
	scope_id: string;
	name: string;
	created_by: number;
	created_at: number;
	updated_at: number;
	is_archived: number;
}

export interface DbAlbumWithCounts extends DbAlbum {
	item_count: number;
}

export interface DbAlbumItem {
	id?: number;
	album_id: number;
	attachment_url: string;
	attachment_name: string;
	attachment_size?: number | null;
	attachment_mime?: string | null;
	message_id?: string | null;
	caption?: string | null;
	uploaded_by: number;
	uploaded_at: number;
}

export class AlbumRepository {
	create(album: Omit<DbAlbum, 'id' | 'updated_at' | 'is_archived'>): DbAlbum {
		const updatedAt = album.created_at;
		const stmt = db.prepare(`
			INSERT INTO albums (scope_type, scope_id, name, created_by, created_at, updated_at, is_archived)
			VALUES (?, ?, ?, ?, ?, ?, 0)
		`);
		const info = stmt.run(
			album.scope_type,
			album.scope_id,
			album.name,
			album.created_by,
			album.created_at,
			updatedAt
		);

		return {
			id: info.lastInsertRowid as number,
			scope_type: album.scope_type,
			scope_id: album.scope_id,
			name: album.name,
			created_by: album.created_by,
			created_at: album.created_at,
			updated_at: updatedAt,
			is_archived: 0
		};
	}

	listByScope(scopeType: AlbumScopeType, scopeId: string, limit = 100): DbAlbumWithCounts[] {
		const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : 100;
		const stmt = db.prepare(`
			SELECT
				a.id,
				a.scope_type,
				a.scope_id,
				a.name,
				a.created_by,
				a.created_at,
				a.updated_at,
				a.is_archived,
				COUNT(ai.id) AS item_count
			FROM albums a
			LEFT JOIN album_items ai ON ai.album_id = a.id
			WHERE a.scope_type = ? AND a.scope_id = ? AND a.is_archived = 0
			GROUP BY a.id, a.scope_type, a.scope_id, a.name, a.created_by, a.created_at, a.updated_at, a.is_archived
			ORDER BY a.updated_at DESC
			LIMIT ?
		`);
		const rows = stmt.all(scopeType, scopeId, safeLimit) as Array<DbAlbumWithCounts & { item_count: number | string | null }>;
		return rows.map((row) => ({
			...row,
			item_count: Number(row.item_count || 0)
		}));
	}

	findById(albumId: number): DbAlbumWithCounts | null {
		const stmt = db.prepare(`
			SELECT
				a.id,
				a.scope_type,
				a.scope_id,
				a.name,
				a.created_by,
				a.created_at,
				a.updated_at,
				a.is_archived,
				COUNT(ai.id) AS item_count
			FROM albums a
			LEFT JOIN album_items ai ON ai.album_id = a.id
			WHERE a.id = ? AND a.is_archived = 0
			GROUP BY a.id, a.scope_type, a.scope_id, a.name, a.created_by, a.created_at, a.updated_at, a.is_archived
			LIMIT 1
		`);
		const row = stmt.get(albumId) as (DbAlbumWithCounts & { item_count: number | string | null }) | undefined;
		if (!row) return null;
		return {
			...row,
			item_count: Number(row.item_count || 0)
		};
	}

	setUpdatedAt(albumId: number, updatedAt: number): void {
		const stmt = db.prepare('UPDATE albums SET updated_at = ? WHERE id = ?');
		stmt.run(updatedAt, albumId);
	}

	archive(albumId: number, updatedAt: number): number {
		const stmt = db.prepare('UPDATE albums SET is_archived = 1, updated_at = ? WHERE id = ? AND is_archived = 0');
		const info = stmt.run(updatedAt, albumId);
		return info.changes;
	}

	deleteAlbum(albumId: number): number {
		const stmt = db.prepare('DELETE FROM albums WHERE id = ?');
		const info = stmt.run(albumId);
		return info.changes;
	}

	createItem(item: Omit<DbAlbumItem, 'id'>): DbAlbumItem {
		const stmt = db.prepare(`
			INSERT INTO album_items (
				album_id, attachment_url, attachment_name, attachment_size, attachment_mime,
				message_id, caption, uploaded_by, uploaded_at
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		const info = stmt.run(
			item.album_id,
			item.attachment_url,
			item.attachment_name,
			item.attachment_size ?? null,
			item.attachment_mime ?? null,
			item.message_id ?? null,
			item.caption ?? null,
			item.uploaded_by,
			item.uploaded_at
		);
		return {
			id: info.lastInsertRowid as number,
			...item
		};
	}

	listItems(albumId: number, limit = 300): DbAlbumItem[] {
		const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(1000, Math.floor(limit))) : 300;
		const stmt = db.prepare(`
			SELECT *
			FROM album_items
			WHERE album_id = ?
			ORDER BY uploaded_at DESC
			LIMIT ?
		`);
		return stmt.all(albumId, safeLimit) as DbAlbumItem[];
	}

	findItemById(itemId: number): DbAlbumItem | null {
		const stmt = db.prepare(`
			SELECT *
			FROM album_items
			WHERE id = ?
			LIMIT 1
		`);
		return (stmt.get(itemId) as DbAlbumItem) || null;
	}

	deleteItem(albumId: number, itemId: number): number {
		const stmt = db.prepare(`
			DELETE FROM album_items
			WHERE album_id = ? AND id = ?
		`);
		const info = stmt.run(albumId, itemId);
		return info.changes;
	}
}

export const albumRepository = new AlbumRepository();
