<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import type { User } from '$lib/socket';
	import ContextMenu from '$lib/components/context-menu/ContextMenu.svelte';
	import type { MenuEntry } from '$lib/components/context-menu/ContextMenu.svelte';

	export let user: User;
	export let x: number;
	export let y: number;
	export let isOwnProfile: boolean;

	const dispatch = createEventDispatcher<{
		close: void;
		voiceCall: void;
		videoCall: void;
		screenShare: void;
		openDM: { user: User };
		requestPayment: { user: User };
		viewProfile: void;
	}>();

	function closeMenu() {
		dispatch('close');
	}

	$: items = buildItems();

	/** Open (Message, View profile) · Call · Share; sentence case, one glyph per meaning (§8.9). */
	function buildItems(): MenuEntry[] {
		const menuItems: MenuEntry[] = [];
		if (!isOwnProfile) {
			menuItems.push({ id: 'message', label: 'Message', icon: 'chat', onSelect: () => { dispatch('openDM', { user }); } });
		}
		menuItems.push({ id: 'view-profile', label: isOwnProfile ? 'View your profile' : 'View profile', icon: 'user', onSelect: () => { dispatch('viewProfile'); } });
		if (!isOwnProfile) {
			menuItems.push(
				{ id: 'call-divider', type: 'separator' },
				{ id: 'voice-call', label: 'Voice call', icon: 'phone', onSelect: () => { dispatch('voiceCall'); } },
				{ id: 'video-call', label: 'Video call', icon: 'video', onSelect: () => { dispatch('videoCall'); } },
				{ id: 'screen-share', label: 'Share screen', icon: 'screen', onSelect: () => { dispatch('screenShare'); } },
				{ id: 'share-divider', type: 'separator' },
				{
					id: 'request-payment',
					label: 'Request payment',
					icon: 'send',
					disabled: !user.dbUserId,
					hint: user.dbUserId ? undefined : 'Registered members only',
					onSelect: () => { dispatch('requestPayment', { user }); }
				}
			);
		}
		return menuItems;
	}
</script>

<ContextMenu
	open={true}
	{x}
	{y}
	{items}
	ariaLabel="User actions"
	headerLabel={user.username}
	headerSubLabel={isOwnProfile ? 'Your profile' : null}
	on:close={closeMenu}
/>
