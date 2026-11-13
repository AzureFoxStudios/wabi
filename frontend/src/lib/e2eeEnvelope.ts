/** The wire prefix of an experimental-encryption message envelope (e2ee.ts). Dependency-free. */
export const E2EE_MESSAGE_PREFIX = 'wabi-e2ee-v1:';

/**
 * Set on a message only by THIS client: when it decrypted (or failed to decrypt) an envelope it
 * received (e2ee.ts prepareIncomingE2eeMessage), or sent/edited one itself (messageStore). A
 * symbol key cannot come from the wire (JSON has no symbols), so a sender cannot claim it by
 * setting `encrypted: true` on a plaintext message; object spreads keep it.
 */
export const E2EE_OBSERVED: unique symbol = Symbol('wabi.e2eeObserved');

export function markE2eeObserved<T extends object>(message: T): T {
	(message as Record<symbol, unknown>)[E2EE_OBSERVED] = true;
	return message;
}

export function isE2eeObserved(message: unknown): boolean {
	return Boolean(message && typeof message === 'object' && (message as Record<symbol, unknown>)[E2EE_OBSERVED] === true);
}
