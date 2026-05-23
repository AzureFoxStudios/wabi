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
	import { queueConversationPaymentLaunch, type ConversationPaymentSurface } from '$lib/payments/paymentLaunch';
	import {
		isCurrentUserEntry,
		formatBadge,
		getStatusColor,
		computeTotalUnreadDMs,
		getUserUnreadCount,
		createSyntheticMouseEvent,
		extractUserFromEvent
	} from './userPanelHelpers';
	import './userPanel.css';

	const dispatch = createEventDispatcher();

	function getDMChannelId(user: User): string {
		return getDMChannelIdForUser($currentUser, user);
	}

	$: totalUnreadDMs = computeTotalUnreadDMs($channelUnreadCounts);

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
		popoutIsOwnProfile = isCurrentUserEntry(user, $currentUser);
		popoutAnchorElement = anchorEl || null;
		showUserPopout = true;
	}

	function handleUserLongPress(event: TouchEvent, user: User) {
		const touch = event.touches?.[0] || event.changedTouches?.[0];
		if (!touch) return;
		handleContextMenu(createSyntheticMouseEvent(touch), user);
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
		let user: User | null = extractUserFromEvent(event, contextMenuUser);
		if (!user) return;

		const dmId = getDMChannelIdForUser($currentUser, user);
		const existingDM = $channels.find(ch => ch.id === dmId);

		if (existingDM) {
			dispatch('openDM', { channelId: dmId, otherUser: user });
		} else {
			createDM(user.id);
			const unsubscribe = channels.subscribe(chs => {
				const newDM = chs.find(ch => ch.id === dmId || (ch.type === 'dm' && ch.otherUser?.id === user.id));
				if (newDM) {
					dispatch('openDM', { channelId: newDM.id, otherUser: user });
					unsubscribe();
				}
			});
		}
		dispatch('close');
	}

	function handlePaymentLaunch(surface: ConversationPaymentSurface, event?: CustomEvent<{ user: User }> | User): void {
		let user: User | null = extractUserFromEvent(event, contextMenuUser);
		if (!user || isCurrentUserEntry(user, $currentUser) || !user.dbUserId) return;
		queueConversationPaymentLaunch({ surface, targetUserId: user.id, targetDbUserId: user.dbUserId });
		handleOpenDM(user);
	}

	function openDMModal() { showDMModal = true; }

	function handleLogout() {
		try {
			clearAuthSession();
			clearStoredIdentity();
		} catch (e) {
			console.error('Failed to clear session data:', e);
		}
		dispatch('logout');
	}

	async function handleVoiceCall(event?: MouseEvent, user?: User) {
		if (event) event.stopPropagation();
		const targetUser = user || contextMenuUser;
		if (!$socket || !targetUser || isCurrentUserEntry(targetUser, $currentUser)) return;
		try {
			await startCall($socket, getUserIdentityKey(targetUser), false, { scope: 'dm', displayName: targetUser.username });
		} catch (error) {
			console.warn('[Call] Voice call failed to start:', error);
		}
	}

	async function handleVideoCall(event?: MouseEvent, user?: User) {
		if (event) event.stopPropagation();
		const targetUser = user || contextMenuUser;
		if (!$socket || !targetUser || isCurrentUserEntry(targetUser, $currentUser)) return;
		try {
			await startCall($socket, getUserIdentityKey(targetUser), true, { scope: 'dm', displayName: targetUser.username });
		} catch (error) {
			console.warn('[Call] Video call failed to start:', error);
		}
	}

	async function handleScreenShare(event?: MouseEvent, user?: User) {
		if (event) event.stopPropagation();
		const targetUser = user || contextMenuUser;
		if (!$socket || !targetUser || isCurrentUserEntry(targetUser, $currentUser)) return;
		try {
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
				role="group"
				on:contextmenu={(e) => handleContextMenu(e, user)}
				use:longpress={{ onLongPress: (e) => handleUserLongPress(e, user) }}
			>
				<!-- Profile Picture or Placeholder -->
				<button class="user-avatar-button" on:click|stopPropagation={(e) => openProfile(user, e.currentTarget as HTMLElement)}>
					{#if user.profilePicture}
						<img src={user.profilePicture} alt={user.username} class="user-avatar" />
					{:else}
						<div class="user-avatar-placeholder" style="--avatar-color: {user.color}">
							{user.username.charAt(0).toUpperCase()}
						</div>
					{/if}
				</button>

				<!-- Username and Status -->
				<button
					class="user-info-button"
					on:click={(e) => {
						if (!isCurrentUserEntry(user, $currentUser)) {
							handleOpenDM(user);
						} else {
							openProfile(user, e.currentTarget as HTMLElement);
						}
					}}
				>
					<div class="user-info">
						<span class="user-name">
							{user.username}
							{#if isCurrentUserEntry(user, $currentUser)}<span class="you-badge">({$_('user.you')})</span>{/if}
						</span>
						<div class="user-status">
							<span class="status-dot" style="--status-color: {getStatusColor(user.status)}"></span>
							<span class="status-text">{user.status}</span>
						</div>
					</div>
				</button>

				<!-- Unread badge for DMs -->
				{#if !isCurrentUserEntry(user, $currentUser) && getUserUnreadCount(user, $channelUnreadCounts, getDMChannelIdForUser, $currentUser) > 0}
					<span class="unread-badge">{formatBadge(getUserUnreadCount(user, $channelUnreadCounts, getDMChannelIdForUser, $currentUser))}</span>
				{/if}

				<!-- Call buttons (only show for other users) -->
				{#if !isCurrentUserEntry(user, $currentUser)}
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
		isOwnProfile={isCurrentUserEntry(contextMenuUser, $currentUser)}
		on:close={closeContextMenu}
		on:voiceCall={() => handleVoiceCall(undefined, contextMenuUser)}
		on:videoCall={() => handleVideoCall(undefined, contextMenuUser)}
		on:screenShare={() => handleScreenShare(undefined, contextMenuUser)}
		on:openDM={handleOpenDM}
		on:requestPayment={(event) => handlePaymentLaunch('payment_request', event)}
		on:recordManualCash={(event) => handlePaymentLaunch('manual_cash', event)}
		on:viewProfile={() => {
			if (contextMenuUser) openProfile(contextMenuUser);
		}}
	/>
{/if}

<CreateDMModal bind:isOpen={showDMModal} />

