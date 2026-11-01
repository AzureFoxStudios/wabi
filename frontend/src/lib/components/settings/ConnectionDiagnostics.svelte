<script lang="ts">
	/**
	 * Connection facts for Settings › Audio & video › Troubleshooting (§8.9, §9.4): the route your
	 * calls use, spatial audio state and which relay services this server offers, in plain words.
	 * No transport enums, no relay ids or URLs; that detail belongs to the server's operators.
	 */
	import { onMount } from 'svelte';
	import { activeServerUrl } from '$lib/serverUrl';
	import { callTransportState, spatialAudioRuntimeStatus } from '$lib/calling';
	import { loadEffectiveMediaSettingsSnapshot, getBoosterRelayRequestedMode, getBoosterRelayEffectiveMode, type ServerMediaRuntimeResponse } from '$lib/mediaRuntime';

	let mediaRuntimeSnapshot = $state<ServerMediaRuntimeResponse | null>(null);
	let loaded = $state(false);
	const requestedRelay = $derived(getBoosterRelayRequestedMode(mediaRuntimeSnapshot));
	const effectiveRelay = $derived(getBoosterRelayEffectiveMode(mediaRuntimeSnapshot));

	onMount(() => {
		let generation = 0;
		const unsubscribe = activeServerUrl.subscribe(() => {
			const request = ++generation;
			mediaRuntimeSnapshot = null;
			loaded = false;
			void loadEffectiveMediaSettingsSnapshot()
				.then((snapshot) => {
					if (generation === request) mediaRuntimeSnapshot = snapshot.runtime;
				})
				.catch(() => {})
				.finally(() => {
					if (generation === request) loaded = true;
				});
		});
		return () => {
			generation++;
			unsubscribe();
		};
	});

	const routeWord = $derived(
		$callTransportState.checkedAt === null
			? 'No call yet in this session'
			: $callTransportState.activeTransport === 'wabidb'
			? 'Through this server'
			: $callTransportState.activeTransport === 'p2p'
				? 'Direct (peer-to-peer)'
				: 'Through a media server'
	);

	/** Plain words for why spatial audio is not running; never the raw reason code. */
	const SPATIAL_REASONS: Record<string, string> = {
		unsupported: "this browser can't place voices",
		weak_device: 'this device is keeping calls smooth'
	};

	const spatialWord = $derived(
		$spatialAudioRuntimeStatus.active
			? $spatialAudioRuntimeStatus.effectiveMode === 'full_3d'
				? 'On, full 3D'
				: 'On, stereo'
			: $spatialAudioRuntimeStatus.fallbackReason
				? `Off, ${SPATIAL_REASONS[$spatialAudioRuntimeStatus.fallbackReason] ?? 'not available right now'}`
				: 'Off'
	);

	/** "Relay (TURN), media server" — the services this server says it runs. */
	function servicesWord(runtime: ServerMediaRuntimeResponse | null): string {
		const components = runtime?.media?.boosterRelay?.components;
		const turn = runtime?.media?.turn?.configured || components?.turnConfigured;
		const parts: string[] = [];
		if (turn) parts.push('relay (TURN)');
		if (components?.sfuConfigured) parts.push('media server');
		if (components?.gatewayConfigured) parts.push(components.gatewayHealthy && components.gatewayMediaPlaneReady ? 'streaming gateway' : 'streaming gateway (starting)');
		if (!parts.length) return 'None. Calls connect directly or through this server.';
		const text = parts.join(', ');
		return text.charAt(0).toUpperCase() + text.slice(1);
	}
</script>

<div class="conn-facts" aria-label="Connection facts">
	<p class="w-kicker conn-facts__kicker">Right now</p>
	<dl class="conn-facts__list">
		<dt>Last call route</dt>
		<dd>{routeWord}</dd>
		<dt>Spatial audio</dt>
		<dd>{spatialWord}</dd>
		<dt>This server offers</dt>
		<dd>{loaded ? servicesWord(mediaRuntimeSnapshot) : 'Checking…'}</dd>
	</dl>
	{#if requestedRelay !== 'off' && requestedRelay !== effectiveRelay}
		<p class="conn-facts__note">Some relay services this server asks for are not running. Its operators may need to start them.</p>
	{/if}
</div>

<style>
	.conn-facts {
		padding: 12px 0 4px;
	}
	.conn-facts__kicker {
		margin: 0 0 8px;
	}
	.conn-facts__list {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr);
		gap: 6px 14px;
		margin: 0;
	}
	.conn-facts__list dt {
		color: var(--w-faint);
		font: var(--w-t-small);
	}
	.conn-facts__list dd {
		margin: 0;
		color: var(--w-text);
		font: var(--w-t-small);
		overflow-wrap: anywhere;
	}
	.conn-facts__note {
		margin: 10px 0 0;
		color: var(--w-mute);
		font: var(--w-t-small);
	}
</style>
