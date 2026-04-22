import { hashPassword, verifyPassword } from '../../auth/passwordHash.js';
import crypto from 'crypto';
import { stdbRelayIngest, stdbRelayRows } from './stdbRelayRuntime.js';
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
			if (!this.findById(relayId)) {
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

	private parseRelayRows(rows: Array<Record<string, unknown>>): Relay[] {
		return rows
			.map((row) => {
				try {
					return this.normalizeRelay(JSON.parse(String(row.row_json || '{}')) as Partial<Relay>);
				} catch {
					return null;
				}
			})
			.filter((row): row is Relay => Boolean(row));
	}

	private listStdbRelays(): Relay[] {
		const rows = stdbRelayRows('relays.read_all', 'SELECT row_json FROM state_relay');
		return this.parseRelayRows(rows).sort(
			(a, b) => b.registered_at - a.registered_at || b.relay_id - a.relay_id
		);
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

	getActiveRelays(): PublicRelay[] {
		return this.getAllRelays()
			.filter((relay) => this.isPublicRelay(relay))
			.sort((a, b) => a.region.localeCompare(b.region) || a.name.localeCompare(b.name))
			.map((relay) => this.toPublicRelay(relay));
	}

	getAllRelays(): Relay[] {
		return this.listStdbRelays();
	}

	findByUrl(url: string): Relay | null {
		const rows = stdbRelayRows(
			'relays.find_by_url',
			`SELECT row_json FROM state_relay WHERE url = ${escapeSqlLiteral(url)} LIMIT 1`
		);
		const parsed = this.parseRelayRows(rows);
		return parsed.length > 0 ? parsed[0] : null;
	}

	findById(relayId: number): Relay | null {
		const rows = stdbRelayRows(
			'relays.find_by_id',
			`SELECT row_json FROM state_relay WHERE relay_id = ${Math.floor(relayId)} LIMIT 1`
		);
		const parsed = this.parseRelayRows(rows);
		return parsed.length > 0 ? parsed[0] : null;
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
		this.upsertStdb({
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

		return { relay_id: relayId, api_key: apiKey };
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
		const relay: Relay = {
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
		};
		this.upsertStdb(relay);
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
		const relay: Relay = {
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
		};
		this.upsertStdb(relay);
		return relay;
	}

	updateHealth(relayId: number, metrics?: { bandwidth_mbps?: number; storage_gb?: number }): void {
		const existing = this.findById(relayId);
		if (!existing) return;
		this.upsertStdb({
			...existing,
			status: 'active',
			last_health_ping: Math.floor(Date.now() / 1000),
			bandwidth_mbps: metrics?.bandwidth_mbps ?? existing.bandwidth_mbps,
			storage_gb: metrics?.storage_gb ?? existing.storage_gb
		});
	}

	markStaleRelaysOffline(timeoutSeconds: number = 300): number {
		const cutoff = Math.floor(Date.now() / 1000) - timeoutSeconds;
		const staleRelays = this.getAllRelays().filter(
			(relay) =>
				(relay.status === 'active' || relay.status === 'degraded') &&
				relay.last_health_ping !== null &&
				relay.last_health_ping < cutoff
		);
		for (const relay of staleRelays) {
			this.upsertStdb({ ...relay, status: 'offline' });
		}
		return staleRelays.length;
	}

	approve(relayId: number): void {
		const existing = this.findById(relayId);
		if (!existing) return;
		this.upsertStdb({ ...existing, approved: 1, status: 'active' });
	}

	async verifyApiKey(relayId: number, apiKey: string): Promise<boolean> {
		const relay = this.findById(relayId);
		if (!relay) return false;
		return verifyPassword(apiKey, relay.api_key_hash);
	}

	delete(relayId: number): void {
		this.deleteStdb(relayId);
	}
}

export const relayRepository = new RelayRepository();
