import { get } from 'svelte/store';
import { _ } from '$lib/i18n';
import type { MessageEntity } from '$lib/socket';
import type { MediaAlbumScopeType } from '$lib/api';
import { createMediaAlbum, addMediaAlbumItem } from '$lib/api';
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
	attachmentEncryption?: {
		scheme: 'dm-e2ee-v1';
		iv: string;
		mimeType?: string;
		originalSize?: number;
	};
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
	getCompressionMetadata: (file: File) => UploadVideoCompressionMetadata | undefined;
	onProgress: (pct: number) => void;
}

export interface UploadMessageSpec {
	text: string;
	type: 'file';
	options: Record<string, unknown>;
}

export async function orchestrateUpload(ctx: UploadOrchestratorContext): Promise<UploadMessageSpec> {
	const {
		files,
		channelId,
		channelType,
		dmChannelId,
		dmOtherDbUserId,
		authToken,
		messageInput,
		replyToId,
		markAsSpoiler,
		captionEntities,
		createAlbum,
		albumName,
		albumScopeType,
		albumScopeId,
		getCompressionMetadata,
		onProgress
	} = ctx;

	const dmPrivacyMode = channelType === 'dm' && dmChannelId ? null : null;
	const requiresEncrypted = channelType === 'dm' && dmPrivacyMode !== 'open';
	const canEncrypt = requiresEncrypted && !!dmOtherDbUserId && !!authToken && false;

	const totalFiles = files.length;
	let completedFiles = 0;

	const uploadedFiles: UploadedFileRecord[] = [];

	for (const file of files) {
		let uploadFile = file;
		let attachmentEncryption: UploadedFileRecord['attachmentEncryption'];
		let persistentResume = true;
		let videoCompression = getCompressionMetadata(file);

		if (canEncrypt && authToken && dmOtherDbUserId) {
			const encrypted = await null;
			if (!encrypted) {
				throw new Error(get(_)('chat.upload.e2ee_failed'));
			}
			uploadFile = encrypted.encryptedFile;
			attachmentEncryption = {
				scheme: 'dm-e2ee-v1',
				iv: encrypted.iv,
				mimeType: encrypted.mimeType,
				originalSize: encrypted.originalSize
			};
			persistentResume = false;
			videoCompression = undefined;
		}

		const result = await uploadFileResumable(
			uploadFile,
			channelId,
			(filePct) => {
				const overall = ((completedFiles + filePct / 100) / totalFiles) * 100;
				onProgress(Math.round(overall));
			},
			persistentResume,
			videoCompression
		);
		completedFiles++;

		uploadedFiles.push({
			fileUrl: result.fileUrl,
			fileName: file.name,
			fileSize: file.size,
			mimeType: file.type || null,
			attachmentStorage: result.attachmentStorage,
			attachmentEncryption
		});
	}

	let createdAlbumName: string | null = null;
	if (createAlbum && authToken && albumScopeType && albumScopeId) {
		const finalAlbumName = albumName.trim() || 'Upload';
		const album = await createMediaAlbum(authToken, {
			scopeType: albumScopeType,
			scopeId: albumScopeId,
			name: finalAlbumName
		});
		for (const f of uploadedFiles) {
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
