import { _ } from '$lib/i18n';
import type { MessageEntity } from '$lib/socket';
import type { MediaAlbumScopeType } from '$lib/api';
import { createMediaAlbum, addMediaAlbumItem } from '$lib/api';
import { encryptAttachmentForChannel, type E2eeAttachmentMeta } from '$lib/e2ee';
import {
	uploadFileResumable,
	type AttachmentStorageMetadata,
	type UploadVideoCompressionMetadata
} from './uploadResumable';

export type UploadedFileRecord = {
	fileUrl: string;
	fileName: string;
	fileSize: number;
	mimeType?: string | null;
	attachmentStorage?: AttachmentStorageMetadata;
	attachmentEncryption?: E2eeAttachmentMeta;
};

export interface UploadOrchestratorContext {
	files: File[];
	channelId: string;
	channelType: string;
	dmChannelId: string | undefined;
	dmOtherDbUserId: number | null;
	authToken: string | null;
	messageInput: string;
	replyToId: string | undefined;
	markAsSpoiler: boolean;
	captionEntities: MessageEntity[];
	createAlbum: boolean;
	albumName: string;
	albumScopeType: MediaAlbumScopeType | null;
	albumScopeId: string | null;
	/** When set, files are added to this existing album instead of a new one. */
	targetAlbumId: number | null;
	getCompressionMetadata: (file: File) => UploadVideoCompressionMetadata | undefined;
	onProgress: (pct: number) => void;
	isCurrent?: () => boolean;
}

export interface UploadMessageSpec {
	text: string;
	type: 'file';
	options: Record<string, unknown>;
}

/** E2EE v1 is intentionally limited to DMs and private group conversations. */
export function channelSupportsE2eeAttachments(channelType: string): boolean {
	return channelType === 'dm' || channelType === 'group';
}

export async function orchestrateUpload(ctx: UploadOrchestratorContext): Promise<UploadMessageSpec> {
	const assertCurrent = () => { if (ctx.isCurrent && !ctx.isCurrent()) throw new Error('Upload context changed'); };
	assertCurrent();
	const {
		files,
		channelId,
		channelType,
		authToken,
		messageInput,
		replyToId,
		markAsSpoiler,
		captionEntities,
		createAlbum,
		albumName,
		albumScopeType,
		albumScopeId,
		targetAlbumId,
		getCompressionMetadata,
		onProgress
	} = ctx;

	const totalFiles = files.length;
	let completedFiles = 0;
	const uploadedFiles: UploadedFileRecord[] = [];
	let e2eeUpload = false;
	const e2eeEligible = channelSupportsE2eeAttachments(channelType);

	for (const file of files) {
		assertCurrent();
		let uploadFile = file;
		let attachmentEncryption: E2eeAttachmentMeta | undefined;
		let persistentResume = true;
		let videoCompression = getCompressionMetadata(file);

		// E2EE status is meaningful only for DMs/private group conversations.
		// Shared/public channels must never be forced through the private-room
		// status endpoint: that endpoint deliberately rejects non-conversations.
		// For eligible conversations we remain fail-closed — an E2EE/status error
		// aborts rather than quietly uploading plaintext.
		if (e2eeEligible) {
			const encrypted = await encryptAttachmentForChannel(channelId, file);
			if (encrypted) {
				e2eeUpload = true;
				uploadFile = encrypted.file;
				attachmentEncryption = encrypted.metadata;
				persistentResume = false;
				// Video transcode/thumbnail helpers require plaintext and therefore do
				// not run on operator-blind attachments.
				videoCompression = undefined;
			}
		}

		const result = await uploadFileResumable(
			uploadFile,
			channelId,
			(filePct) => {
				const overall = ((completedFiles + filePct / 100) / totalFiles) * 100;
				onProgress(Math.round(overall));
			},
			persistentResume,
			videoCompression,
			ctx.isCurrent
		);
		assertCurrent();
		completedFiles++;

		// Original filename/MIME/size live only inside the encrypted message
		// payload when E2EE is active. The upload endpoint already saw only the
		// opaque encrypted File above.
		uploadedFiles.push({
			fileUrl: result.fileUrl,
			fileName: file.name,
			fileSize: file.size,
			mimeType: file.type || null,
			attachmentStorage: result.attachmentStorage,
			attachmentEncryption
		});
	}

	// Albums are server-side indexes containing attachment names/captions. Do
	// not quietly punch a metadata hole through E2EE; encrypted albums can be a
	// separate feature later.
	if (e2eeUpload && createAlbum) {
		throw new Error('Shared albums are not available inside an E2EE conversation because the current album index is server-readable.');
	}

	let createdAlbumName: string | null = null;
	if (createAlbum && authToken && albumScopeType && albumScopeId) {
		assertCurrent();
		if (targetAlbumId != null) {
			for (const f of uploadedFiles) {
				assertCurrent();
				await addMediaAlbumItem(authToken, targetAlbumId, {
					attachmentUrl: f.fileUrl,
					attachmentName: f.fileName,
					attachmentSize: f.fileSize,
					attachmentMime: f.mimeType,
					caption: messageInput || null
				});
			}
		} else {
			const finalAlbumName = albumName.trim() || 'Upload';
			const album = await createMediaAlbum(authToken, {
				scopeType: albumScopeType,
				scopeId: albumScopeId,
				name: finalAlbumName
			});
			for (const f of uploadedFiles) {
				assertCurrent();
				await addMediaAlbumItem(authToken, album.id, {
					attachmentUrl: f.fileUrl,
					attachmentName: f.fileName,
					attachmentSize: f.fileSize,
					attachmentMime: f.mimeType,
					caption: messageInput || null
				});
			}
			createdAlbumName = album.name;
		}
	}
	assertCurrent();

	if (uploadedFiles.length === 1) {
		const f = uploadedFiles[0];
		return {
			text: messageInput || `Shared: ${f.fileName}`,
			type: 'file',
			options: {
				fileUrl: f.fileUrl,
				fileName: f.fileName,
				fileSize: f.fileSize,
				attachmentStorage: f.attachmentStorage,
				attachmentEncryption: f.attachmentEncryption,
				replyTo: replyToId,
				isSpoiler: markAsSpoiler,
				entities: captionEntities
			}
		};
	}

	const fallbackText = createdAlbumName
		? `Shared ${uploadedFiles.length} photos in album "${createdAlbumName}"`
		: `Shared ${uploadedFiles.length} files`;

	return {
		text: messageInput || fallbackText,
		type: 'file',
		options: {
			files: uploadedFiles,
			replyTo: replyToId,
			isSpoiler: markAsSpoiler,
			entities: captionEntities
		}
	};
}
