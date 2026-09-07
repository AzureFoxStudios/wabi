<script lang="ts">
	import LoreConnectPanel from '../src/lib/components/sidebar/LoreConnectPanel.svelte';
	let channelKey = $state('ch_65');
	let open = $state(false);
	export function selectChannel(key: string) { channelKey = key; open = true; }
</script>

<button id="open-connect" onclick={() => (open = true)}>Open Connect</button>
{#if open}
	<LoreConnectPanel {channelKey} repoId={999} repoName="Test project" onclose={() => (open = false)} />
{/if}
