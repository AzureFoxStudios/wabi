<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import { on } from 'svelte/events';
  import { get } from 'svelte/store';
  import { _ } from '$lib/i18n';
  import {
    startRecording as engineStart,
    stopRecording as engineStop,
    stopAll as engineStopAll,
    cleanupVisualization,
    loadDevices as engineLoadDevices,
    getDeviceLabel as engineGetDeviceLabel,
    formatTime,
    drawWaveform,
    type RecordingState
  } from './audioRecorderEngine';

  export let isOpen = false;

  const dispatch = createEventDispatcher<{ close: void; send: Blob }>();
  const t = (key: string) => get(_)(key);
  const MAX_DURATION = 300;

  let state: RecordingState = 'idle';
  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let duration = 0;
  let audioBlob: Blob | null = null;
  let audioUrl: string | null = null;
  let canvasElement: HTMLCanvasElement;
  let error: string | null = null;
  let permissionDenied = false;
  let audioElement: HTMLAudioElement;
  let availableDevices: MediaDeviceInfo[] = [];
  let selectedDeviceId: string = '';
  let devicesLoaded = false;
  let micTestLevel = 0;
  let isPreviewPlaying = false;

  async function loadDevices() {
    availableDevices = await engineLoadDevices();
    if (availableDevices.length > 0 && !selectedDeviceId) selectedDeviceId = availableDevices[0].deviceId;
    devicesLoaded = true;
  }

  function getDeviceLabel(device: MediaDeviceInfo, index: number): string {
    return engineGetDeviceLabel(device, index, t);
  }

  async function startRecording() {
    error = null;
    permissionDenied = false;
    const result = await engineStart({
      deviceId: selectedDeviceId,
      onStateChange: (s) => { state = s; },
      onDurationTick: (d) => { duration = d; },
      onLevelTick: (level) => { micTestLevel = level; },
      onComplete: (blob, url) => { audioBlob = blob; audioUrl = url; state = 'preview'; },
      onError: (msg, denied) => { error = msg; permissionDenied = denied; state = 'idle'; },
      t
    });
    stream = result.stream;
    recorder = result.recorder;
  }

  function stopRecording() {
    engineStop(recorder, state);
    state = 'stopped';
    cleanupVisualization();
  }

  function reRecord() {
    cleanup();
    state = 'idle';
    startRecording();
  }

  async function handleDeviceChange(event: Event) {
    const select = event.target as HTMLSelectElement;
    if (state === 'recording') { error = t('audio.errors.cannot_switch_while_recording'); setTimeout(() => (error = null), 3000); return; }
    selectedDeviceId = select.value;
    if (stream && state === 'idle') { cleanup(); await startRecording(); }
  }

  function sendAudio() {
    if (audioBlob) { dispatch('send', audioBlob); cleanup(); dispatch('close'); }
  }

  function togglePreviewPlayback(): void {
    if (!audioElement) return;
    if (audioElement.paused) {
      void audioElement.play().then(() => (isPreviewPlaying = true)).catch(() => undefined);
    } else {
      audioElement.pause();
      isPreviewPlaying = false;
    }
  }

  function close() {
    cleanup();
    dispatch('close');
  }

  function cleanup() {
    engineStopAll(stream, recorder, audioUrl);
    stream = null; recorder = null; audioUrl = null; audioBlob = null;
    duration = 0; error = null; state = 'idle'; micTestLevel = 0;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') close();
    else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (state === 'idle') startRecording();
      else if (state === 'recording') stopRecording();
    }
  }

  $: if (isOpen && !devicesLoaded) loadDevices();
  $: if (isOpen && state === 'idle' && !permissionDenied && !error) setTimeout(() => { if (isOpen) startRecording(); }, 100);
  $: if (!isOpen) cleanup();

  // Animation loop for waveform
  let animFrame: number | null = null;
  function animLoop() {
    drawWaveform(canvasElement, null, state);
    if (state === 'recording') animFrame = requestAnimationFrame(animLoop);
  }
  $: if (state === 'recording') { if (!animFrame) { animFrame = requestAnimationFrame(animLoop); } }
  $: if (state !== 'recording' && animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }

  onMount(() => {
    const handler = () => loadDevices();
    navigator.mediaDevices?.addEventListener('devicechange', handler);
    return () => { navigator.mediaDevices?.removeEventListener('devicechange', handler); };
  });
  onDestroy(cleanup);

  let unsubscribeKeydown: (() => void) | null = null;
  $: if (isOpen && !unsubscribeKeydown) unsubscribeKeydown = on(window, 'keydown', handleKeydown);
  $: if (!isOpen && unsubscribeKeydown) { unsubscribeKeydown(); unsubscribeKeydown = null; }
</script>

{#if isOpen}
  <div class="modal-backdrop" on:click={close} role="presentation">
    <div class="modal" on:click|stopPropagation role="dialog" aria-labelledby="modal-title" aria-modal="true" tabindex="-1">
      <div class="modal-header">
        <h2 id="modal-title">{$_('audio.title')}</h2>
        <button class="close-btn" on:click={close} aria-label={$_('common.close')}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
        </button>
      </div>

      <div class="modal-body">
        {#if availableDevices.length > 1 && state === 'idle'}
          <div class="device-selector">
            <label for="mic-select"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>{$_('audio.microphone_label')}</label>
            <select id="mic-select" bind:value={selectedDeviceId} on:change={handleDeviceChange} disabled={state !== 'idle'}>
              {#each availableDevices as device, index}<option value={device.deviceId}>{getDeviceLabel(device, index)}</option>{/each}
            </select>
          </div>
        {/if}

        {#if error}
          <div class="error-message"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" /><path d="M12 8v4m0 4h.01" /></svg><p>{error}</p></div>
        {/if}

        <div class="timer"><span class="current-time">{formatTime(duration)}</span><span class="separator">/</span><span class="max-time">{formatTime(MAX_DURATION)}</span></div>

        <div class="visualizer-container">
          <canvas bind:this={canvasElement} width="400" height="100" class="waveform-canvas" class:recording={state === 'recording'}></canvas>
          {#if state === 'idle' || state === 'stopped'}<div class="placeholder-text">{state === 'idle' ? $_('audio.ready') : $_('audio.recording_stopped')}</div>{/if}
        </div>

        {#if state === 'preview' && audioUrl}<div class="preview-player"><audio bind:this={audioElement} src={audioUrl} controls on:play={() => (isPreviewPlaying = true)} on:pause={() => (isPreviewPlaying = false)}></audio><button type="button" class="preview-play-toggle" on:click={togglePreviewPlayback}>{isPreviewPlaying ? 'Pause' : 'Play'}</button></div>{/if}

        <div class="controls">
          {#if state === 'idle' && !error}<button class="btn-record" on:click={startRecording}><svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="8" /></svg>{$_('audio.record')}</button>{/if}
          {#if state === 'recording'}<button class="btn-stop" on:click={stopRecording}><svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>{$_('audio.stop')}</button>{/if}
          {#if state === 'preview'}
            <button class="btn-secondary" on:click={reRecord}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></svg>{$_('audio.rerecord')}</button>
            <button class="btn-secondary" on:click={close}>{$_('common.cancel')}</button>
            <button class="btn-primary" on:click={sendAudio}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" /></svg>{$_('audio.send')}</button>
          {/if}
          {#if error}<button class="btn-secondary" on:click={close}>{$_('common.close')}</button>{/if}
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .modal-backdrop { position: fixed; inset: 0; background: var(--surface-overlay, var(--surface-overlay, var(--surface-overlay, var(--surface-modal-overlay, rgba(0, 0, 0, 0.7))))); display: flex; align-items: center; justify-content: center; z-index: var(--z-modal); padding: 1rem; }
  .modal { background: var(--surface-app, #1e1e1e); border-radius: 12px; width: 100%; max-width: 500px; box-shadow: 0 20px 60px var(--shadow-md, var(--shadow-md, var(--shadow-lg, var(--surface-modal-overlay, rgba(0, 0, 0, 0.5))))); }
  .modal-header { display: flex; align-items: center; justify-content: space-between; padding: 1.5rem; border-bottom: 1px solid var(--border-color, var(--surface-base, #333)); }
  .modal-header h2 { margin: 0; font-size: 1.25rem; font-weight: 600; color: var(--text-heading, var(--text-inverse, var(--text-inverse, #fff))); }
  .close-btn { background: none; border: none; color: var(--text-secondary, #999); cursor: pointer; padding: 0.5rem; display: flex; align-items: center; justify-content: center; border-radius: 6px; transition: all 0.2s; }
  .close-btn:hover { background: var(--surface-base, #2a2a2a); color: var(--text-heading, var(--text-inverse, var(--text-inverse, #fff))); }
  .modal-body { padding: 2rem 1.5rem; }
  .device-selector { display: flex; align-items: center; gap: 0.75rem; padding: 1rem 0; margin-bottom: 1rem; border-bottom: 1px solid var(--border-color, var(--surface-base, #333)); }
  .device-selector label { display: flex; align-items: center; gap: 0.5rem; font-size: 0.9rem; color: var(--text-secondary, #999); white-space: nowrap; }
  .device-selector label svg { flex-shrink: 0; }
  .device-selector select { flex: 1; padding: 0.5rem 0.75rem; background: var(--surface-app, #1e1e1e); border: 1px solid var(--border-color, var(--surface-base, #333)); border-radius: 6px; color: var(--text-heading, var(--text-inverse, var(--text-inverse, #fff))); font-size: 0.9rem; cursor: pointer; transition: all 0.2s; }
  .device-selector select:hover { border-color: var(--color-info, var(--color-info, #3b82f6)); }
  .device-selector select:focus { outline: none; border-color: var(--color-info, var(--color-info, #3b82f6)); box-shadow: 0 0 0 3px rgba(var(--color-info-rgb, 59, 130, 246), 0.1); }
  .device-selector select:disabled { opacity: 0.5; cursor: not-allowed; }
  .error-message { display: flex; align-items: center; gap: 0.75rem; padding: 1rem; background: var(--accent-danger-soft, var(--accent-danger-soft, rgba(var(--color-danger-rgb, 239, 68, 68), 0.1))); border: 1px solid rgba(var(--color-danger-rgb, 239, 68, 68), 0.3); border-radius: 8px; color: var(--color-danger, var(--color-danger, #ef4444)); margin-bottom: 1.5rem; }
  .error-message svg { flex-shrink: 0; }
  .error-message p { margin: 0; font-size: 0.9rem; }
  .timer { text-align: center; font-size: 2rem; font-weight: 600; margin-bottom: 2rem; font-variant-numeric: tabular-nums; color: var(--text-heading, var(--text-inverse, var(--text-inverse, #fff))); }
  .separator { color: var(--text-secondary, #666); margin: 0 0.25rem; }
  .max-time { color: var(--text-secondary, #666); font-size: 1.5rem; }
  .visualizer-container { position: relative; width: 100%; height: 100px; margin-bottom: 2rem; background: var(--surface-base, #2a2a2a); border-radius: 8px; overflow: hidden; display: flex; align-items: center; justify-content: center; }
  .waveform-canvas { width: 100%; height: 100%; }
  .placeholder-text { position: absolute; color: var(--text-secondary, #666); font-size: 0.9rem; }
  .preview-player { margin-bottom: 2rem; display: flex; align-items: center; gap: 0.75rem; }
  .preview-player audio { width: 100%; }
  .preview-play-toggle { min-height: 40px; padding: 0.55rem 0.9rem; white-space: nowrap; }
  .controls { display: flex; gap: 0.75rem; justify-content: center; flex-wrap: wrap; }
  button { padding: 0.75rem 1.5rem; border-radius: 8px; font-size: 1rem; font-weight: 500; cursor: pointer; border: none; transition: all 0.2s; display: flex; align-items: center; gap: 0.5rem; min-height: 48px; }
  .btn-record { background: var(--color-info, var(--color-info, #3b82f6)); color: white; font-size: 1.1rem; padding: 1rem 2rem; }
  .btn-record:hover { background: var(--color-info, #2563eb); }
  .btn-stop { background: var(--color-danger, var(--color-danger, #ef4444)); color: white; font-size: 1.1rem; padding: 1rem 2rem; animation: pulse 2s infinite; }
  .btn-stop:hover { background: var(--color-danger, var(--color-danger, #dc2626)); }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.8; } }
  .btn-primary { background: var(--color-info, var(--color-info, #3b82f6)); color: white; }
  .btn-primary:hover { background: var(--color-info, #2563eb); }
  .btn-secondary { background: var(--surface-base, #2a2a2a); color: var(--text-heading, var(--text-inverse, var(--text-inverse, #fff))); border: 1px solid var(--border-color, var(--surface-base, #333)); }
  .btn-secondary:hover { background: var(--surface-raised, var(--surface-base, #333)); }
  @media (max-width: 768px) { .modal { max-width: none; border-radius: 0; height: 100vh; height: 100dvh; display: flex; flex-direction: column; } .modal-body { flex: 1; display: flex; flex-direction: column; justify-content: center; } .modal-backdrop { padding: 0; } .device-selector { flex-direction: column; align-items: stretch; gap: 0.5rem; } .device-selector label { font-size: 0.85rem; } .device-selector select { width: 100%; } }
</style>
