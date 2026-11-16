<!--
	Chat background (design contract §8.9): the one picker. A scene (none, your own image or
	video, or an animated scene) with its own controls underneath.

	Data stays where it always was, so older saves keep working:
	- scene, motion, darken and frost: `wabi.chatBackdrop` in this browser (theme/chatBackdrop.ts);
	- the uploaded image and its fit: the top-level `background_image` preference, saved to the
	  account when signed in (themeStore.persistBackgroundImageSetting). A legacy
	  `customTheme.backgroundImage` is still read as a fallback and never deleted here.
-->
<script lang="ts">
	import { _ } from '$lib/i18n';
	import { onDestroy } from 'svelte';
	import { get } from 'svelte/store';
	import {
		themeStore,
		backgroundImageSetting,
		loadBackgroundImageSetting,
		persistBackgroundImageSetting
	} from '$lib/theme/themeStore';
	import { applyBackgroundImageVars, resolveThemeBackground } from '$lib/theme/themeManager';
	import {
		defaultChatBackdropSettings,
		loadChatBackdropSettings,
		saveChatBackdropSettings,
		type ChatBackdropScene,
		type ChatBackdropSettings as BackdropSettings
	} from '$lib/theme/chatBackdrop';
	import type { BackgroundImage } from '../../../types/theme';
	import { getAuthToken } from '$lib/authSession';
	import { getServerUrl } from '$lib/serverUrl';
	import ChatBackdrop from '../chat/ChatBackdrop.svelte';
	import Icon from '../ui/Icon.svelte';
	import Select from '../ui/Select.svelte';
	import Segmented from '../ui/Segmented.svelte';

	type ImageSize = NonNullable<BackgroundImage['size']>;
	type ImageRepeat = NonNullable<BackgroundImage['repeat']>;

	const VIDEO_EXT_RE = /\.(mp4|webm|mov)(\?|$)/i;
	const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
	const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,video/mp4,video/webm,video/quicktime';

	const sceneOptions: Array<{ value: ChatBackdropScene; label: string }> = [
		{ value: 'none', label: $_('chat_bg.scene_none') },
		{ value: 'image', label: $_('chat_bg.scene_image') },
		{ value: 'ink', label: $_('chat_bg.scene_ink') },
		{ value: 'dusk', label: $_('chat_bg.scene_dusk') },
		{ value: 'fireflies', label: $_('chat_bg.scene_fireflies') },
		{ value: 'koi', label: $_('chat_bg.scene_koi') }
	];
	const sizeOptions: Array<{ value: ImageSize; label: string }> = [
		{ value: 'cover', label: $_('chat_bg.size_fill') },
		{ value: 'contain', label: $_('chat_bg.size_fit') },
		{ value: 'auto', label: $_('chat_bg.size_original') }
	];
	const positionOptions = [
		['center', $_('chat_bg.pos_center')],
		['top', $_('chat_bg.pos_top')],
		['bottom', $_('chat_bg.pos_bottom')],
		['left', $_('chat_bg.pos_left')],
		['right', $_('chat_bg.pos_right')],
		['top-left', $_('chat_bg.pos_top_left')],
		['top-right', $_('chat_bg.pos_top_right')],
		['bottom-left', $_('chat_bg.pos_bottom_left')],
		['bottom-right', $_('chat_bg.pos_bottom_right')]
	].map(([value, label]) => ({ value, label }));
	const repeatOptions: Array<{ value: ImageRepeat; label: string }> = [
		{ value: 'no-repeat', label: $_('chat_bg.repeat_once') },
		{ value: 'repeat', label: $_('chat_bg.repeat_tile') },
		{ value: 'repeat-x', label: $_('chat_bg.repeat_across') },
		{ value: 'repeat-y', label: $_('chat_bg.repeat_down') }
	];
	const blendOptions = ['normal', 'overlay', 'multiply', 'screen', 'darken', 'lighten', 'color-dodge', 'color-burn'].map(
		(value) => ({ value, label: value === 'normal' ? $_('chat_bg.blend_normal') : value.charAt(0).toUpperCase() + value.slice(1).replace('-', ' ') })
	);

	let settings: BackdropSettings = { ...defaultChatBackdropSettings };
	let backgroundImage: BackgroundImage | null = null;
	let opacity = 30;
	let blur = 0;
	let size: ImageSize = 'cover';
	let position = 'center';
	let repeat: ImageRepeat = 'no-repeat';
	let blend = 'overlay';
	let isUploading = false;
	let uploadError = '';
	let saveError = '';
	let showMoreImageOptions = false;
	let fileInput: HTMLInputElement | null = null;

	$: isVideo = !!backgroundImage && VIDEO_EXT_RE.test(backgroundImage.url);
	$: animated = settings.scene !== 'none' && settings.scene !== 'image';

	/** Theme-agnostic read: the top-level setting, else the legacy customTheme copy. */
	function syncFromStores() {
		const effective = resolveThemeBackground(get(backgroundImageSetting), get(themeStore).customTheme) ?? null;
		backgroundImage = effective;
		if (!effective) return;
		opacity = Math.round((effective.opacity ?? 0.3) * 100);
		blur = effective.blur ?? 0;
		size = effective.size ?? 'cover';
		position = effective.position ?? 'center';
		repeat = effective.repeat ?? 'no-repeat';
		blend = effective.blend ?? 'overlay';
	}

	const unsubscribeBackground = backgroundImageSetting.subscribe(syncFromStores);
	const unsubscribeTheme = themeStore.subscribe(syncFromStores);
	syncFromStores();
	if (typeof window !== 'undefined') settings = loadChatBackdropSettings(!!backgroundImage);

	onDestroy(() => {
		unsubscribeBackground();
		unsubscribeTheme();
	});

	function persistScene() {
		settings = { ...settings };
		saveChatBackdropSettings(settings);
	}

	function chooseScene(scene: string) {
		settings.scene = scene as ChatBackdropScene;
		persistScene();
	}

	function isVideoFile(file: File): boolean {
		return file.type.startsWith('video/') || VIDEO_EXT_RE.test(file.name);
	}

	async function handleFileSelect(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		const video = isVideoFile(file);
		if (!video && !IMAGE_TYPES.includes(file.type)) {
			uploadError = $_('chat_bg.bad_type');
			input.value = '';
			return;
		}
		const maxSize = video ? 25 * 1024 * 1024 : 10 * 1024 * 1024;
		if (file.size > maxSize) {
			uploadError = $_('chat_bg.too_large', { values: { kind: video ? $_('chat_bg.videos') : $_('chat_bg.images'), max: video ? 25 : 10 } });
			input.value = '';
			return;
		}

		isUploading = true;
		uploadError = '';
		try {
			// Downscale large photos before upload; the server stores files as sent, and every
			// client downloads the background on boot. Videos and GIFs pass through untouched.
			let uploadFile = file;
			if (!video) {
				try {
					const { downscaleImageFile } = await import('$lib/imageResize');
					uploadFile = await downscaleImageFile(file, { maxEdge: 1920 });
				} catch {
					/* best-effort */
				}
			}
			const formData = new FormData();
			formData.append('backgroundImage', uploadFile);
			const headers: HeadersInit = {};
			const authToken = getAuthToken();
			if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
			const response = await fetch(`${getServerUrl()}/api/upload-background-image`, {
				method: 'POST',
				headers,
				credentials: 'include',
				body: formData
			});
			if (!response.ok) {
				uploadError = $_('chat_bg.upload_rejected');
				return;
			}
			const result = await response.json().catch(() => ({}));
			// The server returns { backgroundImageUrl }; { fileUrl } is tolerated too.
			const finalUrl = (result.backgroundImageUrl || result.fileUrl) as string | undefined;
			if (!finalUrl) {
				uploadError = $_('chat_bg.upload_no_url');
				return;
			}
			backgroundImage = { url: finalUrl };
			if (settings.scene !== 'image') chooseScene('image');
			await saveBackgroundImage();
		} catch (error) {
			console.error('[Settings] Background upload failed:', error);
			uploadError = $_('chat_bg.upload_unreachable');
		} finally {
			isUploading = false;
			input.value = '';
		}
	}

	function currentImage(): BackgroundImage | null {
		if (!backgroundImage) return null;
		return { url: backgroundImage.url, opacity: opacity / 100, blur, size, position, repeat, blend };
	}

	/** Theme-agnostic write: only the top-level `background_image`; theme_id is left alone. */
	async function saveBackgroundImage() {
		const next = currentImage();
		if (!next) return;
		backgroundImage = next;
		saveError = '';
		applyBackgroundImageVars(next);
		try {
			if (getAuthToken()) await persistBackgroundImageSetting(next);
			else loadBackgroundImageSetting(next);
		} catch (error) {
			console.error('[Settings] Failed to save background image settings:', error);
			saveError = $_('chat_bg.save_failed');
		}
	}

	async function removeImage() {
		backgroundImage = null;
		saveError = '';
		applyBackgroundImageVars(undefined);
		try {
			if (getAuthToken()) await persistBackgroundImageSetting(null);
			else loadBackgroundImageSetting(null);
		} catch (error) {
			console.error('[Settings] Failed to remove the background image:', error);
			saveError = $_('chat_bg.remove_failed');
		}
	}

	const fill = (value: number, min: number, max: number) => `--w-range-fill: ${((value - min) / (max - min)) * 100}%`;
</script>

<section class="settings-block backdrop-settings" aria-labelledby="chat-backdrop-heading">
	<h3 class="settings-block__title" id="chat-backdrop-heading">{$_('chat_bg.title')}</h3>
	<!-- Where it is saved is said once, in the page's scope note (an uploaded image follows a
	     signed-in account; scenes stay on this device). -->
	<p class="settings-block__hint">{$_('chat_bg.hint')}</p>

	<div class="backdrop-preview" aria-hidden="true">
		{#if settings.scene === 'image' && backgroundImage}
			{#if isVideo}
				<video
					class="backdrop-preview__media"
					src={backgroundImage.url}
					autoplay
					muted
					loop
					playsinline
					style:opacity={opacity / 100}
					style:filter="blur({blur}px)"
					style:object-fit={size === 'auto' ? 'none' : size}
				></video>
			{:else}
				<div
					class="backdrop-preview__media"
					style:background-image="url({JSON.stringify(backgroundImage.url)})"
					style:background-size={size}
					style:background-position={position.replaceAll('-', ' ')}
					style:background-repeat={repeat}
					style:background-blend-mode={blend}
					style:opacity={opacity / 100}
					style:filter="blur({blur}px)"
				></div>
			{/if}
		{/if}
		<ChatBackdrop scene={settings.scene} motion={settings.motion} dim={settings.dim} frost={settings.frost} />
		<!-- Two message rows drawn the stream's way (avatar, name, text; no bubbles, §7.18). -->
		<div class="backdrop-preview__copy">
			<div class="backdrop-preview__row">
				<span class="backdrop-preview__avatar">W</span>
				<p class="backdrop-preview__msg"><b>Wabi</b><span>{$_('chat_bg.msg_wabi')}</span></p>
			</div>
			<div class="backdrop-preview__row">
				<span class="backdrop-preview__avatar">Y</span>
				<p class="backdrop-preview__msg"><b>{$_('chat_bg.you')}</b><span>{$_('chat_bg.msg_pick')}</span></p>
			</div>
		</div>
	</div>

	<div class="w-srows">
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="backdrop-scene-label">{$_('chat_bg.scene')}</p>
				<p class="w-srow__hint">{$_('chat_bg.scene_hint')}</p>
			</div>
			<div class="w-srow__control">
				<Select ariaLabel={$_('chat_bg.scene')} heading={$_('chat_bg.scene')} align="end" options={sceneOptions} value={settings.scene} onchange={chooseScene} />
			</div>
		</div>

		{#if settings.scene === 'image'}
			<div class="w-srow">
				<div class="w-srow__text">
					<p class="w-srow__label">{$_('chat_bg.image_video')}</p>
					<p class="w-srow__hint">
						{#if backgroundImage}
							{$_('chat_bg.set_note', { values: { kind: isVideo ? $_('chat_bg.a_video') : $_('chat_bg.an_image') } })}
						{:else}
							{$_('chat_bg.file_limits')}
						{/if}
					</p>
				</div>
				<div class="w-srow__control">
					<!-- Not rendered (display: none), so it can never stretch or scroll the dialog frame;
					     the button below opens it. -->
					<input class="backdrop-file" type="file" accept={ACCEPT} bind:this={fileInput} on:change={handleFileSelect} disabled={isUploading} hidden />
					<button type="button" class="w-btn w-btn--sm" aria-busy={isUploading} disabled={isUploading} on:click={() => fileInput?.click()}>
						<Icon name="upload" size={16} />
						{isUploading ? $_('chat_bg.uploading') : backgroundImage ? $_('chat_bg.replace') : $_('chat_bg.choose_file')}
					</button>
					{#if backgroundImage}
						<button type="button" class="w-btn w-btn--sm w-btn--danger" disabled={isUploading} on:click={removeImage}>{$_('chat_bg.remove')}</button>
					{/if}
				</div>
			</div>
			{#if uploadError}<p class="w-field-error settings-block__error" role="alert"><Icon name="alert" size={14} />{uploadError}</p>{/if}

			{#if backgroundImage}
				<div class="w-srow">
					<div class="w-srow__text">
						<p class="w-srow__label" id="backdrop-opacity-label">{$_('chat_bg.strength')}</p>
						<p class="w-srow__hint">{opacity}%</p>
					</div>
					<div class="w-srow__control">
						<input
							class="w-range settings-range"
							type="range"
							min="0"
							max="100"
							bind:value={opacity}
							style={fill(opacity, 0, 100)}
							aria-labelledby="backdrop-opacity-label"
							aria-valuetext="{opacity}%"
							on:change={saveBackgroundImage}
						/>
					</div>
				</div>
				<div class="w-srow">
					<div class="w-srow__text">
						<p class="w-srow__label" id="backdrop-blur-label">{$_('chat_bg.blur')}</p>
						<p class="w-srow__hint">{blur} px</p>
					</div>
					<div class="w-srow__control">
						<input
							class="w-range settings-range"
							type="range"
							min="0"
							max="20"
							bind:value={blur}
							style={fill(blur, 0, 20)}
							aria-labelledby="backdrop-blur-label"
							aria-valuetext="{$_('chat_bg.pixels', { values: { n: blur } })}"
							on:change={saveBackgroundImage}
						/>
					</div>
				</div>
				<div class="w-srow">
					<div class="w-srow__text">
						<p class="w-srow__label" id="backdrop-size-label">{$_('chat_bg.size')}</p>
						<p class="w-srow__hint">{$_('chat_bg.size_hint')}</p>
					</div>
					<div class="w-srow__control">
						<Segmented
							labelledby="backdrop-size-label"
							options={sizeOptions}
							value={size}
							onchange={(value) => {
								size = value;
								void saveBackgroundImage();
							}}
						/>
					</div>
				</div>
				<div class="w-srow">
					<div class="w-srow__text">
						<p class="w-srow__label">{$_('chat_bg.position')}</p>
						<p class="w-srow__hint">{$_('chat_bg.position_hint')}</p>
					</div>
					<div class="w-srow__control">
						<Select
							ariaLabel={$_('chat_bg.position')}
							align="end"
							options={positionOptions}
							value={position}
							onchange={(value) => {
								position = value;
								void saveBackgroundImage();
							}}
						/>
					</div>
				</div>
				<button
					type="button"
					class="w-disclosure settings-disclosure"
					aria-expanded={showMoreImageOptions}
					aria-controls={showMoreImageOptions ? 'backdrop-more-options' : undefined}
					on:click={() => (showMoreImageOptions = !showMoreImageOptions)}
				>
					<Icon name="chevRight" size={16} />
					{$_('chat_bg.more_options')}
				</button>
				{#if showMoreImageOptions}
					<div class="w-disclosure__body settings-disclosure__body" id="backdrop-more-options">
						<div class="w-srow">
							<div class="w-srow__text">
								<p class="w-srow__label">{$_('chat_bg.repeat')}</p>
								<p class="w-srow__hint">{$_('chat_bg.repeat_hint')}</p>
							</div>
							<div class="w-srow__control">
								<Select
									ariaLabel={$_('chat_bg.repeat')}
									align="end"
									options={repeatOptions}
									value={repeat}
									onchange={(value) => {
										repeat = value as ImageRepeat;
										void saveBackgroundImage();
									}}
								/>
							</div>
						</div>
						<div class="w-srow">
							<div class="w-srow__text">
								<p class="w-srow__label">{$_('chat_bg.blend')}</p>
								<p class="w-srow__hint">{$_('chat_bg.blend_hint')}</p>
							</div>
							<div class="w-srow__control">
								<Select
									ariaLabel={$_('chat_bg.blend')}
									align="end"
									options={blendOptions}
									value={blend}
									onchange={(value) => {
										blend = value;
										void saveBackgroundImage();
									}}
								/>
							</div>
						</div>
					</div>
				{/if}
			{/if}
		{:else if animated}
			<div class="w-srow">
				<div class="w-srow__text">
					<p class="w-srow__label" id="backdrop-motion-label">{$_('chat_bg.motion')}</p>
					<p class="w-srow__hint">{Math.round(settings.motion * 100)}%</p>
				</div>
				<div class="w-srow__control">
					<input
						class="w-range settings-range"
						type="range"
						min="0"
						max="1"
						step="0.05"
						bind:value={settings.motion}
						style={fill(settings.motion, 0, 1)}
						aria-labelledby="backdrop-motion-label"
						aria-valuetext="{Math.round(settings.motion * 100)}%"
						on:input={persistScene}
					/>
				</div>
			</div>
			<div class="w-srow">
				<div class="w-srow__text">
					<p class="w-srow__label" id="backdrop-dim-label">{$_('chat_bg.darken')}</p>
					<p class="w-srow__hint">{Math.round(settings.dim * 100)}%</p>
				</div>
				<div class="w-srow__control">
					<input
						class="w-range settings-range"
						type="range"
						min="0"
						max="0.7"
						step="0.02"
						bind:value={settings.dim}
						style={fill(settings.dim, 0, 0.7)}
						aria-labelledby="backdrop-dim-label"
						aria-valuetext="{Math.round(settings.dim * 100)}%"
						on:input={persistScene}
					/>
				</div>
			</div>
			<div class="w-srow">
				<div class="w-srow__text">
					<p class="w-srow__label" id="backdrop-frost-label">{$_('chat_bg.frost')}</p>
					<p class="w-srow__hint">{$_('chat_bg.frost_hint', { values: { pct: Math.round(settings.frost * 100) } })}</p>
				</div>
				<div class="w-srow__control">
					<input
						class="w-range settings-range"
						type="range"
						min="0"
						max="0.9"
						step="0.02"
						bind:value={settings.frost}
						style={fill(settings.frost, 0, 0.9)}
						aria-labelledby="backdrop-frost-label"
						aria-valuetext="{Math.round(settings.frost * 100)}%"
						on:input={persistScene}
					/>
				</div>
			</div>
		{/if}
	</div>
	{#if saveError}<p class="w-field-error settings-block__error" role="alert"><Icon name="alert" size={14} />{saveError}</p>{/if}
</section>
