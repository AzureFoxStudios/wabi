import db from '../database.js';

export interface EncryptionKeyRecord {
	id?: number;
	user_id: number;
	public_key: string;
	private_key_encrypted: string;
	created_at: number;
}

export class EncryptionKeyRepository {
	create(userId: number, publicKey: string, privateKeyEncrypted: string): EncryptionKeyRecord {
		const stmt = db.prepare(`
			INSERT INTO user_encryption_keys (user_id, public_key, private_key_encrypted, created_at)
			VALUES (?, ?, ?, ?)
		`);

		const now = Date.now();
		const info = stmt.run(userId, publicKey, privateKeyEncrypted, now);

		return {
			id: info.lastInsertRowid as number,
			user_id: userId,
			public_key: publicKey,
			private_key_encrypted: privateKeyEncrypted,
			created_at: now
		};
	}

	getPublicKey(userId: number): string | null {
		const stmt = db.prepare('SELECT public_key FROM user_encryption_keys WHERE user_id = ?');
		const row = stmt.get(userId) as { public_key: string } | undefined;
		return row?.public_key || null;
	}

	getByUserId(userId: number): EncryptionKeyRecord | null {
		const stmt = db.prepare('SELECT * FROM user_encryption_keys WHERE user_id = ?');
		return (stmt.get(userId) as EncryptionKeyRecord) || null;
	}

	hasKeys(userId: number): boolean {
		const stmt = db.prepare('SELECT 1 FROM user_encryption_keys WHERE user_id = ?');
		return stmt.get(userId) !== undefined;
	}

	update(userId: number, publicKey: string, privateKeyEncrypted: string): EncryptionKeyRecord {
		const stmt = db.prepare(`
			UPDATE user_encryption_keys
			SET public_key = ?, private_key_encrypted = ?
			WHERE user_id = ?
		`);

		stmt.run(publicKey, privateKeyEncrypted, userId);
		const existing = this.getByUserId(userId);

		return existing || {
			user_id: userId,
			public_key: publicKey,
			private_key_encrypted: privateKeyEncrypted,
			created_at: Date.now()
		};
	}
}

export const encryptionKeyRepository = new EncryptionKeyRepository();
