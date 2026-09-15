/**
 * E2EE v1 is intentionally scoped to private conversations. Known shared
 * channel types must never probe the private-room endpoint. Unknown channel
 * types remain fail-closed by attempting the E2EE path instead of assuming
 * plaintext is safe.
 */
export function shouldAttemptE2eeForChannelType(channelType: string | null | undefined): boolean {
	if (!channelType) return true;
	return channelType === 'dm' || channelType === 'group';
}
