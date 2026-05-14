import { browser } from '$app/environment';
import { getServerUrl } from '$lib/serverUrl';
import { getAuthToken, getGuestSessionId } from '$lib/authSession';
import type { VideoCompressionFailureCode, VideoCompressionPresetId } from './videoCompressor';
import type { VideoCompressionRuntime } from './videoCompressionSettings';

export type VideoCompressionTelemetryOutcome = 'success' | 'failure' | 'cancelled' | 'skipped';

export interface VideoCompressionTelemetryEvent {
	outcome: VideoCompressionTelemetryOutcome;
	runtime: VideoCompressionRuntime;
	preset: VideoCompressionPresetId;
	inputBytes: number;
	outputBytes?: number | null;
	durationMs?: number | null;
	failureCode?: VideoCompressionFailureCode | string | null;
}

const VIDEO_COMPRESSION_CLIENT_METRICS_ENABLED =
	typeof import.meta.env.VITE_VIDEO_COMPRESSION_CLIENT_METRICS === 'string' &&
	import.meta.env.VITE_VIDEO_COMPRESSION_CLIENT_METRICS.trim().toLowerCase() === 'true';

function getTelemetryAuthHeaders(): Record<string, string> {
	const headers: Record<string, string> = {};
	if (!browser) return headers;
	const token = getAuthToken();
	if (token) {
		headers.Authorization = `Bearer ${token}`;
		return headers;
	}
	const sessionId = getGuestSessionId();
	if (sessionId) {
		headers['X-Session-Id'] = sessionId;
	}
	return headers;
}

export async function reportVideoCompressionTelemetry(
	event: VideoCompressionTelemetryEvent
): Promise<void> {
	if (!browser) return;
	if (!VIDEO_COMPRESSION_CLIENT_METRICS_ENABLED) return;
	if (!Number.isFinite(event.inputBytes) || event.inputBytes <= 0) return;

	const outputBytes =
		event.outputBytes !== undefined && event.outputBytes !== null && Number.isFinite(event.outputBytes)
			? Math.max(0, Math.round(event.outputBytes))
			: null;
	const durationMs =
		event.durationMs !== undefined && event.durationMs !== null && Number.isFinite(event.durationMs)
			? Math.max(0, Math.round(event.durationMs))
			: null;

	try {
		await fetch(`${getServerUrl()}/api/telemetry/video-compression`, {
			method: 'POST',
			headers: {
				...getTelemetryAuthHeaders(),
				'Content-Type': 'application/json'
			},
			credentials: 'include',
			body: JSON.stringify({
				outcome: event.outcome,
				runtime: event.runtime,
				preset: event.preset,
				inputBytes: Math.round(event.inputBytes),
				outputBytes,
				durationMs,
				failureCode: event.failureCode || null
			}),
			keepalive: true
		});
	} catch {
		// best-effort telemetry
	}
}
