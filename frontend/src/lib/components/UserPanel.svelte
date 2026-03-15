<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { get } from 'svelte/store';
	import { users, currentUser, socket, channels, type User, createDM, getDMChannelIdForUser, channelUnreadCounts } from '$lib/socket';
	import { startCall } from '$lib/calling';
	import { startScreenShare } from '$lib/calling';
	import UserPopout from './UserPopout.svelte';
	import UserContextMenu from './UserContextMenu.svelte';
	import { longpress } from '$lib/actions/longpress';
	import CreateDMModal from './CreateDMModal.svelte';
	import { _ } from '$lib/i18n';
	import { clearAuthSession, clearStoredIdentity } from '$lib/authSession';
	import { getUserIdentityKey } from '$lib/localNicknames';
	import { queueConversationPaymentLaunch, type ConversationPaymentSurface } from '$lib/paymentLaunch';

	const dispatch = createEventDispatcher();

	// Helper function to get DM channel ID for a user (uses stable IDs)
	function getDMChannelId(user: User): string {
		return getDMChannelIdForUser($currentUser, user);
	}

	function isCurrentUserEntry(user: User): boolean {
		if (!$currentUser) return false;
		if (user.id === $currentUser.id) return true;
		if (user.dbUserId && $currentUser.dbUserId && user.dbUserId === $currentUser.dbUserId) return true;
		return false;
	}

	// Helper function to get unread count for a user's DM
	function getUserUnreadCount(user: User): number {
		const dmId = getDMChannelId(user);
		return $channelUnreadCounts[dmId] || 0;
	}

	// Helper function to format badge display
	function formatBadge(count: number): string {
		if (count === 0) return '';
		if (count <= 10) return `+${count}`;
		return '•';
	}

	// Calculate total unread DM count
	$: totalUnreadDMs = Object.entries($channelUnreadCounts)
		.filter(([channelId]) => channelId.startsWith('dm-'))
		.reduce((sum, [, count]) => sum + count, 0);

	let showDMModal = false;

	// User popout state
	let showUserPopout = false;
	let popoutUser: User | null = null;
	let popoutAnchorElement: HTMLElement | null = null;
	let popoutIsOwnProfile = false;

	// Context menu state
	let showContextMenu = false;
	let contextMenuUser: User | null = null;
	let contextMenuX = 0;
	let contextMenuY = 0;

	function openProfile(user: User, anchorEl?: HTMLElement | null) {
		popoutUser = user;
		popoutIsOwnProfile = isCurrentUserEntry(user);
		popoutAnchorElement = anchorEl || null;
		showUserPopout = true;
	}

	function handleUserLongPress(event: TouchEvent, user: User) {
		const touch = event.touches?.[0] || event.changedTouches?.[0];
		if (!touch) return;
		const syntheticEvent = {
			preventDefault: () => {},
			stopPropagation: () => {},
			clientX: touch.clientX,
			clientY: touch.clientY
		} as MouseEvent;
		handleContextMenu(syntheticEvent, user);
	}

	function handleContextMenu(event: MouseEvent, user: User) {
		event.preventDefault();
		event.stopPropagation();
		contextMenuUser = user;
		contextMenuX = event.clientX;
		contextMenuY = event.clientY;
		showContextMenu = true;
	}

	function closeContextMenu() {
		showContextMenu = false;
		contextMenuUser = null;
	}

	function handleOpenDM(event?: CustomEvent<{ user: User }> | User) {
		// Handle both direct user parameter and event with user data
		let user: User | null = null;

		if (event && 'detail' in event) {
			// Called from context menu event
			user = event.detail.user;
		} else if (event && 'id' in event) {
			// Called with user object directly
			user = event as User;
		} else {
			// Fallback to contextMenuUser (for backwards compatibility)
			user = contextMenuUser;
		}

		if (!user) return;

		// Create DM and find the channel using stable IDs
		const dmId = getDMChannelIdForUser($currentUser, user);

		// Check if DM already exists
		const existingDM = $channels.find(ch => ch.id === dmId);

		if (existingDM) {
			// DM exists, open it immediately
			dispatch('openDM', { channelId: dmId, otherUser: user });
		} else {
			// Create new DM
			createDM(user.id);

			// Subscribe to channels to wait for the new DM
			const unsubscribe = channels.subscribe(chs => {
				const newDM = chs.find(ch => ch.id === dmId || (ch.type === 'dm' && ch.otherUser?.id === user.id));
				if (newDM) {
					dispatch('openDM', { channelId: newDM.id, otherUser: user });
					unsubscribe();
				}
			});
		}

		// Close the panel on mobile after initiating a DM
		dispatch('close');
	}

	function handlePaymentLaunch(
		surface: ConversationPaymentSurface,
		event?: CustomEvent<{ user: User }> | User
	): void {
		let user: User | null = null;
		if (event && 'detail' in event) {
			user = event.detail.user;
		} else if (event && 'id' in event) {
			user = event as User;
		} else {
			user = contextMenuUser;
		}
		if (!user || isCurrentUserEntry(user) || !user.dbUserId) return;
		queueConversationPaymentLaunch({
			surface,
			targetUserId: user.id,
			targetDbUserId: user.dbUserId
		});
		handleOpenDM(user);
	}

	function openDMModal() {
		showDMModal = true;
	}

		function handleLogout() {
		// Clear session
		try {
			clearAuthSession();
			clearStoredIdentity();
		} catch (e) {
			console.error('Failed to clear session data:', e);
		}
		// Dispatch logout event to parent
		dispatch('logout');
	}

	function getStatusColor(status: string) {
		switch (status) {
			case 'active':
				return 'var(--status-online)';
			case 'away':
				return 'var(--status-away)';
			case 'busy':
				return 'var(--status-busy)';
			default:
				return 'var(--status-offline)';
		}
	}

	async function handleVoiceCall(event?: MouseEvent, user?: User) {
		if (event) event.stopPropagation();
		const targetUser = user || contextMenuUser;
		if (!$socket || !targetUser || isCurrentUserEntry(targetUser)) return;
		try {
			await startCall($socket, getUserIdentityKey(targetUser), false, { scope: 'dm', displayName: targetUser.username });
		} catch (error) {
			alert(get(_)('user.errors.voice_call_failed'));
		}
	}

	async function handleVideoCall(event?: MouseEvent, user?: User) {
		if (event) event.stopPropagation();
		const targetUser = user || contextMenuUser;
		if (!$socket || !targetUser || isCurrentUserEntry(targetUser)) return;
		try {
			await startCall($socket, getUserIdentityKey(targetUser), true, { scope: 'dm', displayName: targetUser.username });
		} catch (error) {
			alert(get(_)('user.errors.video_call_failed'));
		}
	}

	async function handleScreenShare(event?: MouseEvent, user?: User) {
		if (event) event.stopPropagation();
		const targetUser = user || contextMenuUser;
		if (!$socket || !targetUser || isCurrentUserEntry(targetUser)) return;
		try {
			// In this app, screen sharing is not directed to a specific user,
			// it's broadcast to the current channel.
			await startScreenShare($socket);
		} catch (error) {
			alert(get(_)('user.errors.screen_share_failed'));
		}
	}
</script>

<aside class="user-panel">
	<div class="panel-header">
		<button class="mobile-close-btn" on:click={() => dispatch('close')}>&times;</button>
		<h3>{$_('user.online', { values: { count: $users.length } })}</h3>
		<div class="header-buttons">
			<button
				class="dm-btn"
				class:has-unread={totalUnreadDMs > 0}
				data-unread={totalUnreadDMs > 99 ? '99+' : totalUnreadDMs}
				on:click={openDMModal}
				title={$_('user.start_dm')}
			>💬</button>
			<button
				class="logout-btn"
				on:click={handleLogout}
				title={$_('user.logout_change_name')}
			>🚪</button>
		</div>
	</div>

	<div class="user-list">
		{#each $users as user (user.id)}
			<div
				class="user"
				on:contextmenu={(e) => handleContextMenu(e, user)}
				use:longpress={{ onLongPress: (e) => handleUserLongPress(e, user) }}
			>
				<!-- Profile Picture or Placeholder -->
				<button class="user-avatar-button" on:click|stopPropagation={(e) => openProfile(user, e.currentTarget as HTMLElement)}>
					{#if user.profilePicture}
						<img src={user.profilePicture} alt={user.username} class="user-avatar" />
					{:else}
						<div class="user-avatar-placeholder" style="background-color: {user.color}">
							{user.username.charAt(0).toUpperCase()}
						</div>
					{/if}
				</button>

				<!-- Username and Status -->
				<button
					class="user-info-button"
					on:click={(e) => {
						if (!isCurrentUserEntry(user)) {
							handleOpenDM(user);
						} else {
							openProfile(user, e.currentTarget as HTMLElement);
						}
					}}
				>
					<div class="user-info">
						<span class="user-name">
							{user.username}
							{#if isCurrentUserEntry(user)}<span class="you-badge">({$_('user.you')})</span>{/if}
						</span>
						<div class="user-status">
							<span class="status-dot" style="background-color: {getStatusColor(user.status)}"></span>
							<span class="status-text">{user.status}</span>
						</div>
					</div>
				</button>

				<!-- Unread badge for DMs -->
				{#if !isCurrentUserEntry(user) && getUserUnreadCount(user) > 0}
					<span class="unread-badge">{formatBadge(getUserUnreadCount(user))}</span>
				{/if}

				<!-- Call buttons (only show for other users) -->
				{#if !isCurrentUserEntry(user)}
					<div class="call-buttons">
						<button
							class="call-btn voice-call"
							on:click={(e) => handleVoiceCall(e, user)}
							title={$_('user.voice_call')}
						>
							📞
						</button>
						<button
							class="call-btn video-call"
							on:click={(e) => handleVideoCall(e, user)}
							title={$_('user.video_call')}
						>
							📹
						</button>
						<button
							class="call-btn screen-share"
							on:click={(e) => handleScreenShare(e, user)}
							title={$_('user.screen_share')}
						>
							📺
						</button>
					</div>
				{/if}
			</div>
		{/each}
	</div>
</aside>

<UserPopout
	bind:isOpen={showUserPopout}
	bind:user={popoutUser}
	anchorElement={popoutAnchorElement}
	isOwnProfile={popoutIsOwnProfile}
	on:close={() => showUserPopout = false}
/>

{#if showContextMenu && contextMenuUser}
	<UserContextMenu
		user={contextMenuUser}
		x={contextMenuX}
		y={contextMenuY}
		isOwnProfile={isCurrentUserEntry(contextMenuUser)}
		on:close={closeContextMenu}
		on:voiceCall={() => handleVoiceCall()}
		on:videoCall={() => handleVideoCall()}
		on:screenShare={() => handleScreenShare()}
		on:openDM={handleOpenDM}
		on:requestPayment={(event) => handlePaymentLaunch('payment_request', event)}
		on:recordManualCash={(event) => handlePaymentLaunch('manual_cash', event)}
		on:viewProfile={() => {
			if (contextMenuUser) openProfile(contextMenuUser);
		}}
	/>
{/if}

<CreateDMModal bind:isOpen={showDMModal} />

<style>
	.user-panel {
		width: 100%;
		background: var(--bg-secondary);
		border-left: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		height: 100dvh;
		overflow: hidden;
	}

	.panel-header {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.625rem 1rem;
		background: var(--gradient-fade-bottom-dark);
		border-bottom: 1px solid rgba(255, 0, 255, 0.1);
		height: 52px;
		box-sizing: border-box;
		z-index: 2;
	}

	.panel-header h3 {
		font-size: 0.875rem;
		font-weight: 600;
		text-transform: uppercase;
		color: var(--text-secondary);
		margin: 0;
		flex: 1;
	}
	
	.mobile-close-btn {
		display: none; /* Hidden by default */
		background: none;
		border: none;
		font-size: 2rem;
		color: var(--text-secondary);
		cursor: pointer;
		padding: 0 1rem 0 0;
	}

	@media (max-width: 768px) {
		.mobile-close-btn {
			display: block; /* Visible on mobile */
		}
	}

	.dm-btn {
		width: 32px;
		height: 32px;
		background: transparent;
		border: none;
		color: var(--text-secondary);
		font-size: 1.2rem;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.2s;
		padding: 0;
		opacity: 0.6;
	}

	.dm-btn:hover {
		background: var(--bg-tertiary);
		color: var(--text-primary);
		opacity: 1;
		transform: none;
	}

	/* Unread badge for DM button */
	.dm-btn {
		position: relative;
	}

	.dm-btn.has-unread::after {
		content: attr(data-unread);
		position: absolute;
		top: -4px;
		right: -4px;
		background: #ff4757;
		color: white;
		font-size: 0.65rem;
		font-weight: 700;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		border: 2px solid var(--bg-secondary);
		line-height: 1;
	}

	.header-buttons {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}

	.logout-btn {
		width: 32px;
		height: 32px;
		background: transparent;
		border: none;
		color: var(--text-secondary);
		font-size: 1.2rem;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.2s;
		padding: 0;
		opacity: 0.6;
	}

	.logout-btn:hover {
		background: var(--bg-tertiary);
		color: var(--text-primary);
		opacity: 1;
	}

	.user-list {
		flex: 1;
		overflow-y: auto;
		padding: 0.5rem;
	}

	.user {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.625rem;
		border-radius: 0;
		background: transparent;
		border: none;
		width: 100%;
		text-align: left;
		transition: all 0.2s;
		position: relative;
		margin-bottom: 0.5rem;
	}

	.user:hover {
		background: var(--bg-tertiary);
		transform: translateX(2px);
	}

	.user:hover .call-buttons {
		opacity: 1;
		pointer-events: auto;
	}

	.user-avatar-button {
		padding: 0;
		border-radius: 50%;
		border: none;
		background: none;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}

	.user-info-button {
		flex: 1;
		padding: 0;
		border: none;
		background: none;
		cursor: pointer;
		text-align: left;
		display: flex;
		align-items: center;
		min-width: 0;
	}

	.user-avatar {
		width: 40px;
		height: 40px;
		border-radius: 50%;
		object-fit: cover;
	}

	.user-avatar-placeholder {
		width: 40px;
		height: 40px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		font-weight: bold;
		color: white;
		font-size: 1rem;
	}

	.user-info {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		min-width: 0;
	}

	.user-name {
		font-size: 0.9rem;
		font-weight: 500;
		color: var(--text-primary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.you-badge {
		font-size: 0.75rem;
		color: var(--text-secondary);
		font-weight: normal;
		margin-left: 0.25rem;
	}

	.user-status {
		display: flex;
		align-items: center;
		gap: 0.375rem;
	}

	.status-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.status-text {
		font-size: 0.75rem;
		color: var(--text-secondary);
		text-transform: capitalize;
	}

	.call-buttons {
		position: absolute;
		right: 0.5rem;
		top: 50%;
		transform: translateY(-50%);
		display: flex;
		gap: 0.25rem;
		opacity: 0;
		pointer-events: none;
		transition: opacity 0.2s;
	}

	.call-btn {
		width: 32px;
		height: 32px;
		border: none;
		border-radius: 0;
		background: var(--bg-tertiary);
		color: var(--text-primary);
		font-size: 1rem;
		cursor: pointer;
		transition: all 0.2s;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.call-btn:hover {
		transform: scale(1.1);
	}

	.voice-call:hover {
		background: var(--color-success);
	}

	.video-call:hover {
		background: var(--color-info);
	}

	.screen-share:hover {
		background: var(--color-warning);
	}

	/* Unread badge styling */
	.unread-badge {
		background: #ff4444;
		color: white;
		font-size: 0.75rem;
		font-weight: bold;
		padding: 2px 6px;
		border-radius: 10px;
		margin-left: auto;
		min-width: 20px;
		text-align: center;
		animation: pulse 2s infinite;
	}

	@keyframes pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.7; }
	}

	/* ========== MOBILE STYLES ========== */
	@media (max-width: 768px) {
		.user-panel {
			height: calc(100dvh - 56px);
		}

		.panel-header {
			padding: 0.375rem 0.5rem;
			height: auto;
			min-height: 40px;
		}

		.panel-header h3 {
			font-size: 0.8rem;
		}

		.mobile-close-btn {
			min-width: 36px;
			min-height: 36px;
			width: 36px;
			height: 36px;
			font-size: 1.5rem;
		}

		.dm-btn {
			min-width: 36px;
			min-height: 36px;
			width: 36px;
			height: 36px;
			font-size: 1.2rem;
		}

		.user-list {
			padding: 0.375rem;
		}

		/* Compact user items */
		.user {
			padding: 0.5rem;
			margin-bottom: 0.25rem;
			min-height: 48px;
		}

		.user-avatar,
		.user-avatar-placeholder {
			width: 32px;
			height: 32px;
		}

		.user-avatar-button {
			min-width: 32px;
			min-height: 32px;
		}

		.user-info-button {
			min-height: 36px;
		}

		.user-name {
			font-size: 0.875rem;
		}

		.status-text {
			font-size: 0.7rem;
		}

		/* Show call buttons on mobile */
		.call-buttons {
			position: static;
			transform: none;
			opacity: 1;
			pointer-events: auto;
			margin-left: auto;
			flex-shrink: 0;
			gap: 0.25rem;
		}

		.call-btn {
			width: 32px;
			height: 32px;
			font-size: 0.9rem;
		}

		/* Unread badge */
		.unread-badge {
			position: absolute;
			top: 0.375rem;
			right: 0.375rem;
			font-size: 0.65rem;
			padding: 1px 4px;
		}
	}

	/* Extra small screens */
	@media (max-width: 400px) {
		.panel-header {
			padding: 0.25rem 0.375rem;
			min-height: 36px;
		}

		.panel-header h3 {
			font-size: 0.75rem;
		}

		.user {
			padding: 0.375rem;
			min-height: 40px;
		}

		.user-avatar,
		.user-avatar-placeholder {
			width: 28px;
			height: 28px;
		}

		.user-name {
			font-size: 0.8rem;
		}

		.call-buttons {
			gap: 0.125rem;
		}

		.call-btn {
			width: 28px;
			height: 28px;
			font-size: 0.8rem;
		}
	}
</style>
