import db from '../database.js';
import { hashPassword, verifyPassword } from '../../auth/passwordHash.js';
import crypto from 'crypto';
import { stdbRelayIngest, stdbRelayRows, stdbRelaysEnabled } from './stdbRelayRuntime.js';
import { escapeSqlLiteral } from '../../state-plane/stdbSyncClient.js';
import {
	parseRelayMetadata,
	sanitizeRelayMetadata,
	type RelayPublicCapabilities,
	type RelaySfuMetadata,
	type RelayTurnMetadata
} from '../../relay/relayMetadata.js';

export interface Relay {
	relay_id: number;
	url: string;
	name: string;
	region: string;
	api_key_hash: string;
	status: string;
	last_health_ping: number | null;
	registered_at: number;
	approved: number;
	latitude: number | null;
	longitude: number | null;
	bandwidth_mbps: number | null;
	storage_gb: number | null;
	syncthing_device_id: string | null;
	metadata_json: string | null;
}

export interface PublicRelay {
	relay_id: number;
	url: string;
	name: string;
	region: string;
	status: string;
	latitude: number | null;
	longitude: number | null;
	bandwidth_mbps: number | null;
	capabilities: RelayPublicCapabilities;
	turn: RelayTurnMetadata | null;
	sfu: RelaySfuMetadata | null;
}

export class RelayRepository {
	private generateRelayId(): number {
		for (let attempt = 0; attempt < 16; attempt += 1) {
			const relayId = crypto.randomInt(1, 2_147_483_647);
			if (!this.findLegacyById(relayId)) {
				return relayId;
			}
		}
		const fallback = Math.floor(Date.now() / 1000) % 2_147_483_647;
		return fallback > 0 ? fallback : 1;
	}

	private normalizeRelay(row: Partial<Relay> | null | undefined): Relay | null {
		const relayId = row?.relay_id !== undefined ? Number(row.relay_id) : 0;
		if (!Number.isFinite(relayId) || relayId <= 0) return null;
		return {
			relay_id: relayId,
			url: row?.url ? String(row.url) : '',
			name: row?.name ? String(row.name) : '',
			region: row?.region ? String(row.region) : '',
			api_key_hash: row?.api_key_hash ? String(row.api_key_hash) : '',
			status: row?.status ? String(row.status) : 'pending',
			last_health_ping:
				row?.last_health_ping === undefined || row?.last_health_ping === null
					? null
					: Number(row.last_health_ping),
			registered_at: row?.registered_at !== undefined ? Number(row.registered_at) : 0,
			approved: row?.approved !== undefined ? Number(row.approved) : 0,
			latitude:
				row?.latitude === undefined || row?.latitude === null ? null : Number(row.latitude),
			longitude:
				row?.longitude === undefined || row?.longitude === null ? null : Number(row.longitude),
			bandwidth_mbps:
				row?.bandwidth_mbps === undefined || row?.bandwidth_mbps === null
					? null
					: Number(row.bandwidth_mbps),
			storage_gb:
				row?.storage_gb === undefined || row?.storage_gb === null ? null : Number(row.storage_gb),
			syncthing_device_id:
				row?.syncthing_device_id === undefined || row?.syncthing_device_id === null
					? null
					: String(row.syncthing_device_id),
			metadata_json:
				row?.metadata_json === undefined || row?.metadata_json === null ? null : String(row.metadata_json)
		};
	}

	private toPublicRelay(relay: Relay): PublicRelay {
		const metadata = parseRelayMetadata(relay.metadata_json);
		return {
			relay_id: relay.relay_id,
			url: relay.url,
			name: relay.name,
			region: relay.region,
			status: relay.status,
			latitude: relay.latitude,
			longitude: relay.longitude,
			bandwidth_mbps: relay.bandwidth_mbps,
			capabilities: metadata?.capabilities || {
				fileRelay: true,
				turn: false,
				sfu: false,
				gateway: false,
				selfHosted: false,
				boosterMode: null
			},
			turn: metadata?.turn || null,
			sfu: metadata?.sfu || null
		};
	}

	private isPublicRelay(relay: Relay): boolean {
		if ((relay.status !== 'active' && relay.status !== 'degraded') || relay.approved !== 1) {
			return false;
		}
		const metadata = parseRelayMetadata(relay.metadata_json);
		return metadata?.kind !== 'desktop-helper';
	}

	private listLegacyRelays(): Relay[] {
		const stmt = db.prepare('SELECT * FROM relays ORDER BY registered_at DESC');
		return (stmt.all() as Relay[]).map((row) => this.normalizeRelay(row)).filter((row): row is Relay => Boolean(row));
	}

	private getLegacyActiveRelays(): PublicRelay[] {
		const stmt = db.prepare(`
			SELECT relay_id, url, name, region, status, latitude, longitude, bandwidth_mbps, metadata_json
			FROM relays
			WHERE status IN ('active', 'degraded') AND approved = 1
			ORDER BY region, name
		`);
		return (stmt.all() as Relay[])
			.map((row) => this.normalizeRelay(row))
			.filter((row): row is Relay => Boolean(row))
			.filter((row) => this.isPublicRelay(row))
			.map((row) => this.toPublicRelay(row));
	}

	private parseRelayRows(rows: Array<Record<string, unknown>> | null): Relay[] | null {
		if (!rows) return null;
		const parsed = rows
			.map((row) => {
				try {
					return this.normalizeRelay(JSON.parse(String(row.row_json || '{}')) as Partial<Relay>);
				} catch {
					return null;
				}
			})
			.filter((row): row is Relay => Boolean(row));
		return parsed;
	}

	private listStdbRelays(): Relay[] | null {
		const rows = stdbRelayRows(
			'relays.read_all',
			'SELECT row_json FROM state_relay'
		);
		const parsed = this.parseRelayRows(rows);
		if (!parsed) return null;
		return parsed.sort((a, b) => b.registered_at - a.registered_at || b.relay_id - a.relay_id);
	}

	private upsertStdb(relay: Relay): void {
		stdbRelayIngest('relays.write', 'upsert_relay', {
			relayId: relay.relay_id,
			row: relay
		});
	}

	private deleteStdb(relayId: number): void {
		stdbRelayIngest('relays.delete', 'delete_relay', { relayId });
	}

	private syncLegacyRelaysToStdb(relays: Relay[]): void {
		if (!stdbRelaysEnabled() || relays.length === 0) return;
		for (const relay of relays) {
			this.upsertStdb(relay);
		}
	}

	private setLegacyRelay(relay: Relay): Relay {
		const existing = this.findLegacyById(relay.relay_id);
		if (existing) {
			const stmt = db.prepare(`
				UPDATE relays
				SET url = ?, name = ?, region = ?, api_key_hash = ?, status = ?, last_health_ping = ?,
					registered_at = ?, approved = ?, latitude = ?, longitude = ?, bandwidth_mbps = ?,
					storage_gb = ?, syncthing_device_id = ?, metadata_json = ?
				WHERE relay_id = ?
			`);
			stmt.run(
				relay.url,
				relay.name,
				relay.region,
				relay.api_key_hash,
				relay.status,
				relay.last_health_ping,
				relay.registered_at,
				relay.approved,
				relay.latitude,
				relay.longitude,
				relay.bandwidth_mbps,
				relay.storage_gb,
				relay.syncthing_device_id,
				relay.metadata_json,
				relay.relay_id
			);
		} else {
			const stmt = db.prepare(`
				INSERT INTO relays (
					relay_id, url, name, region, api_key_hash, status, last_health_ping, registered_at,
					approved, latitude, longitude, bandwidth_mbps, storage_gb, syncthing_device_id, metadata_json
				)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`);
			stmt.run(
				relay.relay_id,
				relay.url,
				relay.name,
				relay.region,
				relay.api_key_hash,
				relay.status,
				relay.last_health_ping,
				relay.registered_at,
				relay.approved,
				relay.latitude,
				relay.longitude,
				relay.bandwidth_mbps,
				relay.storage_gb,
				relay.syncthing_device_id,
				relay.metadata_json
			);
		}
		return this.findLegacyById(relay.relay_id) || relay;
	}

	private findLegacyById(relayId: number): Relay | null {
		const stmt = db.prepare('SELECT * FROM relays WHERE relay_id = ?');
		return this.normalizeRelay((stmt.get(relayId) as Relay | undefined) || null);
	}

	private findLegacyByUrl(url: string): Relay | null {
		const stmt = db.prepare('SELECT * FROM relays WHERE url = ?');
		return this.normalizeRelay((stmt.get(url) as Relay | undefined) || null);
	}

	private getAllRelaysFromStore(): Relay[] {
		if (stdbRelaysEnabled()) {
			const relays = this.listStdbRelays();
			if (relays && relays.length > 0) return relays;
			const legacy = this.listLegacyRelays();
			this.syncLegacyRelaysToStdb(legacy);
			return legacy;
		}
		return this.listLegacyRelays();
	}

	getActiveRelays(): PublicRelay[] {
		if (stdbRelaysEnabled()) {
			const relays = this.getAllRelaysFromStore()
				.filter((relay) => this.isPublicRelay(relay))
				.sort((a, b) => a.region.localeCompare(b.region) || a.name.localeCompare(b.name));
			return relays.map((relay) => this.toPublicRelay(relay));
		}
		return this.getLegacyActiveRelays();
	}

	getAllRelays(): Relay[] {
		return this.getAllRelaysFromStore();
	}

	findByUrl(url: string): Relay | null {
		if (stdbRelaysEnabled()) {
			const rows = stdbRelayRows(
				'relays.find_by_url',
				`SELECT row_json FROM state_relay WHERE url = ${escapeSqlLiteral(url)} LIMIT 1`
			);
			const parsed = this.parseRelayRows(rows);
			if (parsed && parsed.length > 0) return parsed[0];
			const legacy = this.findLegacyByUrl(url);
			if (legacy) this.upsertStdb(legacy);
			return legacy;
		}
		return this.findLegacyByUrl(url);
	}

	findById(relayId: number): Relay | null {
		if (stdbRelaysEnabled()) {
			const rows = stdbRelayRows(
				'relays.find_by_id',
				`SELECT row_json FROM state_relay WHERE relay_id = ${Math.floor(relayId)} LIMIT 1`
			);
			const parsed = this.parseRelayRows(rows);
			if (parsed && parsed.length > 0) return parsed[0];
			const legacy = this.findLegacyById(relayId);
			if (legacy) this.upsertStdb(legacy);
			return legacy;
		}
		return this.findLegacyById(relayId);
	}

	async register(data: {
		url: string;
		name: string;
		region: string;
		latitude?: number;
		longitude?: number;
		bandwidth_mbps?: number;
		storage_gb?: number;
		syncthing_device_id?: string;
		metadata?: Record<string, unknown> | null;
	}): Promise<{ relay_id: number; api_key: string }> {
		const apiKey = 'wabi_relay_' + crypto.randomBytes(24).toString('base64url');
		const apiKeyHash = await hashPassword(apiKey);
		const now = Math.floor(Date.now() / 1000);
		const relayId = this.generateRelayId();
		const relay = this.setLegacyRelay({
			relay_id: relayId,
			url: data.url,
			name: data.name,
			region: data.region,
			api_key_hash: apiKeyHash,
			status: 'pending',
			last_health_ping: null,
			registered_at: now,
			approved: 0,
			latitude: data.latitude ?? null,
			longitude: data.longitude ?? null,
			bandwidth_mbps: data.bandwidth_mbps ?? null,
			storage_gb: data.storage_gb ?? null,
			syncthing_device_id: data.syncthing_device_id ?? null,
			metadata_json: data.metadata ? JSON.stringify(sanitizeRelayMetadata(data.metadata) || data.metadata) : null
		});
		if (stdbRelaysEnabled()) {
			this.upsertStdb(relay);
		}

		return { relay_id: relay.relay_id, api_key: apiKey };
	}

	async upsertSelfHosted(data: {
		url: string;
		name: string;
		region: string;
		status: 'active' | 'degraded' | 'offline';
		latitude?: number;
		longitude?: number;
		bandwidth_mbps?: number;
		storage_gb?: number;
		syncthing_device_id?: string;
		metadata?: Record<string, unknown> | null;
	}): Promise<Relay> {
		const existing = this.findByUrl(data.url);
		const now = Math.floor(Date.now() / 1000);
		const apiKeyHash =
			existing?.api_key_hash ??
			(await hashPassword(`selfhosted:${crypto.randomBytes(24).toString('hex')}`));
		let existingMetadata: Record<string, unknown> | null = null;
		if (existing?.metadata_json) {
			try {
				existingMetadata = sanitizeRelayMetadata(JSON.parse(existing.metadata_json));
			} catch {
				existingMetadata = null;
			}
		}
		const mergedMetadata = sanitizeRelayMetadata({
			...(existingMetadata || {}),
			...(data.metadata || {}),
			selfHosted: true,
			originManaged: true
		}) || {};
		const relay = this.setLegacyRelay({
			relay_id: existing?.relay_id ?? this.generateRelayId(),
			url: data.url,
			name: data.name,
			region: data.region,
			api_key_hash: apiKeyHash,
			status: data.status,
			last_health_ping: now,
			registered_at: existing?.registered_at ?? now,
			approved: 1,
			latitude: data.latitude ?? existing?.latitude ?? null,
			longitude: data.longitude ?? existing?.longitude ?? null,
			bandwidth_mbps: data.bandwidth_mbps ?? existing?.bandwidth_mbps ?? null,
			storage_gb: data.storage_gb ?? existing?.storage_gb ?? null,
			syncthing_device_id: data.syncthing_device_id ?? existing?.syncthing_device_id ?? null,
			metadata_json: JSON.stringify(mergedMetadata)
		});
		if (stdbRelaysEnabled()) {
			this.upsertStdb(relay);
		}
		return relay;
	}

	async upsertManaged(data: {
		url: string;
		name: string;
		region: string;
		status: 'pending' | 'active' | 'degraded' | 'offline';
		approved?: number;
		latitude?: number;
		longitude?: number;
		bandwidth_mbps?: number;
		storage_gb?: number;
		syncthing_device_id?: string;
		metadata?: Record<string, unknown> | null;
	}): Promise<Relay> {
		const existing = this.findByUrl(data.url);
		const now = Math.floor(Date.now() / 1000);
		const apiKeyHash =
			existing?.api_key_hash ??
			(await hashPassword(`managed:${crypto.randomBytes(24).toString('hex')}`));
		let existingMetadata: Record<string, unknown> | null = null;
		if (existing?.metadata_json) {
			try {
				existingMetadata = sanitizeRelayMetadata(JSON.parse(existing.metadata_json));
			} catch {
				existingMetadata = null;
			}
		}
		const mergedMetadata = sanitizeRelayMetadata({
			...(existingMetadata || {}),
			...(data.metadata || {})
		}) || {};
		const relay = this.setLegacyRelay({
			relay_id: existing?.relay_id ?? this.generateRelayId(),
			url: data.url,
			name: data.name,
			region: data.region,
			api_key_hash: apiKeyHash,
			status: data.status,
			last_health_ping: data.status === 'offline' ? existing?.last_health_ping ?? now : now,
			registered_at: existing?.registered_at ?? now,
			approved: typeof data.approved === 'number' ? data.approved : existing?.approved ?? 1,
			latitude: data.latitude ?? existing?.latitude ?? null,
			longitude: data.longitude ?? existing?.longitude ?? null,
			bandwidth_mbps: data.bandwidth_mbps ?? existing?.bandwidth_mbps ?? null,
			storage_gb: data.storage_gb ?? existing?.storage_gb ?? null,
			syncthing_device_id: data.syncthing_device_id ?? existing?.syncthing_device_id ?? null,
			metadata_json: JSON.stringify(mergedMetadata)
		});
		if (stdbRelaysEnabled()) {
			this.upsertStdb(relay);
		}
		return relay;
	}

	updateHealth(relayId: number, metrics?: { bandwidth_mbps?: number; storage_gb?: number }): void {
		const existing = this.findById(relayId);
		if (!existing) return;
		const next = this.setLegacyRelay({
			...existing,
			status: 'active',
			last_health_ping: Math.floor(Date.now() / 1000),
			bandwidth_mbps: metrics?.bandwidth_mbps ?? existing.bandwidth_mbps,
			storage_gb: metrics?.storage_gb ?? existing.storage_gb
		});
		if (stdbRelaysEnabled()) {
			this.upsertStdb(next);
		}
	}

	markStaleRelaysOffline(timeoutSeconds: number = 300): number {
		const cutoff = Math.floor(Date.now() / 1000) - timeoutSeconds;
		const staleRelays = this.getAllRelaysFromStore().filter(
			(relay) =>
				(relay.status === 'active' || relay.status === 'degraded') &&
				relay.last_health_ping !== null &&
				relay.last_health_ping < cutoff
		);
		for (const relay of staleRelays) {
			const next = this.setLegacyRelay({ ...relay, status: 'offline' });
			if (stdbRelaysEnabled()) {
				this.upsertStdb(next);
			}
		}
		return staleRelays.length;
	}

	approve(relayId: number): void {
		const existing = this.findById(relayId);
		if (!existing) return;
		const next = this.setLegacyRelay({ ...existing, approved: 1, status: 'active' });
		if (stdbRelaysEnabled()) {
			this.upsertStdb(next);
		}
	}

	async verifyApiKey(relayId: number, apiKey: string): Promise<boolean> {
		const relay = this.findById(relayId);
		if (!relay) return false;
		return verifyPassword(apiKey, relay.api_key_hash);
	}

	delete(relayId: number): void {
		const stmt = db.prepare('DELETE FROM relays WHERE relay_id = ?');
		stmt.run(relayId);
		if (stdbRelaysEnabled()) {
			this.deleteStdb(relayId);
		}
	}
}

export const relayRepository = new RelayRepository();
