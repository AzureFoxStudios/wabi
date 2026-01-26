import db from '../database.js';

export interface GuestCode {
  code: string;
  description: string;
  created_at: number;
  created_by: number | null;
  is_active: number;
}

export class GuestCodeRepository {
  // Verify if code is valid
  isValidCode(code: string): boolean {
    const stmt = db.prepare('SELECT is_active FROM guest_codes WHERE code = ?');
    const result = stmt.get(code) as { is_active: number } | undefined;
    return result?.is_active === 1;
  }

  // Create new guest code
  create(code: string, description: string, createdBy?: number): void {
    const stmt = db.prepare(`
      INSERT INTO guest_codes (code, description, created_by, created_at)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(code, description, createdBy || null, Math.floor(Date.now() / 1000));
  }

  // List all codes
  listAll(): GuestCode[] {
    const stmt = db.prepare('SELECT * FROM guest_codes ORDER BY created_at DESC');
    return stmt.all() as GuestCode[];
  }

  // Deactivate code
  deactivate(code: string): void {
    const stmt = db.prepare('UPDATE guest_codes SET is_active = 0 WHERE code = ?');
    stmt.run(code);
  }
}

export const guestCodeRepository = new GuestCodeRepository();
