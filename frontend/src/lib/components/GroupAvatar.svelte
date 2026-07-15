<script lang="ts">
	import { currentUser } from '$lib/socket';
	import type { Channel, User } from '$lib/socket';

	export let channel: Channel;
	export let size: number = 36;

	$: avatarMembers = getAvatarMembers(channel);

	function getAvatarMembers(ch: Channel): User[] {
		if (!ch.memberUsers || ch.memberUsers.length === 0) return [];
		// Pick up to 2 members that aren't the current user
		const others = ch.memberUsers.filter(u => {
			if (!$currentUser) return true;
			if (u.id === $currentUser.id) return false;
			if ($currentUser.dbUserId && u.dbUserId === $currentUser.dbUserId) return false;
			return true;
		});
		// If we filtered everyone out (e.g., solo group), fall back to all members
		const pool = others.length > 0 ? others : ch.memberUsers;
		return pool.slice(0, 2);
	}

	$: innerSize = Math.round(size * 0.6);
</script>

{#if channel.avatar}
	<div class="group-avatar" style="width: {size}px; height: {size}px;">
		<img src={channel.avatar} alt={channel.name} class="group-avatar-img" />
	</div>
{:else}
	<div class="group-avatar composite" style="width: {size}px; height: {size}px;">
		{#if avatarMembers.length >= 1}
			<div class="avatar-slot top-left" style="width: {innerSize}px; height: {innerSize}px;">
				{#if avatarMembers[0].profilePicture}
					<img src={avatarMembers[0].profilePicture} alt={avatarMembers[0].username} />
				{:else}
					<div class="avatar-placeholder" style="--avatar-color: {avatarMembers[0].roleColor || avatarMembers[0].color}">
						{avatarMembers[0].username.charAt(0).toUpperCase()}
					</div>
				{/if}
			</div>
		{/if}
		{#if avatarMembers.length >= 2}
			<div class="avatar-slot bottom-right" style="width: {innerSize}px; height: {innerSize}px;">
				{#if avatarMembers[1].profilePicture}
					<img src={avatarMembers[1].profilePicture} alt={avatarMembers[1].username} />
				{:else}
					<div class="avatar-placeholder" style="--avatar-color: {avatarMembers[1].roleColor || avatarMembers[1].color}">
						{avatarMembers[1].username.charAt(0).toUpperCase()}
					</div>
				{/if}
			</div>
		{/if}
		{#if avatarMembers.length === 0}
			<div class="avatar-slot fallback" style="width: {innerSize}px; height: {innerSize}px;">
				<div class="avatar-placeholder" style="--avatar-color: var(--text-secondary)">G</div>
			</div>
		{/if}
	</div>
{/if}

<style>
	.group-avatar {
		border-radius: 50%;
		overflow: hidden;
		flex-shrink: 0;
		position: relative;
		background: var(--surface-base);
	}

	.group-avatar-img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.composite {
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.avatar-slot {
		position: absolute;
		border-radius: 50%;
		overflow: hidden;
	}

	.avatar-slot img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.top-left {
		top: 0;
		left: 0;
	}

	.bottom-right {
		bottom: 0;
		right: 0;
		border: 2px solid var(--surface-base);
	}

	.fallback {
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
	}

	.avatar-placeholder {
		width: 100%;
		height: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		font-weight: 600;
		color: white;
		font-size: 0.65em;
	}

	.avatar-placeholder { background-color: var(--avatar-color, var(--accent-primary-color)); }
</style>
