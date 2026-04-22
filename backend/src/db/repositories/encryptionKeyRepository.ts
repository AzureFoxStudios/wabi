import { stdbEncryptionIngest, stdbEncryptionRows } from './stdbEncryptionRuntime.js';

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

	private getByUserId(userId: number): EncryptionKeyRecord | null {
		const rows = stdbEncryptionRows(
			'user_encryption_keys.read',
			`SELECT row_json FROM state_user_encryption_key WHERE user_id = ${Math.floor(userId)} LIMIT 1`
		);
		if (rows.length === 0) return null;
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

	create(userId: number, publicKey: string, privateKeyEncrypted: string): EncryptionKeyRecord {
		const record = this.normalizeRow(userId, {
			public_key: publicKey,
			private_key_encrypted: privateKeyEncrypted,
			created_at: Date.now()
		});
		this.upsertStdb(record);
		return record;
	}

	getPublicKey(userId: number): string | null {
		return this.getByUserId(userId)?.public_key || null;
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
		this.upsertStdb(next);
		return next;
	}
}

export const encryptionKeyRepository = new EncryptionKeyRepository();
