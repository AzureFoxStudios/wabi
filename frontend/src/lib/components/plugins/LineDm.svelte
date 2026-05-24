<script lang="ts">
	import {
		channels,
		currentUser,
		users,
		type Channel,
		type User
	} from '$lib/socket';
	import { layoutStore } from '$lib/layoutStore';
	import { getAuthToken } from '$lib/authSession';
	import { getServerUrl } from '$lib/serverUrl';
	import {
		clearLineDmConversationProfile,
		getLineDmResolvedProfile,
		hasLineDmConversationProfile,
		lineDmAddonStore,
		setLineDmAddonEnabled,
		updateLineDmConversationProfile,
		updateLineDmDefaultProfile,
		type LineDmPreset,
		type LineDmProfile
	} from '$lib/lineDmAddon';
	import './LineDm.css';

	type TargetScope = 'default' | string;

	const MAX_REMOTE_UPLOAD_BYTES = 10 * 1024 * 1024;
	const MAX_LOCAL_DATA_URL_BYTES = 2 * 1024 * 1024;
	const positionOptions = [
		'center',
		'top',
		'bottom',
		'left',
		'right',
		'top left',
		'top right',
		'bottom left',
		'bottom right'
	];

	let selectedTarget: TargetScope = 'default';
	let isUploading = false;
	let uploadError = '';
	let uploadStatus = '';

	$: dmChannels = [...$channels]
		.filter((channel) => channel.type === 'dm' || channel.type === 'group')
		.sort((a, b) => getConversationLabel(a).localeCompare(getConversationLabel(b)));
	$: activeDmId = $layoutStore.selectedDmChannelId;
	$: if (
		selectedTarget !== 'default' &&
		!dmChannels.some((channel) => channel.id === selectedTarget)
	) {
		selectedTarget = activeDmId && dmChannels.some((channel) => channel.id === activeDmId)
			? activeDmId
			: 'default';
	}
	$: selectedConversation =
		selectedTarget === 'default'
			? null
			: dmChannels.find((channel) => channel.id === selectedTarget) || null;
	$: currentProfile =
		selectedTarget === 'default'
			? $lineDmAddonStore.defaultProfile
			: getLineDmResolvedProfile(selectedTarget, $lineDmAddonStore);
	$: hasOverride =
		selectedTarget !== 'default' &&
		hasLineDmConversationProfile(selectedTarget, $lineDmAddonStore);
	$: previewWallpaperUrl = currentProfile.wallpaperUrl ? `url("${currentProfile.wallpaperUrl}")` : 'none';

	function getOtherUser(channel: Channel): User | null {
		if (channel.otherUser) return channel.otherUser;
		const me = $currentUser;
		if (!me) return null;
		const myStableId = me.dbUserId ? `user-${me.dbUserId}` : me.id;
		const otherStableId = (channel.members || []).find((id) => id !== myStableId);
		if (!otherStableId) return null;
		if (otherStableId.startsWith('user-')) {
			const dbId = Number.parseInt(otherStableId.slice(5), 10);
			return $users.find((user) => user.dbUserId === dbId) || null;
		}
		return $users.find((user) => user.id === otherStableId) || null;
	}

	function getConversationLabel(channel: Channel): string {
		if (channel.type === 'group') {
			return channel.name || 'Group DM';
		}
		return getOtherUser(channel)?.username || channel.name || 'Direct Message';
	}

	function selectActiveConversation(): void {
		if (activeDmId && dmChannels.some((channel) => channel.id === activeDmId)) {
			selectedTarget = activeDmId;
		}
	}

	function updateProfile(patch: Partial<LineDmProfile>): void {
		if (selectedTarget === 'default') {
			updateLineDmDefaultProfile(patch);
			return;
		}
		updateLineDmConversationProfile(selectedTarget, patch);
	}

	function clearSelectedOverride(): void {
		if (selectedTarget === 'default') return;
		clearLineDmConversationProfile(selectedTarget);
	}

	function setPreset(value: string): void {
		updateProfile({ preset: value as LineDmPreset });
	}

	function readFileAsDataUrl(file: File): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onerror = () => reject(new Error('Failed to read image file.'));
			reader.onload = () => {
				if (typeof reader.result === 'string' && reader.result) {
					resolve(reader.result);
					return;
				}
				reject(new Error('Failed to read image file.'));
			};
			reader.readAsDataURL(file);
		});
	}

	async function handleWallpaperSelect(event: Event): Promise<void> {
		const input = event.currentTarget as HTMLInputElement | null;
		const file = input?.files?.[0];
		if (!file) return;

		uploadError = '';
		uploadStatus = '';

		const validTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
		if (!validTypes.includes(file.type)) {
			uploadError = 'Use PNG, JPG, GIF, or WEBP images.';
			if (input) input.value = '';
			return;
		}

		if (file.size > MAX_REMOTE_UPLOAD_BYTES) {
			uploadError = 'Image is too large. Maximum size is 10MB.';
			if (input) input.value = '';
			return;
		}

		isUploading = true;
		try {
			const authToken = getAuthToken();
			if (authToken) {
				const formData = new FormData();
				formData.append('backgroundImage', file);

				const response = await fetch(`${getServerUrl()}/api/upload-background-image`, {
					method: 'POST',
					headers: { Authorization: `Bearer ${authToken}` },
					credentials: 'include',
					body: formData
				});
				const payload = await response.json().catch(() => ({}));
				if (!response.ok || !payload?.backgroundImageUrl) {
					throw new Error(String(payload?.error || 'Upload failed'));
				}
				updateProfile({ wallpaperUrl: String(payload.backgroundImageUrl) });
				uploadStatus = 'Wallpaper uploaded.';
			} else {
				if (file.size > MAX_LOCAL_DATA_URL_BYTES) {
					throw new Error('Signed-out local wallpapers are capped at 2MB.');
				}
				const dataUrl = await readFileAsDataUrl(file);
				updateProfile({ wallpaperUrl: dataUrl });
				uploadStatus = 'Wallpaper stored locally in this browser.';
			}
		} catch (error) {
			uploadError = error instanceof Error ? error.message : 'Failed to set wallpaper.';
		} finally {
			isUploading = false;
			if (input) input.value = '';
		}
	}

	function removeWallpaper(): void {
		updateProfile({ wallpaperUrl: null });
		uploadError = '';
		uploadStatus = 'Wallpaper removed.';
	}
</script>

<div class="setting-item-full line-dm-addon">
	<div class="setting-info">
		<span class="setting-label">LineDM</span>
		<span class="setting-description">
			Local frontend add-on for LINE-style DMs on the right panel. This only affects your client.
		</span>
	</div>

	<div class="settings-row-actions">
		<button
			class="toggle-btn"
			class:active={$lineDmAddonStore.enabled}
			on:click={() => setLineDmAddonEnabled(!$lineDmAddonStore.enabled)}
		>
			{$lineDmAddonStore.enabled ? 'ON' : 'OFF'}
		</button>
		<label class="upload-limit-row split-chunk-size-row">
			<span>Target</span>
			<select class="theme-select" bind:value={selectedTarget}>
				<option value="default">Global default</option>
				{#each dmChannels as channel (channel.id)}
					<option value={channel.id}>{getConversationLabel(channel)}</option>
				{/each}
			</select>
		</label>
		{#if activeDmId && dmChannels.some((channel) => channel.id === activeDmId)}
			<button class="action-btn secondary" on:click={selectActiveConversation}>
				Use Current DM
			</button>
		{/if}
		{#if selectedTarget !== 'default'}
			<button class="action-btn secondary" on:click={clearSelectedOverride} disabled={!hasOverride}>
				Use Global
			</button>
		{/if}
	</div>

	<div class="runtime-note">
		Editing:
		<strong>{selectedConversation ? getConversationLabel(selectedConversation) : 'Global default'}</strong>
		{#if selectedConversation}
			({hasOverride ? 'conversation override active' : 'inherits global defaults'})
		{/if}
	</div>

	<div class="line-dm-grid">
		<label class="upload-limit-row">
			<span>Preset</span>
			<select class="theme-select" value={currentProfile.preset} on:change={(event) => setPreset(event.currentTarget.value)}>
				<option value="line">LINE Soft</option>
				<option value="discord">Discord Glass</option>
				<option value="minimal">Minimal Calm</option>
			</select>
		</label>

		<label class="upload-limit-row">
			<span>Wallpaper fit</span>
			<select
				class="theme-select"
				value={currentProfile.wallpaperSize}
				on:change={(event) => updateProfile({ wallpaperSize: event.currentTarget.value as LineDmProfile['wallpaperSize'] })}
			>
				<option value="cover">Cover</option>
				<option value="contain">Contain</option>
				<option value="auto">Auto</option>
			</select>
		</label>

		<label class="upload-limit-row">
			<span>Wallpaper position</span>
			<select
				class="theme-select"
				value={currentProfile.wallpaperPosition}
				on:change={(event) => updateProfile({ wallpaperPosition: event.currentTarget.value })}
			>
				{#each positionOptions as option}
					<option value={option}>{option}</option>
				{/each}
			</select>
		</label>

		<label class="upload-limit-row">
			<span>Wallpaper repeat</span>
			<select
				class="theme-select"
				value={currentProfile.wallpaperRepeat}
				on:change={(event) => updateProfile({ wallpaperRepeat: event.currentTarget.value as LineDmProfile['wallpaperRepeat'] })}
			>
				<option value="no-repeat">No repeat</option>
				<option value="repeat">Repeat</option>
				<option value="repeat-x">Repeat X</option>
				<option value="repeat-y">Repeat Y</option>
			</select>
		</label>
	</div>

	<div class="line-dm-sliders">
		<label class="line-dm-slider">
			<span>Wallpaper opacity: {Math.round(currentProfile.wallpaperOpacity * 100)}%</span>
			<input
				type="range"
				min="0"
				max="100"
				value={Math.round(currentProfile.wallpaperOpacity * 100)}
				on:input={(event) => updateProfile({ wallpaperOpacity: Number(event.currentTarget.value) / 100 })}
			/>
		</label>

		<label class="line-dm-slider">
			<span>Wallpaper blur: {Math.round(currentProfile.wallpaperBlur)}px</span>
			<input
				type="range"
				min="0"
				max="24"
				value={currentProfile.wallpaperBlur}
				on:input={(event) => updateProfile({ wallpaperBlur: Number(event.currentTarget.value) })}
			/>
		</label>

		<label class="line-dm-slider">
			<span>Scrim strength: {Math.round(currentProfile.scrimOpacity * 100)}%</span>
			<input
				type="range"
				min="0"
				max="95"
				value={Math.round(currentProfile.scrimOpacity * 100)}
				on:input={(event) => updateProfile({ scrimOpacity: Number(event.currentTarget.value) / 100 })}
			/>
		</label>

		<label class="line-dm-slider">
			<span>Surface opacity: {Math.round(currentProfile.surfaceOpacity * 100)}%</span>
			<input
				type="range"
				min="25"
				max="100"
				value={Math.round(currentProfile.surfaceOpacity * 100)}
				on:input={(event) => updateProfile({ surfaceOpacity: Number(event.currentTarget.value) / 100 })}
			/>
		</label>

		<label class="line-dm-slider">
			<span>Bubble opacity: {Math.round(currentProfile.bubbleOpacity * 100)}%</span>
			<input
				type="range"
				min="25"
				max="100"
				value={Math.round(currentProfile.bubbleOpacity * 100)}
				on:input={(event) => updateProfile({ bubbleOpacity: Number(event.currentTarget.value) / 100 })}
			/>
		</label>
	</div>

	<div class="settings-row-actions">
		<label class="action-btn secondary line-dm-upload">
			<input
				type="file"
				accept="image/png,image/jpeg,image/gif,image/webp"
				on:change={handleWallpaperSelect}
				disabled={isUploading}
			/>
			{isUploading ? 'Uploading...' : currentProfile.wallpaperUrl ? 'Replace Wallpaper' : 'Choose Wallpaper'}
		</label>
		<button class="action-btn secondary" on:click={removeWallpaper} disabled={!currentProfile.wallpaperUrl}>
			Remove Wallpaper
		</button>
	</div>

	<div
		class="line-dm-preview"
		class:addon-enabled={$lineDmAddonStore.enabled}
		class:preset-line={currentProfile.preset === 'line'}
		class:preset-discord={currentProfile.preset === 'discord'}
		class:preset-minimal={currentProfile.preset === 'minimal'}
		style:--line-dm-wallpaper-url={previewWallpaperUrl}
		style:--line-dm-wallpaper-opacity={String(currentProfile.wallpaperOpacity)}
		style:--line-dm-wallpaper-blur={`${currentProfile.wallpaperBlur}px`}
		style:--line-dm-wallpaper-size={currentProfile.wallpaperSize}
		style:--line-dm-wallpaper-position={currentProfile.wallpaperPosition}
		style:--line-dm-wallpaper-repeat={currentProfile.wallpaperRepeat}
		style:--line-dm-scrim-opacity={String(currentProfile.scrimOpacity)}
		style:--line-dm-surface-opacity={String(currentProfile.surfaceOpacity)}
		style:--line-dm-bubble-opacity={String(currentProfile.bubbleOpacity)}
	>
		<div class="line-dm-preview-wallpaper" aria-hidden="true"></div>
		<div class="line-dm-preview-scrim" aria-hidden="true"></div>
		<div class="line-dm-preview-shell">
			<div class="line-dm-preview-header">
				<span>{selectedConversation ? getConversationLabel(selectedConversation) : 'LineDM preview'}</span>
			</div>
			<div class="line-dm-preview-body">
				<div class="line-dm-preview-bubble incoming">This is the cozy DM lane.</div>
				<div class="line-dm-preview-bubble outgoing">Discord can stay central. DMs can feel softer.</div>
			</div>
		</div>
	</div>

	<div class="runtime-note">
		Signed-in users can upload larger wallpapers to the existing background endpoint. Signed-out mode stores wallpapers locally and keeps them under 2MB.
	</div>
	{#if uploadStatus}
		<div class="runtime-note">{uploadStatus}</div>
	{/if}
	{#if uploadError}
		<div class="line-dm-error">{uploadError}</div>
	{/if}
</div>
