<script lang="ts" context="module">
	import type { User } from '$lib/socket';

	export function getAddressableUsers(
		channel: { type?: string; members?: string[]; name?: string } | undefined,
		currentUser: User | null | undefined,
		users: User[]
	): User[] {
		if (channel?.type === 'group' && Array.isArray(channel.members) && channel.members.length > 0) {
			const memberIds = new Set(channel.members);
			return users.filter((user) => {
				const stableId = user.dbUserId ? `user-${user.dbUserId}` : user.id;
				return memberIds.has(stableId) || memberIds.has(user.id);
			});
		}
		return users.filter((user) => {
			if (!currentUser) return true;
			if (user.id === currentUser.id) return false;
			if (user.dbUserId && currentUser.dbUserId && user.dbUserId === currentUser.dbUserId) return false;
			return true;
		});
	}
</script>

<script lang="ts">
	import DMMessageViewContent from './dm/DMMessageViewContent.svelte';

	const forwardedProps = $$props as any;
</script>

<DMMessageViewContent {...forwardedProps} on:openSettings />
