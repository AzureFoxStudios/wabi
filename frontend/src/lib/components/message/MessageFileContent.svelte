<script lang="ts">
	import type { Message, FileAttachment } from '$lib/socket';
	import { displayEnhancementSettingsStore } from '$lib/displayEnhancements';
	import { _ } from '$lib/i18n';
	import { parseMessage } from '$lib/markdown';
	import ModelViewerLauncher from '../ModelViewerLauncher.svelte';
	import ZipPreviewPanel from '../ZipPreviewPanel.svelte';
	import { getServerUrl } from '$lib/serverUrl';
	import { getRelayFileUrl, relayEnabled } from '$lib/relaySelector';
	import { activeServerSpoilAll, activeServerUnspoilAll } from '$lib/serverSettings';
	import {
		formatFileSize,
		getFileIcon,
		isAudio,
		isBlendFile,
		getMediaMimeType,
		isEncryptedAttachment,
		isImage,
		isModelFile,
		isVideo,
		isZipFile,
		type AlbumAnnouncement
	} from './messageItemUtils';

	export let message: Message;
	export let forceSpoiler = false;

	// A spoiler channel, the active server's "spoiler all", or the user's
	// global "Spoiler All Messages" setting forces every message to render
	// spoiled. A server "unspoil all" override wins and reveals everything.
	$: effectiveSpoiler = $activeServerUnspoilAll
		? false
		: (message.isSpoiler || forceSpoiler || $activeServerSpoilAll || $displayEnhancementSettingsStore.spoilerAllMessagesEnabled);
	let spoilerRevealed = false;
	$: mediaIsSpoiled = effectiveSpoiler && !spoilerRevealed;
	$: if (!effectiveSpoiler) spoilerRevealed = false;
	export let albumAnnouncement: AlbumAnnouncement | null;
	export let albumAnnouncementUploadName: string | null;
	export let onHandleAlbumActivate: (meta: any, hasFiles: boolean) => void;
	export let onHandleAlbumAnnouncementKeydown: (event: KeyboardEvent, meta: any, hasFiles: boolean) => void;
	export let onTriggerAlbumUpload: (meta: any) => void;
	export let onOpenAlbumPanel: () => void;
	export let onOpenAlbumPreview: (message: Message, fileAttachment: FileAttachment) => void;
	export let onEnlargeImage: (url: string, gallery?: string[]) => void;
	export let onEnlargeVideo: (url: string) => void;
	export let onOpenModelInDedicatedTab: (src: string, fileName: string) => void;
	export let onOpenBlendImportSettings: (sourcePath: string, fileName: string) => void;
	export let onDownloadAttachment: (fileUrl: string, fileName: string, encryption?: any) => void;
	export let onImageContextMenu: (event: MouseEvent, message: Message) => void;

	function getFileUrl(fileUrl?: string): string {
		if (!fileUrl) return '';
		if (fileUrl.startsWith('data:')) return fileUrl;
		if (fileUrl.startsWith('http:') || fileUrl.startsWith('https:')) {
			try {
				const absoluteUrl = new URL(fileUrl);
				const isLocalUpload =
					(absoluteUrl.hostname === 'localhost' || absoluteUrl.hostname === '127.0.0.1') &&
					absoluteUrl.pathname.startsWith('/uploads/');
				if (isLocalUpload) {
					const normalizedPath = `${absoluteUrl.pathname}${absoluteUrl.search}${absoluteUrl.hash}`;
					return $relayEnabled ? getRelayFileUrl(normalizedPath) : `${getServerUrl()}${normalizedPath}`;
				}
			} catch {
				// Keep original URL when parsing fails.
			}
			return fileUrl;
		}
		return $relayEnabled ? getRelayFileUrl(fileUrl) : `${getServerUrl()}${fileUrl}`;
	}

	function getAlbumAnnouncementStatusLabel(meta: { name: string }, itemCount = 0): string {
		if (albumAnnouncementUploadName === meta.name) return 'Uploading';
		return itemCount > 0 ? `${itemCount} items` : 'Click to upload';
	}

	function getAlbumAnnouncementSupportText(meta: { name: string }, itemCount = 0): string {
		if (albumAnnouncementUploadName === meta.name) return 'Uploading files into this shared album now.';
		if (itemCount > 0) return 'Open Albums to browse this shared album or add more files.';
		return 'Click anywhere on this row to add the first image, or open Albums to manage it.';
	}
</script>

{#if message.type === 'file' && (message.fileUrl || message.files)}
					{#if albumAnnouncement && message.files}
						{@const albumPreviewFiles = message.files
							.filter((fileAttachment) => {
								if (!fileAttachment?.fileUrl || !fileAttachment?.fileName) return false;
								if (isEncryptedAttachment(fileAttachment)) return false;
								return isImage(fileAttachment.fileName) || isVideo(fileAttachment.fileName);
							})
							.slice(0, 4)}
						<div
							class="album-message-card album-message-card--actionable"
							role="button"
							tabindex="0"
							on:click={() => onHandleAlbumActivate(albumAnnouncement, true)}
							on:keydown={(event) => onHandleAlbumAnnouncementKeydown(event, albumAnnouncement, true)}
						>
							<div class="album-message-main">
								<div class="album-message-head">
									<div class="album-message-copy">
										<div class="album-message-kicker">Shared album</div>
										<div class="album-message-title">{albumAnnouncement.name}</div>
									</div>
									<span class="album-message-count">{getAlbumAnnouncementStatusLabel(albumAnnouncement, message.files.length)}</span>
								</div>
								{#if albumPreviewFiles.length > 0}
									<div class="album-message-grid">
										{#each albumPreviewFiles as fileAttachment}
											<button
												type="button"
												class="album-message-tile"
												on:click|stopPropagation={() => onOpenAlbumPreview(message, fileAttachment)}
												title={fileAttachment.fileName}
											>
												{#if isVideo(fileAttachment.fileName)}
													<video muted playsinline preload="metadata">
														<source src={getFileUrl(fileAttachment.fileUrl)} />
													</video>
												{:else}
													<img
														src={getFileUrl(fileAttachment.fileUrl)}
														alt={fileAttachment.fileName}
														loading="lazy"
														decoding="async"
													/>
												{/if}
											</button>
										{/each}
									</div>
								{:else}
									<div class="album-message-empty">
										{getAlbumAnnouncementSupportText(albumAnnouncement, message.files.length)}
									</div>
								{/if}
							</div>
							<div class="album-message-actions">
								<button
									type="button"
									class="album-message-btn"
									disabled={albumAnnouncementUploadName === albumAnnouncement.name}
									on:click|stopPropagation={() => onTriggerAlbumUpload(albumAnnouncement)}
								>
									{albumAnnouncementUploadName === albumAnnouncement.name ? 'Uploading...' : 'Add Media'}
								</button>
								<button type="button" class="album-message-btn primary" on:click|stopPropagation={onOpenAlbumPanel}>
									Open Album
								</button>
								{#if albumPreviewFiles.length > 0}
									<button
										type="button"
										class="album-message-btn"
										on:click|stopPropagation={() => onOpenAlbumPreview(message, albumPreviewFiles[0])}
									>
										Preview
									</button>
								{/if}
							</div>
						</div>
					{:else if message.files && message.files.length > 1}
						<!-- Multiple files gallery -->
						<div class="files-gallery" class:has-more={message.files.length > 4}>
							{#each message.files.slice(0, 4) as fileAttachment, index}
								{#if isImage(fileAttachment.fileName) && !isEncryptedAttachment(fileAttachment)}
									<!-- svelte-ignore a11y-click-events-have-key-events -->
									<!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
									<div class="gallery-file-item" class:last-item={index === 3 && message.files.length > 4}>
										<img
											src={getFileUrl(fileAttachment.fileUrl)}
											alt={fileAttachment.fileName}
											class="gallery-file-image {mediaIsSpoiled ? 'spoiler' : ''}"
											data-spoiler={mediaIsSpoiled ? 'true' : 'false'}
											on:click={(e) => {
												if (e.button === 0) {
													const imageGallery = message.files
														.filter(f => isImage(f.fileName))
														.map(f => getFileUrl(f.fileUrl));
													onEnlargeImage(getFileUrl(fileAttachment.fileUrl), imageGallery);
												}
											}}
											title={$_('messages.media.click_enlarge')}
										/>
										{#if index === 3 && message.files.length > 4}
											<div class="more-overlay">
												<span class="more-count">+{message.files.length - 4}</span>
											</div>
										{/if}
									</div>
									{:else if isVideo(fileAttachment.fileName) && !isEncryptedAttachment(fileAttachment)}
									<!-- svelte-ignore a11y-media-has-caption -->
									<!-- svelte-ignore a11y-click-events-have-key-events -->
									<!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
									<div class="gallery-file-item" class:last-item={index === 3 && message.files.length > 4}>
										<video
											class="gallery-file-video {mediaIsSpoiled ? 'spoiler' : ''}"
											data-spoiler={mediaIsSpoiled ? 'true' : 'false'}
											on:click={(e) => {
												if (e.button !== 0) return;
												if (mediaIsSpoiled) { spoilerRevealed = true; return; }
												onEnlargeVideo(getFileUrl(fileAttachment.fileUrl));
											}}
											title={$_('messages.media.click_enlarge')}
										>
											<source src={getFileUrl(fileAttachment.fileUrl)} />
										</video>
										{#if index === 3 && message.files.length > 4}
											<div class="more-overlay">
												<span class="more-count">+{message.files.length - 4}</span>
											</div>
										{/if}
									</div>
								{:else if isAudio(fileAttachment.fileName) && !isEncryptedAttachment(fileAttachment)}
									<!-- svelte-ignore a11y-media-has-caption -->
									<div class="gallery-file-item audio-item" class:last-item={index === 3 && message.files.length > 4}>
										<audio
											controls
											class="gallery-file-audio"
										>
											<source src={getFileUrl(fileAttachment.fileUrl)} type={getMediaMimeType(fileAttachment.fileName) || undefined} />
											{$_('messages.media.audio_not_supported')}
										</audio>
										<div class="audio-file-name">{fileAttachment.fileName}</div>
										{#if index === 3 && message.files.length > 4}
											<div class="more-overlay">
												<span class="more-count">+{message.files.length - 4}</span>
											</div>
										{/if}
									</div>
								{:else if isModelFile(fileAttachment.fileName) && !isEncryptedAttachment(fileAttachment)}
									<div class="gallery-file-item model-item" class:last-item={index === 3 && message.files.length > 4}>
										<ModelViewerLauncher src={getFileUrl(fileAttachment.fileUrl)} fileName={fileAttachment.fileName || $_('messages.media.model_fallback_name')} height={220} />
										<button
											class="open-viewport-btn"
											on:click={() => onOpenModelInDedicatedTab(getFileUrl(fileAttachment.fileUrl), fileAttachment.fileName || $_('messages.media.model_fallback_name'))}
										>
											{$_('messages.media.open_3d_tab')}
										</button>
										<a href={getFileUrl(fileAttachment.fileUrl)} target="_blank" rel="noopener noreferrer" download={fileAttachment.fileName} class="image-download-link">
											<span class="file-icon">{getFileIcon(fileAttachment.fileName)}</span>
											{fileAttachment.fileName}
											<span class="file-size-small">({formatFileSize(fileAttachment.fileSize)})</span>
										</a>
										{#if index === 3 && message.files.length > 4}
											<div class="more-overlay">
												<span class="more-count">+{message.files.length - 4}</span>
											</div>
										{/if}
									</div>
								{:else if isBlendFile(fileAttachment.fileName)}
									<div class="gallery-file-item blend-item" class:last-item={index === 3 && message.files.length > 4}>
										<div class="gallery-file-icon-large">{getFileIcon(fileAttachment.fileName)}</div>
										<div class="gallery-file-overlay">
											<span class="file-name-truncate">{fileAttachment.fileName}</span>
											<span class="file-size-small">({formatFileSize(fileAttachment.fileSize)})</span>
										</div>
										<div class="blend-actions">
											<button class="blend-import-btn" on:click={() => onOpenBlendImportSettings(fileAttachment.fileUrl, fileAttachment.fileName)}>
												{$_('messages.blend.import_settings')}
											</button>
										</div>
										{#if index === 3 && message.files.length > 4}
											<div class="more-overlay">
												<span class="more-count">+{message.files.length - 4}</span>
											</div>
										{/if}
									</div>
								{:else}
									<a
										href={getFileUrl(fileAttachment.fileUrl)}
										target="_blank"
										rel="noopener noreferrer"
										download={fileAttachment.fileName}
										class="gallery-file-item file-link"
										on:click|preventDefault={() => onDownloadAttachment(fileAttachment.fileUrl, fileAttachment.fileName, fileAttachment.attachmentEncryption)}
									>
										<div class="gallery-file-icon-large">{getFileIcon(fileAttachment.fileName)}</div>
										<div class="gallery-file-overlay">
											<span class="file-name-truncate">{fileAttachment.fileName}</span>
											<span class="file-size-small">({formatFileSize(fileAttachment.fileSize)})</span>
											{#if isEncryptedAttachment(fileAttachment)}
												<span class="file-size-small">(encrypted)</span>
											{/if}
										</div>
									</a>
								{/if}
							{/each}
						</div>
						{@const zipFiles = message.files.filter((fileAttachment) => isZipFile(fileAttachment.fileName))}
						{#if zipFiles.length > 0}
							<div class="multi-zip-previews">
								{#each zipFiles as zipFile}
									<ZipPreviewPanel
										fileUrl={getFileUrl(zipFile.fileUrl)}
										fileName={zipFile.fileName || 'archive.zip'}
										fileSize={zipFile.fileSize}
										encrypted={isEncryptedAttachment(zipFile)}
									/>
								{/each}
							</div>
						{/if}
					{:else if message.fileUrl}
						{#if isModelFile(message.fileName) && !isEncryptedAttachment(message)}
						<div class="model-container">
							<ModelViewerLauncher src={getFileUrl(message.fileUrl)} fileName={message.fileName || $_('messages.media.model_fallback_name')} />
							<button
								class="open-viewport-btn"
								on:click={() => message.fileUrl && onOpenModelInDedicatedTab(getFileUrl(message.fileUrl), message.fileName || $_('messages.media.model_fallback_name'))}
							>
								{$_('messages.media.open_3d_tab')}
							</button>
							<a href={getFileUrl(message.fileUrl)} target="_blank" rel="noopener noreferrer" download={message.fileName} class="image-download-link">
								<span class="file-icon">{getFileIcon(message.fileName)}</span>
								{message.fileName}
								<span class="file-size">({formatFileSize(message.fileSize)})</span>
							</a>
						</div>
						{:else if isImage(message.fileName) && !isEncryptedAttachment(message)}
						<!-- Display image inline -->
						<div class="image-container">
							<!-- svelte-ignore a11y-click-events-have-key-events -->
							<!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
							<img
								src={getFileUrl(message.fileUrl)}
								alt={message.fileName}
								class="inline-image {mediaIsSpoiled ? 'spoiler' : ''}"
								data-spoiler={mediaIsSpoiled ? 'true' : 'false'}
								on:click={(e) => {
									if (e.button !== 0 || !message.fileUrl) return;
									if (mediaIsSpoiled) { spoilerRevealed = true; return; }
									onEnlargeImage(getFileUrl(message.fileUrl));
								}}
								on:contextmenu={(e) => onImageContextMenu(e, message)}
								title={$_('messages.media.click_enlarge_with_options')}
							/>
							<a href={getFileUrl(message.fileUrl)} target="_blank" rel="noopener noreferrer" download={message.fileName} class="image-download-link">
								<span class="file-icon">{getFileIcon(message.fileName)}</span>
								{message.fileName}
								<span class="file-size">({formatFileSize(message.fileSize)})</span>
							</a>
						</div>
					{:else if isVideo(message.fileName) && !isEncryptedAttachment(message)}
						<!-- Display video with player -->
						<div class="video-container">
							<!-- svelte-ignore a11y-media-has-caption -->
							<!-- svelte-ignore a11y-click-events-have-key-events -->
							<!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
							<video
								controls
								class="inline-video {mediaIsSpoiled ? 'spoiler' : ''}"
								data-spoiler={mediaIsSpoiled ? 'true' : 'false'}
								on:click={(e) => {
									if (e.button === 0 && message.fileUrl) {
										if (mediaIsSpoiled) { spoilerRevealed = true; return; }
										onEnlargeVideo(getFileUrl(message.fileUrl));
									}
								}}
								on:contextmenu={(e) => onImageContextMenu(e, message)}
								title={$_('messages.media.click_enlarge_with_options')}
							>
								<source src={getFileUrl(message.fileUrl)} type={getMediaMimeType(message.fileName) || undefined} />
								{$_('messages.viewer.video_not_supported')}
							</video>
							<a href={getFileUrl(message.fileUrl)} target="_blank" rel="noopener noreferrer" download={message.fileName} class="video-download-link">
								<span class="file-icon">{getFileIcon(message.fileName)}</span>
								{message.fileName}
								<span class="file-size">({formatFileSize(message.fileSize)})</span>
							</a>
						</div>
					{:else if isAudio(message.fileName) && !isEncryptedAttachment(message)}
						<!-- Display audio with player -->
						<div class="audio-container">
							<!-- svelte-ignore a11y-media-has-caption -->
							<audio
								controls
								class="inline-audio"
							>
								<source src={getFileUrl(message.fileUrl)} type={getMediaMimeType(message.fileName) || undefined} />
								{$_('messages.media.audio_not_supported')}
							</audio>
							<div class="audio-file-info">
								<span class="file-icon">{getFileIcon(message.fileName)}</span>
								{message.fileName}
								<span class="file-size">({formatFileSize(message.fileSize)})</span>
							</div>
						</div>
					{:else if isBlendFile(message.fileName) && !isEncryptedAttachment(message)}
						<div class="blend-file-card">
							<div class="blend-file-head">
								<span class="file-icon">{getFileIcon(message.fileName)}</span>
								<div class="file-info">
									<span class="file-name">{message.fileName}</span>
									<span class="file-size">{formatFileSize(message.fileSize)}</span>
								</div>
							</div>
							<div class="blend-file-actions">
								<button class="blend-import-btn" on:click={() => message.fileUrl && message.fileName && onOpenBlendImportSettings(message.fileUrl, message.fileName)}>
									{$_('messages.blend.import_settings')}
								</button>
								<button class="blend-download-btn" on:click={() => message.fileUrl && message.fileName && onDownloadAttachment(message.fileUrl, message.fileName, message.attachmentEncryption)}>
									{$_('messages.blend.download')}
								</button>
							</div>
						</div>
					{:else}
						<!-- Display other files as download link -->
						<a
							href={getFileUrl(message.fileUrl)}
							target="_blank"
							rel="noopener noreferrer"
							download={message.fileName}
							class="file-attachment"
							on:click|preventDefault={() => message.fileUrl && message.fileName && onDownloadAttachment(message.fileUrl, message.fileName, message.attachmentEncryption)}
						>
							<span class="file-icon">{getFileIcon(message.fileName)}</span>
							<div class="file-info">
								<span class="file-name">{message.fileName}</span>
								<span class="file-size">{formatFileSize(message.fileSize)}{message.attachmentEncryption ? ` (${$_('messages.encrypted')})` : ''}</span>
							</div>
						</a>
						{#if isZipFile(message.fileName)}
							<ZipPreviewPanel
								fileUrl={getFileUrl(message.fileUrl)}
								fileName={message.fileName || 'archive.zip'}
								fileSize={message.fileSize}
								encrypted={isEncryptedAttachment(message)}
							/>
						{/if}
					{/if}
					{/if}
{/if}
