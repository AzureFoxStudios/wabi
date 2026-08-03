<script lang="ts">
	import { currentUser } from '$lib/socket';
	import type { User } from '$lib/socket';
	import { steamStatusStore } from '$lib/steam/steamStatusStore';

	// SteamStatusBadge — inline "🎮 Playing <game>" badge shown next to a
	// message sender's name. The Steam addon is opt-in: only the current
	// user's own status is shared (their Steam id lives in localStorage), so
	// the badge renders for their own messages. Display-only per the proposal
	// ("@PlayerName 🎮 Playing Counter-Strike 2"); the Join Game button is a
	// separate, text-driven component (SteamJoinButton).

	let { user }: { user?: User | null } = $props();

	const isSelf = $derived(!!user && !!$currentUser && user.id === $currentUser.id);

	const status = $derived($steamStatusStore.status);

	const showBadge = $derived(!!status && status.inGame && !!status.gameName && isSelf);

	const gameName = $derived(showBadge ? status!.gameName! : '');

	const appid = $derived(showBadge ? status!.gameId ?? null : null);

	const tooltip = $derived.by(() => {
		if (!showBadge) return '';
		const base = `Playing ${gameName}`;
		const rich = status!.richPresence;
		return rich && rich !== gameName ? `${base} — ${rich}` : base;
	});
</script>

{#if showBadge}
	<span class="steam-status-badge" title={tooltip}>
		<span class="steam-status-icon" aria-hidden="true">
			<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M11.982 21.853c-2.863.023-5.308-1.493-6.12-3.966l4.583 2.415c1.205.64 2.71.17 3.35-1.035l.654-1.238a2.32 2.32 0 0 0-.885-3.111l-4.793-2.583a3.734 3.734 0 0 0-5.33 1.797c-.258.57-.364 1.159-.376 1.723.45-3.942 3.733-7.04 7.878-7.115a7.9 7.9 0 0 1 7.908 7.89 7.907 7.907 0 0 1-7.87 7.932Zm5.316-13.565a2.807 2.807 0 1 0-.001 5.615 2.807 2.807 0 0 0 0-5.615Zm-1.174 2.832a1.632 1.632 0 1 1 3.264-.001 1.632 1.632 0 0 1-3.264 0Zm-9.39 4.307.14 1.51 1.254.67a1.496 1.496 0 1 1-1.543.327l-.018.009a2.45 2.45 0 1 0 2.045-1.416l-1.878-1.1Z"/></svg>
		</span>
		<span class="steam-status-text">
			{#if appid}
				<a
					class="steam-status-game"
					href={`steam://run/${appid}`}
					rel="noopener noreferrer"
				>{gameName}</a>
			{:else}
				{gameName}
			{/if}
		</span>
	</span>
{/if}
