import db from '../database.js';
import { hashPassword, verifyPassword } from '../../auth/passwordHash.js';
import crypto from 'crypto';

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
}

export class RelayRepository {
	getActiveRelays(): PublicRelay[] {
		const stmt = db.prepare(`
			SELECT relay_id, url, name, region, status, latitude, longitude, bandwidth_mbps
			FROM relays
			WHERE status = 'active' AND approved = 1
			ORDER BY region, name
		`);
		return stmt.all() as PublicRelay[];
	}

	getAllRelays(): Relay[] {
		const stmt = db.prepare('SELECT * FROM relays ORDER BY registered_at DESC');
		return stmt.all() as Relay[];
	}

	findByUrl(url: string): Relay | null {
		const stmt = db.prepare('SELECT * FROM relays WHERE url = ?');
		return (stmt.get(url) as Relay) || null;
	}

	findById(relayId: number): Relay | null {
		const stmt = db.prepare('SELECT * FROM relays WHERE relay_id = ?');
		return (stmt.get(relayId) as Relay) || null;
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
	}): Promise<{ relay_id: number; api_key: string }> {
		const apiKey = 'wabi_relay_' + crypto.randomBytes(24).toString('base64url');
		const apiKeyHash = await hashPassword(apiKey);
		const now = Math.floor(Date.now() / 1000);

		const stmt = db.prepare(`
			INSERT INTO relays (url, name, region, api_key_hash, status, registered_at, latitude, longitude, bandwidth_mbps, storage_gb, syncthing_device_id)
			VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
		`);

		const result = stmt.run(
			data.url, data.name, data.region, apiKeyHash, now,
			data.latitude ?? null, data.longitude ?? null,
			data.bandwidth_mbps ?? null, data.storage_gb ?? null,
			data.syncthing_device_id ?? null
		);

		return { relay_id: result.lastInsertRowid as number, api_key: apiKey };
	}

	updateHealth(relayId: number, metrics?: { bandwidth_mbps?: number; storage_gb?: number }): void {
		const now = Math.floor(Date.now() / 1000);
		const fields = ['last_health_ping = ?', "status = 'active'"];
		const values: any[] = [now];

		if (metrics?.bandwidth_mbps !== undefined) {
			fields.push('bandwidth_mbps = ?');
			values.push(metrics.bandwidth_mbps);
		}
		if (metrics?.storage_gb !== undefined) {
			fields.push('storage_gb = ?');
			values.push(metrics.storage_gb);
		}

		values.push(relayId);
		const stmt = db.prepare(`UPDATE relays SET ${fields.join(', ')} WHERE relay_id = ?`);
		stmt.run(...values);
	}

	markStaleRelaysOffline(timeoutSeconds: number = 300): number {
		const cutoff = Math.floor(Date.now() / 1000) - timeoutSeconds;
		const stmt = db.prepare(`
			UPDATE relays SET status = 'offline'
			WHERE status IN ('active', 'degraded')
			AND last_health_ping IS NOT NULL
			AND last_health_ping < ?
		`);
		return stmt.run(cutoff).changes;
	}

	approve(relayId: number): void {
		const stmt = db.prepare("UPDATE relays SET approved = 1, status = 'active' WHERE relay_id = ?");
		stmt.run(relayId);
	}

	async verifyApiKey(relayId: number, apiKey: string): Promise<boolean> {
		const relay = this.findById(relayId);
		if (!relay) return false;
		return verifyPassword(apiKey, relay.api_key_hash);
	}

	delete(relayId: number): void {
		const stmt = db.prepare('DELETE FROM relays WHERE relay_id = ?');
		stmt.run(relayId);
	}
}

export const relayRepository = new RelayRepository();
