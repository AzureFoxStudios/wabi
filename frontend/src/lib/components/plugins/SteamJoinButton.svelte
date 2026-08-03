<script lang="ts">
	// SteamJoinButton — inline "Join Game" buttons rendered for any
	// `steam://run/<appid>` deep link in a message. Clicking launches the game
	// via the OS Steam protocol handler. On mobile/web the link is a no-op and
	// degrades gracefully (per docs/steam-integration-proposal.md). Detection
	// is text-driven, so it works for history, live messages, and even when the
	// socket `steam_join` event is unavailable.

	let { messageText = '' }: { messageText?: string } = $props();

	const appids = $derived.by(() => {
		const found: number[] = [];
		const re = /steam:\/\/run\/(\d+)/g;
		let match: RegExpExecArray | null;
		while ((match = re.exec(messageText)) !== null) {
			const appid = Number(match[1]);
			if (Number.isSafeInteger(appid) && appid > 0 && !found.includes(appid)) {
				found.push(appid);
			}
		}
		return found;
	});

	function openSteam(appid: number): void {
		window.location.href = `steam://run/${appid}`;
	}
</script>

{#if appids.length > 0}
	<div class="steam-join-row">
		{#each appids as appid (appid)}
			<button
				type="button"
				class="steam-join-button"
				onclick={() => openSteam(appid)}
				title={`Launch via Steam (steam://run/${appid})`}
			>
				<span class="steam-join-icon" aria-hidden="true">
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M11.982 21.853c-2.863.023-5.308-1.493-6.12-3.966l4.583 2.415c1.205.64 2.71.17 3.35-1.035l.654-1.238a2.32 2.32 0 0 0-.885-3.111l-4.793-2.583a3.734 3.734 0 0 0-5.33 1.797c-.258.57-.364 1.159-.376 1.723.45-3.942 3.733-7.04 7.878-7.115a7.9 7.9 0 0 1 7.908 7.89 7.907 7.907 0 0 1-7.87 7.932Zm5.316-13.565a2.807 2.807 0 1 0-.001 5.615 2.807 2.807 0 0 0 0-5.615Zm-1.174 2.832a1.632 1.632 0 1 1 3.264-.001 1.632 1.632 0 0 1-3.264 0Zm-9.39 4.307.14 1.51 1.254.67a1.496 1.496 0 1 1-1.543.327l-.018.009a2.45 2.45 0 1 0 2.045-1.416l-1.878-1.1Z"/></svg>
				</span>
				<span class="steam-join-label">Join Game</span>
			</button>
		{/each}
	</div>
{/if}
