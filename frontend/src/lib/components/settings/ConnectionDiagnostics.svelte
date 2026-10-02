<script lang="ts">
 import { onMount } from 'svelte';
 import { activeServerUrl } from '$lib/serverUrl';
 import { callTransportState, spatialAudioRuntimeStatus, spatialAudioDiagnostics } from '$lib/calling';
 import { loadEffectiveMediaSettingsSnapshot, getBoosterRelayRequestedMode, getBoosterRelayEffectiveMode, type ServerMediaRuntimeResponse, type BoosterRelayMode } from '$lib/mediaRuntime';
 let mediaRuntimeSnapshot = $state<ServerMediaRuntimeResponse | null>(null);
 const boosterRelayRequestedMode = $derived(getBoosterRelayRequestedMode(mediaRuntimeSnapshot));
 const boosterRelayEffectiveMode = $derived(getBoosterRelayEffectiveMode(mediaRuntimeSnapshot));
 onMount(() => {
  let generation = 0;
  const unsubscribe = activeServerUrl.subscribe(() => {
   const request = ++generation; mediaRuntimeSnapshot = null;
   void loadEffectiveMediaSettingsSnapshot().then(snapshot => { if (generation === request) mediaRuntimeSnapshot = snapshot.runtime; }).catch(() => {});
  });
  return () => { generation++; unsubscribe(); };
 });
	function getBoosterRelayModeLabel(mode: BoosterRelayMode): string { switch (mode) { case 'turn-only': return 'TURN only'; case 'turn-sfu': return 'TURN + SFU'; case 'turn-sfu-gateway': return 'TURN + SFU + Gateway'; default: return 'Off'; } }
	function getBoosterRelayComponentsSummary(runtime: ServerMediaRuntimeResponse | null): string { const components = runtime?.media?.boosterRelay?.components; if (!components) return 'No booster relay components advertised.'; return [`TURN ${components.turnConfigured ? 'ready' : 'off'}`, `SFU ${components.sfuConfigured ? 'ready' : 'off'}`, `Gateway ${components.gatewayConfigured ? components.gatewayHealthy && components.gatewayMediaPlaneReady ? 'ready' : 'starting' : 'off'}`].join(' | '); }
	function getBoosterRelaySelfAdvertisementSummary(runtime: ServerMediaRuntimeResponse | null): string { const advertisement = runtime?.media?.boosterRelay?.selfAdvertisement; if (!advertisement) return 'Self-advertised relay node: unknown.'; if (!advertisement.advertised) return 'Self-advertised relay node: not registered.'; const location = advertisement.url || '(missing URL)'; const relayId = advertisement.relayId ? `, ID ${advertisement.relayId}` : ''; return `Self-advertised relay node: ${advertisement.status || 'unknown'} at ${location}${relayId}.`; }
	function formatRuntimeTime(timestamp: number | null): string { if (!timestamp) return 'never'; return new Date(timestamp).toLocaleTimeString(); }
</script>

	<details class="audio-settings-group">
		<summary>Troubleshooting · Connection diagnostics</summary>
		<div class="audio-details-body">
			<p class="runtime-note">Transport runtime: <strong>{$callTransportState.activeTransport.toUpperCase()}</strong></p>
			{#if $spatialAudioRuntimeStatus.active || $spatialAudioRuntimeStatus.fallbackReason}<p class="runtime-note">Spatial runtime: <strong>{$spatialAudioRuntimeStatus.effectiveMode.toUpperCase()}</strong> {#if $spatialAudioRuntimeStatus.fallbackReason}({$spatialAudioRuntimeStatus.fallbackReason.replaceAll('_', ' ')}){/if}</p>{/if}
			<p class="runtime-note">Spatial sources: <strong>{$spatialAudioDiagnostics.totalSources}</strong> (call {$spatialAudioDiagnostics.callSources}, share {$spatialAudioDiagnostics.shareSources})</p>
			<p class="runtime-note">Spatial seats: call {$spatialAudioDiagnostics.callSeatSlots}, share {$spatialAudioDiagnostics.shareSeatSlots}. Last sync {formatRuntimeTime($spatialAudioDiagnostics.lastUpdatedAt)}.</p>
			{#if mediaRuntimeSnapshot?.media?.boosterRelay}
				<p class="runtime-note">Server booster relay: requested {getBoosterRelayModeLabel(boosterRelayRequestedMode)}, effective {getBoosterRelayModeLabel(boosterRelayEffectiveMode)}.</p>
				<p class="runtime-note">{getBoosterRelayComponentsSummary(mediaRuntimeSnapshot)}</p>
				<p class="runtime-note">{getBoosterRelaySelfAdvertisementSummary(mediaRuntimeSnapshot)}</p>
				{#if mediaRuntimeSnapshot.media.boosterRelay.selfAdvertisement?.reason}<p class="runtime-note">{mediaRuntimeSnapshot.media.boosterRelay.selfAdvertisement.reason}</p>{/if}
				{#if boosterRelayRequestedMode !== 'off' && boosterRelayRequestedMode !== boosterRelayEffectiveMode}<p class="runtime-note">The host requested relay components that this runtime does not expose. The server operator may need to start the matching deployment services.</p>{/if}
			{/if}
		</div>
	</details>
<style>
 details { margin-top: 16px; border: 1px solid var(--border-subtle); border-radius: var(--radius-lg); background: var(--surface-base); }
 summary { min-height: 44px; padding: 12px 16px; box-sizing: border-box; cursor: pointer; color: var(--text-heading); font-weight: 600; }
 .audio-details-body { padding: 0 16px 16px; }
 .runtime-note { color: var(--text-secondary); line-height: 1.5; overflow-wrap: anywhere; }
</style>
