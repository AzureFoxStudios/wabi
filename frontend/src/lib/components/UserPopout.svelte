<script lang="ts">
	import UserPopoutImpl from './UserPopoutImpl.svelte';
	import type { User } from '$lib/socket';

	export let user: User | null = null;
	export let isOpen = false;
	export let anchorElement: HTMLElement | null = null;
	export let isOwnProfile = false;
</script>

<UserPopoutImpl
	{user}
	bind:isOpen
	{anchorElement}
	{isOwnProfile}
	on:close
	on:openFullProfile
/>
