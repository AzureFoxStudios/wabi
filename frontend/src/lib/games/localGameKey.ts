/** UUID v4 without requiring secure-context-only crypto.randomUUID.
 * These are public game identifiers, not authentication secrets. Never fall back
 * to Math.random: fail clearly if the runtime has no secure random source.
 */
export function newLocalGameKey(source: Pick<Crypto, 'getRandomValues'> = globalThis.crypto): string {
  if (!source || typeof source.getRandomValues !== 'function') {
    throw new Error('This browser cannot create a game code. Enter a Steam AppID or an existing shared game code.');
  }
  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `local:${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
