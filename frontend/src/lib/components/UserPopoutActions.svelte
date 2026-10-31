<!--
	The popout's action row (design contract §8.9): one primary, one default and a ⋯ menu.

	- Someone else: "Message" (ink primary), "Call" (default) and ⋯ with video, screen share,
	  friends, the nickname on this device and moderation (seal glyphs, ban last in danger).
	- You: "Edit profile" (primary), "View full profile" and, with an account, ⋯ › Games.
	Rows come from userPopoutModel.buildProfileMenu; confirms go through confirmAction.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { _ } from '$lib/i18n';
	import { openGames } from '$lib/games/navigation';
	import { getAuthToken } from '$lib/authSession';
	import { confirmAction } from '$lib/confirm';
	import Icon from '$lib/components/ui/Icon.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';

	import type { User } from '$lib/socket';
	import { canFriendUser as isFriendEligible, friendshipRelation } from '$lib/friendshipRelation';
	import { acceptFriendship, dismissFriendship, friendships, removeFriendship, requestFriendship, startFriendshipSync } from '$lib/friendships';
	import { buildProfileMenu } from './userPopoutModel';

	export let isOwnProfile = false;
	export let profileExpanded = false;
	export let inSidePanel = false;
	export let localNicknamesEnabled = false;
	export let localNickname = '';
	export let user: User | null = null;
	export let onClose: () => void = () => {};
	export let onOpenDM: () => void = () => {};
	export let onOpenFullProfile: () => void = () => {};
	export let onEditProfile: () => void = () => {};
	export let onVoiceCall: () => void = () => {};
	export let onVideoCall: () => void = () => {};
	export let onScreenShare: () => void = () => {};
	export let onSetLocalNickname: () => void = () => {};
	export let onClearLocalNickname: () => void = () => {};
	export let canManageRoles = false;
	export let targetRole: string = 'member';
	export let roles: Array<{ roleName: string; displayName: string }> = [];
	export let hiddenRoleCount = 0;
	export let roleActionStatus = '';
	export let onSetRole: (role: string) => void = () => {};
	export let isBanned = false;
	export let banActionStatus = '';
	export let onBanUser: () => void = () => {};
	export let onUnbanUser: () => void = () => {};

	let friendActionBusy = false;
	let friendActionError = '';
	$: friendRelation = friendshipRelation($friendships, user?.dbUserId);
	$: canFriendUser = isFriendEligible(user) && Boolean(getAuthToken()) && $friendships.ready;
	onMount(startFriendshipSync);

	async function handleFriendAction() {
		if (!canFriendUser || !user?.dbUserId || friendActionBusy || !$friendships.ready) return;
		friendActionBusy = true;
		friendActionError = '';
		try {
			if (friendRelation.kind === 'none') await requestFriendship(user.dbUserId);
			else if (friendRelation.kind === 'incoming') await acceptFriendship(friendRelation.request.id);
			else if (friendRelation.kind === 'outgoing') await dismissFriendship(friendRelation.request.id);
		} catch (error) {
			console.warn('[profile] friendship update failed', error);
			friendActionError = "Couldn't update the friendship. Nothing changed.";
		} finally {
			friendActionBusy = false;
		}
	}

	async function handleRemoveFriend() {
		if (!user?.dbUserId || friendActionBusy) return;
		const name = user.username;
		const confirmed = await confirmAction({
			title: `Remove ${name} from your friends?`,
			body: 'You can send a new friend request later.',
			confirm: 'Remove friend',
			danger: true
		});
		if (!confirmed || !user?.dbUserId) return;
		friendActionBusy = true;
		friendActionError = '';
		try {
			await removeFriendship(user.dbUserId);
		} catch (error) {
			console.warn('[profile] remove friend failed', error);
			friendActionError = `Couldn't remove ${name}. You are still friends.`;
		} finally {
			friendActionBusy = false;
		}
	}

	function handleOpenGames() {
		if (!user?.dbUserId) return;
		const profile = { profileId: String(user.dbUserId), label: user.username };
		onClose();
		openGames(profile);
	}

	$: friendState = (friendRelation.kind === 'friend' || friendRelation.kind === 'incoming' || friendRelation.kind === 'outgoing'
		? friendRelation.kind
		: 'none') as 'none' | 'incoming' | 'outgoing' | 'friend';
	$: menuItems = buildProfileMenu({
		isOwnProfile,
		hasAccount: Boolean(user?.dbUserId),
		profileExpanded,
		inSidePanel,
		friendsReady: $friendships.ready,
		canFriend: canFriendUser,
		friendState,
		friendBusy: friendActionBusy,
		localNicknamesEnabled,
		localNickname,
		canManageRoles: canManageRoles && Boolean(user),
		targetRole,
		roles,
		isBanned,
		onOpenFullProfile,
		onOpenGames: handleOpenGames,
		onVideoCall,
		onScreenShare,
		onFriendAction: () => void handleFriendAction(),
		onRemoveFriend: () => void handleRemoveFriend(),
		onSetLocalNickname,
		onClearLocalNickname,
		onSetRole,
		onBanUser,
		onUnbanUser
	});
	$: displayName = user?.username ?? '';
	$: statusLines = [
		friendRelation.kind === 'friend' && !isOwnProfile ? 'Friends' : '',
		roleActionStatus,
		banActionStatus,
		canManageRoles && hiddenRoleCount > 0 ? `${hiddenRoleCount} more role${hiddenRoleCount === 1 ? '' : 's'} in the member list` : ''
	].filter(Boolean);
</script>

<div class="pop-actions">
	{#if isOwnProfile}
		<button type="button" class="w-btn w-btn--primary pop-actions__main" on:click={onEditProfile}>
			<Icon name="pencil" size={16} />{$_('user.popout.edit_profile')}
		</button>
		<button type="button" class="w-btn pop-actions__second" data-profile-expand on:click={onOpenFullProfile}>
			{profileExpanded ? (inSidePanel ? 'Return to side panel' : 'Back to popout') : $_('user.popout.view_full_profile')}
		</button>
		{#if user?.dbUserId}
			<Menu items={menuItems.filter((item) => item.id === 'games')} label="More for your profile" triggerLabel="More" class="w-ibtn pop-actions__more" align="end" heading={displayName}>
				<Icon name="more" size={18} />
			</Menu>
		{/if}
	{:else}
		<button type="button" class="w-btn w-btn--primary pop-actions__main" on:click={onOpenDM}>
			<Icon name="chat" size={16} />{$_('user.popout.message')}
		</button>
		<button type="button" class="w-btn pop-actions__second" on:click={onVoiceCall}>
			<Icon name="phone" size={16} />{$_('user.popout.call')}
		</button>
		<Menu items={menuItems} label="More for {displayName}" triggerLabel="More for {displayName}" class="w-ibtn pop-actions__more" align="end" heading={displayName} data-profile-expand>
			<Icon name="more" size={18} />
		</Menu>
	{/if}
</div>

{#if statusLines.length}
	<p class="pop-actions__status" role="status">{statusLines.join(' · ')}</p>
{/if}
{#if friendActionError}
	<p class="pop-actions__error" role="alert"><Icon name="alert" size={14} />{friendActionError}</p>
{/if}
