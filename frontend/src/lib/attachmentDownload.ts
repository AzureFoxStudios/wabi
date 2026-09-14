import type { AttachmentEncryptionMeta } from '../../../packages/wabi-protocol/src';
import type { E2eeAttachmentMeta } from './e2ee';

export function isE2eeAttachmentMetadata(
	metadata: AttachmentEncryptionMeta | null | undefined
): metadata is AttachmentEncryptionMeta & { scheme: 'dm-e2ee-v1' } {
	return metadata?.scheme === 'dm-e2ee-v1';
}

export function hasCompleteE2eeAttachmentMetadata(
	metadata: AttachmentEncryptionMeta | null | undefined
): metadata is E2eeAttachmentMeta {
	if (!isE2eeAttachmentMetadata(metadata)) return false;
	return Number(metadata.epoch || 0) > 0 &&
		Number(metadata.originalSize || 0) > 0 &&
		Number(metadata.chunkSize || 0) > 0 &&
		Boolean(String(metadata.noncePrefix || metadata.iv || '').trim()) &&
		Boolean(String(metadata.fileId || '').trim());
}

export async function resolveAttachmentDownloadBlob(
	channelId: string,
	response: Response,
	metadata?: AttachmentEncryptionMeta | null
): Promise<Blob> {
	if (!response.ok) throw new Error(`Failed to download attachment (${response.status})`);
	const blob = await response.blob();
	if (!isE2eeAttachmentMetadata(metadata)) return blob;
	if (!hasCompleteE2eeAttachmentMetadata(metadata)) {
		throw new Error('Encrypted attachment metadata is incomplete.');
	}
	const { decryptAttachmentBlob } = await import('./e2ee');
	return decryptAttachmentBlob(channelId, blob, metadata);
}

export function saveAttachmentBlob(blob: Blob, fileName: string): void {
	const url = window.URL.createObjectURL(blob);
	const link = document.createElement('a');
	link.href = url;
	link.download = fileName;
	document.body.appendChild(link);
	link.click();
	document.body.removeChild(link);
	window.URL.revokeObjectURL(url);
}
