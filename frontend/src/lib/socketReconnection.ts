/**
 * socketReconnection.ts
 * Socket reconnection, failover, and heartbeat logic
 *
 * Extracted from socketConnection.ts for single responsibility.
 * Manages:
 * - Reconnection scheduling with exponential backoff
 * - Failover endpoint rotation and candidate management
 * - Heartbeat/keepalive monitoring
 */

// ============================================================================
// RECONNECTION CONFIG
// ============================================================================

export const RECONNECTION_CONFIG = {
	maxAttempts: 10,
	baseDelayMs: 1000,
	maxDelayMs: 30000,
	jitterMs: 1000,
	timeoutMs: 20000
};

export const HEARTBEAT_CONFIG = {
	intervalMs: 25000,
	timeoutMs: 35000
};

// ============================================================================
// RECONNECTION UTILS
// ============================================================================

export function calculateBackoffDelay(
	attempt: number,
	baseDelay: number = RECONNECTION_CONFIG.baseDelayMs,
	maxDelay: number = RECONNECTION_CONFIG.maxDelayMs,
	jitter: number = RECONNECTION_CONFIG.jitterMs
): number {
	// Exponential backoff: 1s, 2s, 4s, 8s, ... capped at maxDelay
	const exponential = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
	const jitterValue = Math.random() * jitter;
	return exponential + jitterValue;
}

export function shouldRetryAfterFailure(
	errorMessage: string,
	attempt: number,
	maxAttempts: number = RECONNECTION_CONFIG.maxAttempts
): boolean {
	// Don't retry on fatal errors (auth, forbidden, etc)
	const lower = (errorMessage || '').toLowerCase();
	if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('invalid token')) {
		return false;
	}
	if (lower.includes('403') || lower.includes('forbidden')) {
		return false;
	}
	if (lower.includes('404')) {
		return false;
	}

	// Retry on transient errors, but respect max attempts
	return attempt < maxAttempts;
}

// ============================================================================
// FAILOVER UTILS
// ============================================================================

export function rotateFailoverCandidates(
	candidates: string[],
	currentIndex: number
): { nextUrl: string | null; nextIndex: number } {
	if (candidates.length === 0) {
		return { nextUrl: null, nextIndex: 0 };
	}

	const nextIndex = (currentIndex + 1) % candidates.length;
	return { nextUrl: candidates[nextIndex], nextIndex };
}

export function filterLocalCandidates(
	candidates: string[],
	isLocalUrl: (url: string) => boolean
): { local: string[]; remote: string[] } {
	return {
		local: candidates.filter(isLocalUrl),
		remote: candidates.filter(url => !isLocalUrl(url))
	};
}

export function prioritizeCandidates(
	candidates: string[],
	currentUrl: string | null,
	isLocalUrl: (url: string) => boolean
): string[] {
	// Prioritization: current > local > remote > others
	const local = candidates.filter(isLocalUrl);
	const remote = candidates.filter(url => !isLocalUrl(url));

	const result: string[] = [];

	// Add current URL first if it exists in candidates
	if (currentUrl && candidates.includes(currentUrl)) {
		result.push(currentUrl);
	}

	// Add remaining local candidates
	local.forEach(url => {
		if (url !== currentUrl && !result.includes(url)) {
			result.push(url);
		}
	});

	// Add remote candidates
	remote.forEach(url => {
		if (!result.includes(url)) {
			result.push(url);
		}
	});

	return result;
}

// ============================================================================
// HEARTBEAT UTILS
// ============================================================================

export function isHeartbeatStale(lastPongTime: number, timeoutMs: number = HEARTBEAT_CONFIG.timeoutMs): boolean {
	return Date.now() - lastPongTime > timeoutMs;
}
