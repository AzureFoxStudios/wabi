export async function emojiUploadError(response: Pick<Response, 'status' | 'json'>): Promise<string> {
	try {
		const body = await response.json();
		if (body && typeof body.error === 'string' && body.error.trim()) return body.error;
	} catch {
		// Proxies and older servers may return plain text or an empty body.
	}
	return `Upload failed (${response.status}). Please try again.`;
}

export function emojiUploadFailureMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'Upload failed. Please try again.';
}
