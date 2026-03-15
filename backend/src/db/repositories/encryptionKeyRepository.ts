import db from '../database.js';
import { stdbEncryptionIngest, stdbEncryptionRows, stdbEncryptionEnabled } from './stdbEncryptionRuntime.js';

export interface EncryptionKeyRecord {
	id?: number;
	user_id: number;
	public_key: string;
	private_key_encrypted: string;
	created_at: number;
}

export class EncryptionKeyRepository {
	private normalizeRow(userId: number, row: Partial<EncryptionKeyRecord> | null | undefined): EncryptionKeyRecord {
		const now = Date.now();
		return {
			user_id: userId,
			public_key: row?.public_key ? String(row.public_key) : '',
			private_key_encrypted: row?.private_key_encrypted ? String(row.private_key_encrypted) : '',
			created_at: row?.created_at !== undefined ? Number(row.created_at) : now
		};
	}

	private getByUserIdLegacy(userId: number): EncryptionKeyRecord | null {
		const stmt = db.prepare('SELECT * FROM user_encryption_keys WHERE user_id = ?');
		const row = stmt.get(userId) as EncryptionKeyRecord | undefined;
		return row ? this.normalizeRow(userId, row) : null;
	}

	private getByUserIdStdb(userId: number): EncryptionKeyRecord | null {
		const rows = stdbEncryptionRows(
			'user_encryption_keys.read',
			`SELECT row_json FROM state_user_encryption_key WHERE user_id = ${Math.floor(userId)} LIMIT 1`
		);
		if (!rows || rows.length === 0) return null;
		try {
			const parsed = JSON.parse(String(rows[0].row_json || '{}')) as Partial<EncryptionKeyRecord>;
			return this.normalizeRow(userId, parsed);
		} catch {
			return null;
		}
	}

	private upsertStdb(record: EncryptionKeyRecord): void {
		stdbEncryptionIngest('user_encryption_keys.write', 'upsert_user_encryption_key', {
			userId: record.user_id,
			publicKey: record.public_key,
			privateKeyEncrypted: record.private_key_encrypted,
			createdAt: record.created_at,
			row: record
		});
	}

	private setLegacy(record: EncryptionKeyRecord): EncryptionKeyRecord {
		const existing = this.getByUserIdLegacy(record.user_id);
		if (existing) {
			const stmt = db.prepare(`
				UPDATE user_encryption_keys
				SET public_key = ?, private_key_encrypted = ?
				WHERE user_id = ?
			`);
			stmt.run(record.public_key, record.private_key_encrypted, record.user_id);
		} else {
			const stmt = db.prepare(`
				INSERT INTO user_encryption_keys (user_id, public_key, private_key_encrypted, created_at)
				VALUES (?, ?, ?, ?)
			`);
			stmt.run(record.user_id, record.public_key, record.private_key_encrypted, record.created_at);
		}
		return this.getByUserIdLegacy(record.user_id) || record;
	}

	create(userId: number, publicKey: string, privateKeyEncrypted: string): EncryptionKeyRecord {
		const record = this.normalizeRow(userId, {
			public_key: publicKey,
			private_key_encrypted: privateKeyEncrypted,
			created_at: Date.now()
		});
		if (stdbEncryptionEnabled()) {
			this.upsertStdb(record);
		}
		return this.setLegacy(record);
	}

	getPublicKey(userId: number): string | null {
		return this.getByUserId(userId)?.public_key || null;
	}

	getByUserId(userId: number): EncryptionKeyRecord | null {
		if (stdbEncryptionEnabled()) {
			const row = this.getByUserIdStdb(userId);
			if (row) return row;
			const legacy = this.getByUserIdLegacy(userId);
			if (legacy) {
				this.upsertStdb(legacy);
			}
			return legacy;
		}
		return this.getByUserIdLegacy(userId);
	}

	hasKeys(userId: number): boolean {
		return this.getByUserId(userId) !== null;
	}

	update(userId: number, publicKey: string, privateKeyEncrypted: string): EncryptionKeyRecord {
		const existing = this.getByUserId(userId);
		const next = this.normalizeRow(userId, {
			...(existing || { created_at: Date.now() }),
			public_key: publicKey,
			private_key_encrypted: privateKeyEncrypted
		});
		if (stdbEncryptionEnabled()) {
			this.upsertStdb(next);
		}
		return this.setLegacy(next);
	}
}

export const encryptionKeyRepository = new EncryptionKeyRepository();
