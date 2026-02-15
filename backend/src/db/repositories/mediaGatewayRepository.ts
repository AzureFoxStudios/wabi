import crypto from 'crypto';
import db from '../database.js';

export type GatewayReadinessState = 'starting' | 'ready' | 'degraded' | 'draining' | 'offline';

export interface GatewayRuntimeRecord {
	gateway_id: string;
	instance_id: string | null;
	status: string;
	readiness_state: GatewayReadinessState;
	version: string | null;
	region: string | null;
	active_streams: number;
	last_seen_at: number;
	updated_at: number;
}

export interface StreamLeaseRecord {
	stream_id: string;
	tenant_id: string;
	workspace_id: string;
	channel_id: string;
	owner_instance: string;
	lease_token: string;
	lease_expires_at: number;
	status: string;
	updated_at: number;
}

export class MediaGatewayRepository {
	upsertRuntime(input: {
		instanceId?: string;
		status?: string;
		readinessState?: GatewayReadinessState;
		version?: string;
		region?: string;
		activeStreams?: number;
		lastSeenAt?: number;
	}): GatewayRuntimeRecord {
		const now = Date.now();
		const runtime = this.getRuntimeRecord();
		const merged = {
			gatewayId: 'primary',
			instanceId: input.instanceId ?? runtime?.instance_id ?? null,
			status: input.status ?? runtime?.status ?? 'online',
			readinessState: input.readinessState ?? runtime?.readiness_state ?? 'starting',
			version: input.version ?? runtime?.version ?? null,
			region: input.region ?? runtime?.region ?? null,
			activeStreams: input.activeStreams ?? runtime?.active_streams ?? 0,
			lastSeenAt: input.lastSeenAt ?? now,
			updatedAt: now
		};

		db.prepare(`
			INSERT INTO media_gateway_runtime (gateway_id, instance_id, status, readiness_state, version, region, active_streams, last_seen_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(gateway_id) DO UPDATE SET
				instance_id = excluded.instance_id,
				status = excluded.status,
				readiness_state = excluded.readiness_state,
				version = excluded.version,
				region = excluded.region,
				active_streams = excluded.active_streams,
				last_seen_at = excluded.last_seen_at,
				updated_at = excluded.updated_at
		`).run(
			merged.gatewayId,
			merged.instanceId,
			merged.status,
			merged.readinessState,
			merged.version,
			merged.region,
			merged.activeStreams,
			merged.lastSeenAt,
			merged.updatedAt
		);

		return this.getRuntimeRecord() as GatewayRuntimeRecord;
	}

	getRuntimeRecord(): GatewayRuntimeRecord | null {
		return (db.prepare('SELECT * FROM media_gateway_runtime WHERE gateway_id = ?').get('primary') as GatewayRuntimeRecord) ?? null;
	}

	claimLease(input: {
		streamId: string;
		tenantId: string;
		workspaceId: string;
		channelId: string;
		ownerInstance: string;
		leaseTtlMs: number;
	}): { granted: boolean; lease?: StreamLeaseRecord; conflict?: StreamLeaseRecord } {
		const now = Date.now();
		const leaseExpiresAt = now + input.leaseTtlMs;
		const nextToken = crypto.randomBytes(18).toString('hex');

		const txn = db.transaction(() => {
			const existing = db.prepare('SELECT * FROM media_gateway_stream_leases WHERE stream_id = ?').get(input.streamId) as StreamLeaseRecord | undefined;
			if (existing && existing.lease_expires_at > now && existing.status === 'active') {
				return { granted: false as const, conflict: existing };
			}

			db.prepare(`
				INSERT INTO media_gateway_stream_leases (stream_id, tenant_id, workspace_id, channel_id, owner_instance, lease_token, lease_expires_at, status, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)
				ON CONFLICT(stream_id) DO UPDATE SET
					tenant_id = excluded.tenant_id,
					workspace_id = excluded.workspace_id,
					channel_id = excluded.channel_id,
					owner_instance = excluded.owner_instance,
					lease_token = excluded.lease_token,
					lease_expires_at = excluded.lease_expires_at,
					status = excluded.status,
					updated_at = excluded.updated_at
			`).run(
				input.streamId,
				input.tenantId,
				input.workspaceId,
				input.channelId,
				input.ownerInstance,
				nextToken,
				leaseExpiresAt,
				now
			);

			const lease = db.prepare('SELECT * FROM media_gateway_stream_leases WHERE stream_id = ?').get(input.streamId) as StreamLeaseRecord;
			return { granted: true as const, lease };
		});

		return txn();
	}

	releaseLease(streamId: string, leaseToken: string): boolean {
		const now = Date.now();
		const result = db.prepare(`
			UPDATE media_gateway_stream_leases
			SET status = 'released', updated_at = ?, lease_expires_at = ?
			WHERE stream_id = ? AND lease_token = ?
		`).run(now, now, streamId, leaseToken);
		return result.changes > 0;
	}

	countActiveLeases(now: number = Date.now()): number {
		const row = db.prepare(`
			SELECT COUNT(*) as total
			FROM media_gateway_stream_leases
			WHERE status = 'active' AND lease_expires_at > ?
		`).get(now) as { total: number };
		return row.total;
	}

	audit(input: {
		actorType: string;
		actorId: string;
		action: string;
		streamId?: string;
		workspaceId?: string;
		channelId?: string;
		metadata?: Record<string, unknown>;
	}): void {
		db.prepare(`
			INSERT INTO media_gateway_audit_log (actor_type, actor_id, action, stream_id, workspace_id, channel_id, metadata_json, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			input.actorType,
			input.actorId,
			input.action,
			input.streamId ?? null,
			input.workspaceId ?? null,
			input.channelId ?? null,
			JSON.stringify(input.metadata ?? {}),
			Date.now()
		);
	}
}

export const mediaGatewayRepository = new MediaGatewayRepository();
