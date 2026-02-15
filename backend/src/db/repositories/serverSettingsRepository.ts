import db from '../database.js';

export interface ServerSettings {
  id: number;
  registration_open: number;
  raid_mode_enabled: number;
  raid_mode_expires_at?: number | null;
  created_at?: number;
  updated_at?: number;
}

export class ServerSettingsRepository {
  get(): ServerSettings {
    const row = db.prepare('SELECT * FROM server_settings WHERE id = 1').get() as ServerSettings | undefined;
    if (row) return row;

    db.prepare('INSERT OR IGNORE INTO server_settings (id, registration_open, raid_mode_enabled) VALUES (1, 1, 0)').run();
    return db.prepare('SELECT * FROM server_settings WHERE id = 1').get() as ServerSettings;
  }

  set(updates: Partial<Omit<ServerSettings, 'id'>>): ServerSettings {
    const fields = Object.keys(updates);
    if (fields.length === 0) return this.get();

    const setClause = fields.map(f => `${f} = ?`).join(', ');
    const values = fields.map(f => (updates as any)[f]);
    db.prepare(`UPDATE server_settings SET ${setClause}, updated_at = strftime('%s', 'now') WHERE id = 1`).run(...values);
    return this.get();
  }

  isRegistrationOpen(): boolean {
    const settings = this.get();
    if (settings.registration_open !== 1) return false;

    if (settings.raid_mode_enabled === 1) {
      if (settings.raid_mode_expires_at && settings.raid_mode_expires_at * 1000 < Date.now()) {
        this.set({ raid_mode_enabled: 0, raid_mode_expires_at: null });
        return true;
      }
      return false;
    }

    return true;
  }
}

export const serverSettingsRepository = new ServerSettingsRepository();
