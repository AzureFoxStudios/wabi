<script lang="ts">
	import { _ } from '$lib/i18n';
	import type { Message, User } from '$lib/socket';
	import MessageContextMenu from '../MessageContextMenu.svelte';
	import ForwardDialog from '../ForwardDialog.svelte';
	import ConfirmDialog from '../ConfirmDialog.svelte';
	import ImageLightbox from '../ImageLightbox.svelte';
	import VideoLightbox from '../VideoLightbox.svelte';

	export let UserPopoutComponent: any = null;
	export let EmojiPickerComponent: any = null;
	export let BlendImportSettingsModalComponent: any = null;

	export let showUserPopout = false;
	export let popoutUser: User | null = null;
	export let popoutAnchorElement: HTMLElement | null = null;
	export let popoutIsOwnProfile = false;
	export let showReactionPicker = false;
	export let contextMenuMessage: Message | null = null;
	export let contextMenuVisible = false;
	export let contextMenuX = 0;
	export let contextMenuY = 0;
	export let showForwardDialog = false;
	export let forwardMessage: Message | null = null;
	export let showDeleteConfirm = false;
	export let messageToDelete: Message | null = null;
	export let showBlendImportSettings = false;
	export let blendImportSourcePath = '';
	export let blendImportFileName = '';
	export let blendImportSubmitting = false;
	export let enlargedImage: string | null = null;
	export let enlargedVideo: string | null = null;
	export let currentImageGallery: string[] = [];
	export let quickMentionEnabled = false;
	export let personalPinsEnabled = false;

	export let isOwnMessage: (message: Message) => boolean;
	export let canDeleteMessage: (message: Message) => boolean = (message) => isOwnMessage(message);
	export let isPersonalPinnedMessage: (messageId: string) => boolean;
	export let getDeleteConfirmMessage: (message: Message | null) => string;
	export let handleOpenFullProfile: (event: CustomEvent<any>) => void;
	export let handleReactionSelect: (event: CustomEvent<any>) => void;
	export let closeReactionPicker: () => void;
	export let handleEdit: () => void;
	export let handleDelete: () => void;
	export let handlePin: () => void;
	export let handleReply: (message?: Message) => void;
	export let handleQuickMention: (message?: Message) => void;
	export let handleTogglePersonalPin: (message?: Message) => void;
	export let handleDownload: () => void;
	export let handleAddToAlbum: () => void;
	export let handleCopyQuote: () => void;
	export let handleCopyMessageLink: () => void;
	export let handleForward: () => void;
	export let handleAddReaction: () => void;
	export let handleTranslate: () => void;
	export let confirmDeleteMessage: () => void;
	export let queueBlendImport: (event: CustomEvent<any>) => void | Promise<void>;
	export let closeEnlargedImage: () => void;
	export let closeEnlargedVideo: () => void;
</script>

{#if UserPopoutComponent}
	<svelte:component
		this={UserPopoutComponent}
		bind:isOpen={showUserPopout}
		bind:user={popoutUser}
		anchorElement={popoutAnchorElement}
		isOwnProfile={popoutIsOwnProfile}
		on:close={() => {
			showUserPopout = false;
			popoutUser = null;
			popoutAnchorElement = null;
			popoutIsOwnProfile = false;
		}}
		on:openFullProfile={handleOpenFullProfile}
	/>
{/if}

{#if showReactionPicker}
	{#if EmojiPickerComponent}
		<svelte:component
			this={EmojiPickerComponent}
			on:select={handleReactionSelect}
			on:close={closeReactionPicker}
		/>
	{:else}
		<div class="emoji-picker-loading">{$_('emoji_picker.loading')}</div>
	{/if}
{/if}

{#if contextMenuMessage}
	<MessageContextMenu
		message={contextMenuMessage}
		canManageOwnMessage={isOwnMessage(contextMenuMessage)}
		canDeleteMessage={canDeleteMessage(contextMenuMessage)}
		bind:visible={contextMenuVisible}
		x={contextMenuX}
		y={contextMenuY}
		onEdit={handleEdit}
		onDelete={handleDelete}
		onPin={handlePin}
		onReply={handleReply}
		onQuickMention={handleQuickMention}
		onTogglePersonalPin={handleTogglePersonalPin}
		onDownload={handleDownload}
		onAddToAlbum={handleAddToAlbum}
		onCopyQuote={handleCopyQuote}
		onCopyMessageLink={handleCopyMessageLink}
		onForward={handleForward}
		onAddReaction={handleAddReaction}
		onTranslate={handleTranslate}
		quickMentionEnabled={quickMentionEnabled}
		personalPinsEnabled={personalPinsEnabled}
		isPersonalPinned={isPersonalPinnedMessage(contextMenuMessage.id)}
	/>
{/if}

<ForwardDialog bind:visible={showForwardDialog} bind:message={forwardMessage} />

<ConfirmDialog
	isOpen={showDeleteConfirm}
	title={$_('messages.confirm.delete_title')}
	message={getDeleteConfirmMessage(messageToDelete)}
	confirmText={$_('messages.confirm.delete_confirm')}
	variant="danger"
	onConfirm={confirmDeleteMessage}
	onCancel={() => showDeleteConfirm = false}
/>

{#if BlendImportSettingsModalComponent}
	<svelte:component
		this={BlendImportSettingsModalComponent}
		isOpen={showBlendImportSettings}
		sourcePath={blendImportSourcePath}
		fileName={blendImportFileName}
		isSubmitting={blendImportSubmitting}
		on:close={() => {
			if (!blendImportSubmitting) showBlendImportSettings = false;
		}}
		on:submit={queueBlendImport}
	/>
{/if}

<ImageLightbox imageUrl={enlargedImage} gallery={currentImageGallery} onClose={closeEnlargedImage} />
<VideoLightbox videoUrl={enlargedVideo} onClose={closeEnlargedVideo} />
