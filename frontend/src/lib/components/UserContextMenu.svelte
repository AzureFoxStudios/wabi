<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import type { User } from '$lib/socket';
	import ContextMenu from '$lib/components/context-menu/ContextMenu.svelte';
	import type { ContextMenuItem } from '$lib/context-menu/types';

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
		viewProfile: void;
	}>();

	function closeMenu() {
		dispatch('close');
	}

	$: items = buildItems();

	function buildItems(): ContextMenuItem[] {
		const menuItems: ContextMenuItem[] = [];

		if (!isOwnProfile) {
			menuItems.push(
				{
					id: 'message',
					label: 'Send Message',
					leading: '💬',
					onSelect: () => {
						dispatch('openDM', { user });
					}
				},
				{
					id: 'voice-call',
					label: 'Voice Call',
					leading: '📞',
					onSelect: () => {
						dispatch('voiceCall');
					}
				},
				{
					id: 'video-call',
					label: 'Video Call',
					leading: '🎥',
					onSelect: () => {
						dispatch('videoCall');
					}
				},
				{
					id: 'screen-share',
					label: 'Screen Share',
					leading: '🖥',
					onSelect: () => {
						dispatch('screenShare');
					}
				},
				{ id: 'divider-1', type: 'separator' }
			);
		}

		menuItems.push({
			id: 'view-profile',
			label: 'View Profile',
			leading: '👤',
			onSelect: () => {
				dispatch('viewProfile');
			}
		});

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
	headerSubLabel={isOwnProfile ? 'Your profile' : 'User options'}
	on:close={closeMenu}
/>
