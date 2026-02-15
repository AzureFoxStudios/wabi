import db from '../database.js';

export interface PluginInstallation {
  plugin_id: string;
  version: string;
  enabled: number;
  install_source: string;
  checksum: string | null;
  installed_at: number;
  updated_at: number;
  last_enabled_at: number | null;
  last_disabled_at: number | null;
  health_status: string | null;
  health_updated_at: number | null;
  last_error: string | null;
}

export class PluginRepository {
  upsertInstallation(data: {
    plugin_id: string;
    version: string;
    enabled: boolean;
    install_source: string;
    checksum?: string | null;
  }): void {
    const now = Date.now();
    const stmt = db.prepare(`
      INSERT INTO plugin_installations (
        plugin_id, version, enabled, install_source, checksum,
        installed_at, updated_at, last_enabled_at, last_disabled_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(plugin_id) DO UPDATE SET
        version = excluded.version,
        enabled = excluded.enabled,
        install_source = excluded.install_source,
        checksum = excluded.checksum,
        updated_at = excluded.updated_at,
        last_enabled_at = CASE
          WHEN excluded.enabled = 1 THEN excluded.updated_at
          ELSE plugin_installations.last_enabled_at
        END,
        last_disabled_at = CASE
          WHEN excluded.enabled = 0 THEN excluded.updated_at
          ELSE plugin_installations.last_disabled_at
        END
    `);

    stmt.run(
      data.plugin_id,
      data.version,
      data.enabled ? 1 : 0,
      data.install_source,
      data.checksum ?? null,
      now,
      now,
      data.enabled ? now : null,
      data.enabled ? null : now
    );
  }

  setEnabled(pluginId: string, enabled: boolean): void {
    const now = Date.now();
    const stmt = db.prepare(`
      UPDATE plugin_installations
      SET enabled = ?,
          updated_at = ?,
          last_enabled_at = CASE WHEN ? = 1 THEN ? ELSE last_enabled_at END,
          last_disabled_at = CASE WHEN ? = 0 THEN ? ELSE last_disabled_at END
      WHERE plugin_id = ?
    `);

    stmt.run(enabled ? 1 : 0, now, enabled ? 1 : 0, now, enabled ? 1 : 0, now, pluginId);
  }

  setLifecycleInfo(pluginId: string, data: { health_status?: string | null; health_updated_at?: number | null; last_error?: string | null }): void {
    const now = Date.now();
    const stmt = db.prepare(`
      UPDATE plugin_installations
      SET health_status = COALESCE(?, health_status),
          health_updated_at = COALESCE(?, health_updated_at),
          last_error = ?,
          updated_at = ?
      WHERE plugin_id = ?
    `);

    stmt.run(
      data.health_status === undefined ? null : data.health_status,
      data.health_updated_at === undefined ? null : data.health_updated_at,
      data.last_error ?? null,
      now,
      pluginId
    );
  }

  findById(pluginId: string): PluginInstallation | null {
    const stmt = db.prepare('SELECT * FROM plugin_installations WHERE plugin_id = ?');
    return (stmt.get(pluginId) as PluginInstallation) || null;
  }

  listInstallations(): PluginInstallation[] {
    const stmt = db.prepare('SELECT * FROM plugin_installations ORDER BY plugin_id ASC');
    return stmt.all() as PluginInstallation[];
  }

  deleteInstallation(pluginId: string): boolean {
    const stmt = db.prepare('DELETE FROM plugin_installations WHERE plugin_id = ?');
    return stmt.run(pluginId).changes > 0;
  }
}

export const pluginRepository = new PluginRepository();
