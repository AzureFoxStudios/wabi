<script lang="ts">
	import { updateProfile, currentUser, type User, channels, createDM, sendMessage, dmPanelSignal } from '$lib/socket';
	import { browser } from '$app/environment';
	import { get } from 'svelte/store';
	import AvatarEditor from './AvatarEditor.svelte';

	export let isOpen = false;
	export let user: User | null = null;
	export let isOwnProfile = false;

	let pendingPfpFile: File | null = null;
	let pendingPfpUrl: string | null = null;
	let pendingBannerFile: File | null = null;
	let pendingBannerUrl: string | null = null;

	let userNote = '';
	let isEditingNote = false;
	let dmMessage = '';
	let showAvatarEditor = false;
	let showBannerEditor = false;
	let isLoading = false;
	let error = '';

	$: pfpChanged = pendingPfpUrl !== null;
	$: bannerChanged = pendingBannerUrl !== null;
	$: hasPendingChanges = pfpChanged || bannerChanged;

	$: if (isOpen && user) {
		pendingPfpFile = null;
		pendingPfpUrl = null;
		pendingBannerFile = null;
		pendingBannerUrl = null;
		loadUserNote();
		dmMessage = '';
		showAvatarEditor = false;
		showBannerEditor = false;
		isLoading = false;
		error = '';
	}

	function cancelChanges() {
		pendingPfpFile = null;
		pendingPfpUrl = null;
		pendingBannerFile = null;
		pendingBannerUrl = null;
		error = '';
	}

	function loadUserNote() {
		if (!browser || !user) return;
		const notes = JSON.parse(localStorage.getItem('userNotes') || '{}');
		userNote = notes[user.id] || '';
	}

	function saveUserNote() {
		if (!browser || !user) return;
		const notes = JSON.parse(localStorage.getItem('userNotes') || '{}');
		if (userNote.trim()) {
			notes[user.id] = userNote;
		} else {
			delete notes[user.id];
		}
		localStorage.setItem('userNotes', JSON.stringify(notes));
		isEditingNote = false;
	}

	function closeModal() {
		if (isLoading) return;
		isOpen = false;
	}

	function handleAvatarChange(event: CustomEvent<{ file: File; dataUrl: string }>) {
		pendingPfpFile = event.detail.file;
		pendingPfpUrl = event.detail.dataUrl;
	}

	function handleBannerChange(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;

		const reader = new FileReader();
		reader.onload = (e) => {
			pendingBannerFile = file;
			pendingBannerUrl = e.target?.result as string;
		};
		reader.readAsDataURL(file);
	}

	async function saveProfile() {
		if (!isOwnProfile || isLoading || !user) return;

		isLoading = true;
		error = '';
		let newPfpUrl: string | undefined = undefined;
		let newBannerUrl: string | undefined = undefined;

		try {
			const serverUrl = window.location.origin.includes(':5173')
				? 'https://ungruff-subtarsal-libby.ngrok-free.dev'
				: window.location.origin;

			if (pendingPfpFile) {
				const formData = new FormData();
				formData.append('file', pendingPfpFile);
				const response = await fetch(`${serverUrl}/api/upload`, {
					method: 'POST',
					body: formData
				});
				if (!response.ok) throw new Error('Profile picture upload failed');
				const result = await response.json();
				if (!result.success) throw new Error(result.error || 'Upload failed');
				newPfpUrl = result.fileUrl.startsWith('http') ? result.fileUrl : `${serverUrl}${result.fileUrl}`;
			}

			if (pendingBannerFile) {
				const formData = new FormData();
				formData.append('file', pendingBannerFile);
				const response = await fetch(`${serverUrl}/api/upload`, {
					method: 'POST',
					body: formData
				});
				if (!response.ok) throw new Error('Banner upload failed');
				const result = await response.json();
				if (!result.success) throw new Error(result.error || 'Upload failed');
				newBannerUrl = result.fileUrl.startsWith('http') ? result.fileUrl : `${serverUrl}${result.fileUrl}`;
			}

			if (newPfpUrl || newBannerUrl) {
				updateProfile(undefined, newPfpUrl, newBannerUrl);
			}

			closeModal();
		} catch (e: any) {
			error = e.message;
		} finally {
			isLoading = false;
		}
	}

	function getStatusColor(status: string) {
		switch (status) {
			case 'active': return 'var(--status-online)';
			case 'away': return 'var(--status-away)';
			case 'busy': return 'var(--status-busy)';
			default: return 'var(--status-offline)';
		}
	}

	async function handleSendDM() {
		if (!dmMessage.trim() || !user) return;
		const self = get(currentUser);
		if (!self) return;

		const memberIds = [self.id, user.id].sort();
		const dmId = `dm-${memberIds.join('-')}`;
		const allChannels = get(channels);
		const existingDM = allChannels.find(ch => ch.id === dmId);

		if (existingDM) {
			sendMessage(dmId, dmMessage.trim());
			dmPanelSignal.set({ channelId: dmId, otherUser: user });
			closeModal();
		} else {
			createDM(user.id);
			const unsubscribe = channels.subscribe(chs => {
				const newDM = chs.find(ch => ch.id === dmId);
				if (newDM) {
					sendMessage(dmId, dmMessage.trim());
					dmPanelSignal.set({ channelId: dmId, otherUser: user });
					unsubscribe();
					closeModal();
				}
			});
		}
	}

	$: displayBanner = pendingBannerUrl || (isOwnProfile ? $currentUser?.bannerUrl : user?.bannerUrl);
	$: displayPfp = pendingPfpUrl || (isOwnProfile ? $currentUser?.profilePicture : user?.profilePicture);
</script>

{#if isOpen && user}
	<div class="modal-overlay" on:click={closeModal}>
		<div class="modal-content" on:click|stopPropagation>
			<button class="close-btn" on:click={closeModal} disabled={isLoading}>&times;</button>

			<!-- Banner Section -->
			<div class="banner-section">
				{#if displayBanner}
					<img src={displayBanner} alt="Banner" class="banner-image" />
				{:else}
					<div class="banner-placeholder"></div>
				{/if}
				{#if isOwnProfile}
					<input
						type="file"
						accept="image/*"
						on:change={handleBannerChange}
						id="banner-upload"
						style="display: none;"
					/>
					<label for="banner-upload" class="banner-edit-btn">
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
							<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
						</svg>
					</label>
				{/if}
			</div>

			<!-- Profile Picture (overlaps banner) -->
			<div class="profile-picture-wrapper">
				{#if isOwnProfile}
					<button class="profile-picture-container" on:click={() => showAvatarEditor = true}>
						{#if displayPfp}
							<img src={displayPfp} alt={user.username} class="profile-picture" />
						{:else}
							<div class="profile-picture-placeholder" style="background-color: {user.color}">
								{user.username.charAt(0).toUpperCase()}
							</div>
						{/if}
						<div class="pfp-edit-overlay">
							<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
								<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
							</svg>
						</div>
					</button>
				{:else}
					<div class="profile-picture-container">
						{#if displayPfp}
							<img src={displayPfp} alt={user.username} class="profile-picture" />
						{:else}
							<div class="profile-picture-placeholder" style="background-color: {user.color}">
								{user.username.charAt(0).toUpperCase()}
							</div>
						{/if}
					</div>
				{/if}
			</div>

			<!-- Content Section -->
			<div class="modal-body">
				<!-- Username & Status -->
				<div class="info-box">
					<h2 class="username">{user.username}</h2>
					<div class="status-display">
						<span class="status-dot" style="background-color: {getStatusColor(user.status)}"></span>
						<span class="status-text">{user.status.charAt(0).toUpperCase() + user.status.slice(1)}</span>
					</div>
				</div>

				{#if !isOwnProfile}
					<!-- DM Section -->
					<div class="info-box dm-box">
						<label class="box-label">Quick Message</label>
						<div class="dm-section">
							<textarea class="dm-input" bind:value={dmMessage} placeholder="Send a message..." rows="2"></textarea>
							<button class="dm-send-btn" on:click={handleSendDM} disabled={!dmMessage.trim()}>Send</button>
						</div>
					</div>

					<!-- Notes Section -->
					<div class="info-box">
						<div class="notes-header">
							<label class="box-label">Personal Notes</label>
							{#if !isEditingNote}
								<button class="edit-note-btn" on:click={() => (isEditingNote = true)}>
									{userNote ? 'Edit' : '+ Add'}
								</button>
							{/if}
						</div>
						{#if isEditingNote}
							<textarea
								bind:value={userNote}
								placeholder="Add personal notes..."
								class="note-textarea"
								rows="3"
							></textarea>
							<div class="note-actions">
								<button class="cancel-note-btn" on:click={() => { isEditingNote = false; loadUserNote(); }}>Cancel</button>
								<button class="save-note-btn" on:click={saveUserNote}>Save</button>
							</div>
						{:else if userNote}
							<div class="note-display">{userNote}</div>
						{:else}
							<div class="note-placeholder">No notes yet</div>
						{/if}
					</div>
				{/if}
			</div>

			{#if isOwnProfile && hasPendingChanges}
				<div class="modal-footer">
					{#if error}<p class="error">{error}</p>{/if}
					<button class="cancel-btn" on:click={cancelChanges} disabled={isLoading}>Discard</button>
					<button class="save-btn" on:click={saveProfile} disabled={isLoading}>
						{#if isLoading}Saving...{:else}Save Changes{/if}
					</button>
				</div>
			{/if}
		</div>
	</div>
{/if}

{#if showAvatarEditor}
	<AvatarEditor bind:isOpen={showAvatarEditor} on:change={handleAvatarChange} />
{/if}

<style>
	.modal-overlay {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background-color: var(--modal-overlay);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
		backdrop-filter: blur(8px);
	}

	.modal-content {
		background: var(--bg-secondary);
		border-radius: 16px;
		width: 90%;
		max-width: 480px;
		overflow: hidden;
		position: relative;
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
	}

	.close-btn {
		position: absolute;
		top: 16px;
		right: 16px;
		background: rgba(0, 0, 0, 0.6);
		border: none;
		font-size: 2rem;
		color: white;
		cursor: pointer;
		width: 36px;
		height: 36px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 50%;
		z-index: 10;
		transition: background 0.2s;
	}

	.close-btn:hover {
		background: rgba(0, 0, 0, 0.8);
	}

	.banner-section {
		position: relative;
		width: 100%;
		height: 160px;
		overflow: hidden;
	}

	.banner-image {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.banner-placeholder {
		width: 100%;
		height: 100%;
		background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
	}

	.banner-edit-btn {
		position: absolute;
		bottom: 12px;
		right: 12px;
		background: rgba(0, 0, 0, 0.6);
		color: white;
		border: none;
		border-radius: 50%;
		width: 36px;
		height: 36px;
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		transition: background 0.2s;
	}

	.banner-edit-btn:hover {
		background: rgba(0, 0, 0, 0.8);
	}

	.profile-picture-wrapper {
		display: flex;
		justify-content: center;
		margin-top: -60px;
		position: relative;
		z-index: 5;
		padding: 0 20px;
	}

	.profile-picture-container {
		width: 120px;
		height: 120px;
		position: relative;
		border-radius: 50%;
		border: 4px solid var(--bg-primary);
		overflow: hidden;
		background: var(--bg-secondary);
		padding: 0;
		cursor: default;
	}

	.profile-picture-container:not([disabled]) {
		cursor: pointer;
	}

	.profile-picture {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.profile-picture-placeholder {
		width: 100%;
		height: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 3rem;
		font-weight: bold;
		color: white;
	}

	.pfp-edit-overlay {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background: rgba(0, 0, 0, 0.6);
		display: flex;
		align-items: center;
		justify-content: center;
		opacity: 0;
		transition: opacity 0.2s;
	}

	.profile-picture-container:not([disabled]):hover .pfp-edit-overlay {
		opacity: 1;
	}

	.modal-body {
		padding: 16px 20px 20px;
		background: var(--bg-secondary);
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.info-box {
		background: rgba(0, 0, 0, 0.4);
		backdrop-filter: blur(10px);
		border-radius: 12px;
		padding: 16px;
		border: 1px solid rgba(255, 255, 255, 0.1);
	}

	.username {
		margin: 0 0 8px 0;
		font-size: 1.5rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.status-display {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.status-dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
	}

	.status-text {
		color: var(--text-secondary);
		font-size: 0.9rem;
	}

	.box-label {
		display: block;
		font-weight: 500;
		color: var(--text-secondary);
		font-size: 0.85rem;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		margin-bottom: 8px;
	}

	.dm-box {
		padding: 12px;
	}

	.dm-section {
		display: flex;
		flex-direction: row;
		gap: 8px;
		align-items: flex-start;
	}

	.dm-input {
		flex: 1;
		resize: none;
		padding: 10px;
		border-radius: 8px;
		border: none;
		background: rgba(0, 0, 0, 0.3);
		color: var(--text-primary);
		font-family: inherit;
		font-size: 0.9rem;
	}

	.dm-input:focus {
		outline: 2px solid var(--accent);
	}

	.dm-send-btn {
		padding: 8px 16px;
		background: var(--accent);
		flex-shrink: 0;
	}

	.notes-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 8px;
	}

	.edit-note-btn {
		padding: 4px 12px;
		font-size: 0.8rem;
		background: rgba(255, 255, 255, 0.1);
		color: var(--text-primary);
	}

	.note-textarea {
		width: 100%;
		padding: 10px;
		border: none;
		border-radius: 8px;
		background: rgba(0, 0, 0, 0.3);
		color: var(--text-primary);
		font-family: inherit;
		font-size: 0.9rem;
		resize: vertical;
		margin-bottom: 8px;
	}

	.note-textarea:focus {
		outline: 2px solid var(--accent);
	}

	.note-actions {
		display: flex;
		gap: 8px;
		justify-content: flex-end;
	}

	.cancel-note-btn, .save-note-btn {
		padding: 6px 14px;
		font-size: 0.85rem;
	}

	.cancel-note-btn {
		background: rgba(255, 255, 255, 0.1);
	}

	.save-note-btn {
		background: var(--accent);
	}

	.note-display {
		padding: 10px;
		background: rgba(0, 0, 0, 0.2);
		border-radius: 8px;
		font-size: 0.9rem;
		color: var(--text-primary);
		line-height: 1.5;
		white-space: pre-wrap;
	}

	.note-placeholder {
		padding: 10px;
		color: var(--text-secondary);
		font-size: 0.85rem;
		font-style: italic;
		text-align: center;
	}

	.modal-footer {
		display: flex;
		justify-content: flex-end;
		align-items: center;
		gap: 10px;
		padding: 16px 20px;
		background: var(--bg-secondary);
	}

	.error {
		margin: 0;
		margin-right: auto;
		color: var(--color-danger);
		font-size: 0.85rem;
	}

	.cancel-btn, .save-btn {
		padding: 8px 16px;
		font-size: 0.9rem;
	}

	.cancel-btn {
		background: rgba(255, 255, 255, 0.1);
	}

	.save-btn {
		background: var(--accent);
	}
</style>
