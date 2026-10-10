<script lang="ts">
	import { currentUser } from '$lib/presenceIdentity';
	import { layoutStore } from '$lib/layoutStore';
	import { profilePanel, profilePanelUser } from '$lib/profilePanelState';
	import { profileIdentity, sameProfileIdentity } from '$lib/profilePanelController';
	import UserPopoutImpl from './UserPopoutImpl.svelte';
	const selectedUser = $derived($profilePanelUser);
	const ownProfile = $derived(sameProfileIdentity(selectedUser, $currentUser));

	function closeProfile() {
		profilePanel.clear();
		layoutStore.closeRightPanel();
	}
</script>

<section class="profile-panel" aria-label="Complete profile">
	{#if selectedUser}
		{#key profileIdentity(selectedUser)}
			<UserPopoutImpl
				user={selectedUser}
				isOpen
				isOwnProfile={ownProfile}
				surface="panel"
				on:close={closeProfile}
			/>
		{/key}
	{:else}
		<div class="profile-panel-empty">
			<h2>Profile</h2>
			<p>Open someone’s profile and use the side-panel icon at the top to view it alongside your conversation.</p>
			{#if $currentUser}
				<button type="button" onclick={() => $currentUser && profilePanel.select($currentUser)}>View my profile</button>
			{/if}
		</div>
	{/if}
</section>

<style>
	.profile-panel { display: flex; flex-direction: column; min-width: 0; min-height: 0; height: 100%; overflow: hidden; }
	.profile-panel-empty { display: grid; gap: 0.75rem; padding: 1.25rem; color: var(--w-mute); }
	.profile-panel-empty h2 { margin: 0; color: var(--w-text); font-size: var(--font-size-lg); }
	.profile-panel-empty p { margin: 0; line-height: 1.5; }
	.profile-panel-empty button { min-height: 44px; border: 1px solid var(--w-line); border-radius: calc(10px * var(--w-rs, 1)); padding: 0.5rem 0.75rem; background: var(--w-raise); color: var(--w-text); cursor: pointer; }
	.profile-panel-empty button:focus-visible { outline: 2px solid var(--w-accent); outline-offset: 2px; }
</style>
