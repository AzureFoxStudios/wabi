/**
 * optionalEndpoints.ts
 *
 * Helpers for "optional" backend endpoints that may not be implemented on a
 * given server (e.g. after a fresh wabidb reset, or on a minimal deployment).
 *
 * Behavior:
 * - The first request to an optional endpoint probes the server.
 * - If it returns 404 (or another non-2xx / network failure), the endpoint is
 *   remembered as unsupported and subsequent calls short-circuit to the
 *   caller-provided default WITHOUT emitting a network request. This stops the
 *   browser console from being spammed with repeated 404s and guarantees the
 *   caller always receives a graceful default (never throws, never console.error).
 */

const unsupported = new Set<string>();

export function markEndpointUnsupported(key: string): void {
	unsupported.add(key);
}

export function isEndpointUnsupported(key: string): boolean {
	return unsupported.has(key);
}

export function clearEndpointSupportCache(): void {
	unsupported.clear();
}

