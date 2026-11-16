<script lang="ts">
	import { _ } from '$lib/i18n';
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
			? $_('conn_diag.no_call')
			: $callTransportState.activeTransport === 'wabidb'
			? $_('calls.route_server')
			: $callTransportState.activeTransport === 'p2p'
				? $_('calls.route_direct')
					: $_('conn_diag.media_server_route')
	);

	/** Plain words for why spatial audio is not running; never the raw reason code. */
	const SPATIAL_REASONS: Record<string, string> = {
		unsupported: $_('conn_diag.reason_unsupported'),
		weak_device: $_('conn_diag.reason_weak_device')
	};

	const spatialWord = $derived(
		$spatialAudioRuntimeStatus.active
			? $spatialAudioRuntimeStatus.effectiveMode === 'full_3d'
				? $_('conn_diag.spatial_on_3d')
					: $_('conn_diag.spatial_on_stereo')
			: $spatialAudioRuntimeStatus.fallbackReason
				? $_('conn_diag.spatial_off_reason', { values: { reason: SPATIAL_REASONS[$spatialAudioRuntimeStatus.fallbackReason] ?? $_('conn_diag.not_available') } })
				: $_('audio_settings.off')
	);

	/** "Relay (TURN), media server" — the services this server says it runs. */
	function servicesWord(runtime: ServerMediaRuntimeResponse | null): string {
		const components = runtime?.media?.boosterRelay?.components;
		const turn = runtime?.media?.turn?.configured || components?.turnConfigured;
		const parts: string[] = [];
		if (turn) parts.push($_('conn_diag.relay_turn'));
		if (components?.sfuConfigured) parts.push($_('conn_diag.media_server'));
		if (components?.gatewayConfigured) parts.push(components.gatewayHealthy && components.gatewayMediaPlaneReady ? $_('conn_diag.gateway') : $_('conn_diag.gateway_starting'));
		if (!parts.length) return $_('conn_diag.services_none');
		const text = parts.join(', ');
		return text.charAt(0).toUpperCase() + text.slice(1);
	}
</script>

<div class="conn-facts" aria-label={$_('conn_diag.label')}>
	<p class="w-kicker conn-facts__kicker">{$_('conn_diag.right_now')}</p>
	<dl class="conn-facts__list">
		<dt>{$_('conn_diag.last_route')}</dt>
		<dd>{routeWord}</dd>
		<dt>{$_('audio_settings.spatial_audio')}</dt>
		<dd>{spatialWord}</dd>
		<dt>{$_('conn_diag.offers')}</dt>
		<dd>{loaded ? servicesWord(mediaRuntimeSnapshot) : $_('privacy.state.checking_short')}</dd>
	</dl>
	{#if requestedRelay !== 'off' && requestedRelay !== effectiveRelay}
		<p class="conn-facts__note">{$_('conn_diag.relay_note')}</p>
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
