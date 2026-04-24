import { stdbGuestCodeIngest, stdbGuestCodeRows, stdbGuestCodesEnabled } from './stdbGuestCodeRuntime.js';

export interface GuestCode {
	code: string;
	description: string;
	created_at: number;
	created_by: number | null;
	is_active: boolean;
}

function normalizeGuestCode(row: Record<string, unknown>): GuestCode | null {
	const code = String(row.code || '');
	if (!code) return null;
	return {
		code,
		description: String(row.description || ''),
		created_at: Number(row.created_at) || 0,
		created_by: row.created_by != null ? Number(row.created_by) : null,
		is_active: Boolean(row.is_active)
	};
}

export class GuestCodeRepository {
	isValidCode(code: string): boolean {
		if (!stdbGuestCodesEnabled()) return false;
		const rows = stdbGuestCodeRows(
			'guest_codes.validate',
			`SELECT is_active FROM state_guest_code WHERE code = '${code.replace(/'/g, "''")}' LIMIT 1`
		);
		return rows.length > 0 && rows[0].is_active === true;
	}

	create(code: string, description: string, createdBy?: number): void {
		if (!stdbGuestCodesEnabled()) return;
		stdbGuestCodeIngest('guest_codes.write', 'upsert_code', {
			code,
			description,
			createdBy,
			isActive: true
		});
	}

	listAll(): GuestCode[] {
		if (!stdbGuestCodesEnabled()) return [];
		const rows = stdbGuestCodeRows(
			'guest_codes.list',
			`SELECT code, description, created_at, created_by, is_active FROM state_guest_code ORDER BY created_at DESC`
		);
		return rows
			.map(row => normalizeGuestCode(row))
			.filter((c): c is GuestCode => c !== null);
	}

	deactivate(code: string): void {
		if (!stdbGuestCodesEnabled()) return;
		stdbGuestCodeIngest('guest_codes.delete', 'delete_code', { code });
	}
}

export const guestCodeRepository = new GuestCodeRepository();