import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { DATA_DIR } from '../constants.js';
import type { StatePlaneConfig } from './config.js';

interface SchemaHistoryEntry {
	version: number;
	appliedAt: number;
	reason: string;
}

interface SchemaFileShape {
	version: number;
	updatedAt: number;
	history?: SchemaHistoryEntry[];
}

export interface StatePlaneSchemaVersionStats {
	path: string;
	requiredVersion: number;
	currentVersion: number | null;
	autoApply: boolean;
	updated: boolean;
	mismatch: boolean;
	reason: string | null;
	lastUpdatedAt: number | null;
	historyLength: number;
	lastError: string | null;
	lastErrorAt: number | null;
}

export class StatePlaneSchemaVersionManager {
	private readonly requiredVersion: number;
	private readonly autoApply: boolean;
	private readonly path: string;
	private stats: StatePlaneSchemaVersionStats;

	constructor(config: StatePlaneConfig) {
		this.requiredVersion = config.planeSchemaVersion;
		this.autoApply = config.planeSchemaAutoApply;
		this.path = join(DATA_DIR, 'state-plane-schema-version.json');
		this.stats = {
			path: this.path,
			requiredVersion: this.requiredVersion,
			currentVersion: null,
			autoApply: this.autoApply,
			updated: false,
			mismatch: false,
			reason: null,
			lastUpdatedAt: null,
			historyLength: 0,
			lastError: null,
			lastErrorAt: null
		};
	}

	reconcile(): void {
		const loaded = this.loadCurrent();
		if (!loaded) {
			if (!this.autoApply) {
				this.stats.mismatch = true;
				this.stats.reason = 'schema_version_missing';
				return;
			}
			this.writeVersion(this.requiredVersion, 'bootstrap');
			return;
		}

		this.stats.currentVersion = loaded.version;
		this.stats.lastUpdatedAt = loaded.updatedAt;
		this.stats.historyLength = loaded.history.length;

		if (loaded.version === this.requiredVersion) {
			this.stats.mismatch = false;
			this.stats.reason = null;
			return;
		}

		if (loaded.version > this.requiredVersion) {
			this.stats.mismatch = true;
			this.stats.reason = `schema_downgrade_not_supported current=${loaded.version} required=${this.requiredVersion}`;
			return;
		}

		if (!this.autoApply) {
			this.stats.mismatch = true;
			this.stats.reason = `schema_upgrade_required current=${loaded.version} required=${this.requiredVersion}`;
			return;
		}

		this.writeVersion(this.requiredVersion, `auto_upgrade_from_${loaded.version}`);
	}

	getStats(): StatePlaneSchemaVersionStats {
		return { ...this.stats };
	}

	private ensurePath(): void {
		const dir = dirname(this.path);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
	}

	private loadCurrent(): { version: number; updatedAt: number | null; history: SchemaHistoryEntry[] } | null {
		if (!existsSync(this.path)) return null;
		try {
			const raw = readFileSync(this.path, 'utf8');
			const parsed = JSON.parse(raw) as Partial<SchemaFileShape>;
			const version = Number(parsed.version);
			if (!Number.isFinite(version) || version < 1) return null;
			const updatedAtRaw = Number(parsed.updatedAt);
			const updatedAt = Number.isFinite(updatedAtRaw) ? Math.max(0, Math.floor(updatedAtRaw)) : null;
			const history = Array.isArray(parsed.history)
				? parsed.history
					.map((entry) => ({
						version: Number((entry as Partial<SchemaHistoryEntry>).version),
						appliedAt: Number((entry as Partial<SchemaHistoryEntry>).appliedAt),
						reason: String((entry as Partial<SchemaHistoryEntry>).reason || '')
					}))
					.filter(
						(entry) =>
							Number.isFinite(entry.version) &&
							entry.version >= 1 &&
							Number.isFinite(entry.appliedAt) &&
							entry.appliedAt > 0 &&
							entry.reason.length > 0
					)
				: [];

			return {
				version: Math.floor(version),
				updatedAt,
				history
			};
		} catch (error) {
			this.stats.lastErrorAt = Date.now();
			this.stats.lastError = error instanceof Error ? error.message : String(error);
			return null;
		}
	}

	private writeVersion(version: number, reason: string): void {
		try {
			this.ensurePath();
			const now = Date.now();
			const current = this.loadCurrent();
			const history = current?.history || [];
			history.push({
				version,
				appliedAt: now,
				reason
			});
			const next: SchemaFileShape = {
				version,
				updatedAt: now,
				history: history.slice(-200)
			};
			writeFileSync(this.path, `${JSON.stringify(next, null, 2)}\n`);
			this.stats.currentVersion = version;
			this.stats.lastUpdatedAt = now;
			this.stats.historyLength = next.history?.length || 0;
			this.stats.updated = true;
			this.stats.mismatch = false;
			this.stats.reason = null;
			console.log(`[StatePlane] Schema version set to ${version} (${reason})`);
		} catch (error) {
			this.stats.lastErrorAt = Date.now();
			this.stats.lastError = error instanceof Error ? error.message : String(error);
			this.stats.mismatch = true;
			this.stats.reason = 'schema_write_failed';
		}
	}
}
