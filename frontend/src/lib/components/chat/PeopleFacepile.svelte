<!--
	The phone bar's People facepile (design contract §8.12): up to three 24px stamps overlapping by
	7px, each ringed 2px in --w-bg, then how many people are here now in --w-t-micro mono. It opens
	People as a sheet (phones show every side panel as one).

	When the bar is short of room the stamps give way before the channel name's 96px floor and the
	"Chat ▾" label: the pile is a one-line wrapping row of fixed height, so a stamp that no longer
	fits drops out whole, never half-clipped (stagebar.css). Below a 380px stage there is no room
	for it beside the name's floor, the whole "Chat" and search + ⋯: it steps aside and People
	stays in the Workspaces sheet.
-->
<script lang="ts">
	import { currentUser, users } from '$lib/socket';
	import { openRightPanel } from '$lib/layoutStoreRightPanel';
	import { mediaUrl } from '$lib/mediaUrl';
	import { inkFor } from '$lib/theme/identity';
	import { _ } from '$lib/i18n';
	import { facepileOf } from '../userPanelHelpers';

	// Everyone connected (the viewer always counts as here), as in the People companion.
	const pile = $derived(facepileOf({ online: $currentUser ? [$currentUser, ...$users] : $users, self: $currentUser ?? null }));
	const label = $derived(`${$_('places.people')}, ${pile.count} here now`);
	const initial = (name: string | undefined) => (name || '?').trim().charAt(0).toUpperCase() || '?';
</script>

<button type="button" class="stage-people" aria-label={label} title={label} onclick={() => openRightPanel('users')}>
	{#if pile.faces.length}
		<span class="stage-people__pile" aria-hidden="true">
			{#each pile.faces as face (face.dbUserId ?? face.id)}
				{#if face.profilePicture}
					<img class="stage-people__stamp" src={mediaUrl(face.profilePicture)} alt="" />
				{:else}
					<span class="stage-people__stamp stage-people__stamp--initial" style={$inkFor(face.roleColor || face.color)}>{initial(face.username)}</span>
				{/if}
			{/each}
		</span>
	{/if}
	<span class="stage-people__count" aria-hidden="true">{pile.count}</span>
</button>
