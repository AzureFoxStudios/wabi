<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import { on } from 'svelte/events';
  import { get } from 'svelte/store';
  import { _ } from '$lib/i18n';

  export let isOpen = false;

  const dispatch = createEventDispatcher<{
    close: void;
    send: Blob;
  }>();

  const MAX_DURATION = 300; // 5 minutes in seconds
  const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg'];

  type RecordingState = 'idle' | 'recording' | 'stopped' | 'preview';

  let state: RecordingState = 'idle';
  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let duration = 0;
  let timerInterval: number | null = null;
  let audioBlob: Blob | null = null;
  let audioUrl: string | null = null;
  let canvasElement: HTMLCanvasElement;
  let audioContext: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let animationId: number | null = null;
  let error: string | null = null;
  let permissionDenied = false;
  let audioElement: HTMLAudioElement;

  // Device selection
  let availableDevices: MediaDeviceInfo[] = [];
  let selectedDeviceId: string = '';
  let devicesLoaded = false;
  const t = (key: string) => get(_)(key);

  // Format duration as MM:SS
  function formatTime(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  // Get supported MIME type
  function getSupportedMimeType(): string {
    for (const mimeType of MIME_TYPES) {
      if (MediaRecorder.isTypeSupported(mimeType)) {
        return mimeType;
      }
    }
    return 'audio/webm'; // fallback
  }

  // Enumerate available audio input devices
  async function loadDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      availableDevices = devices.filter(d => d.kind === 'audioinput');

      // Auto-select first device if none selected
      if (availableDevices.length > 0 && !selectedDeviceId) {
        selectedDeviceId = availableDevices[0].deviceId;
      }

      devicesLoaded = true;
    } catch (err) {
      console.error('Failed to enumerate devices:', err);
      availableDevices = [];
    }
  }

  // Get display label for device (fallback for empty labels)
  function getDeviceLabel(device: MediaDeviceInfo, index: number): string {
    return device.label || get(_)('audio.microphone_fallback', { values: { index: index + 1 } });
  }

  // Start recording
  async function startRecording() {
    try {
      error = null;
      permissionDenied = false;

      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 48000
        }
      });

      // After permission granted, reload devices to get labels
      if (!devicesLoaded || !availableDevices[0]?.label) {
        await loadDevices();
      }

      const mimeType = getSupportedMimeType();
      recorder = new MediaRecorder(stream, {
        mimeType,
        audioBitsPerSecond: 32000 // Voice-optimized bitrate
      });

      chunks = [];
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) {
          chunks.push(ev.data);
        }
      };

      recorder.onstop = handleRecordingComplete;

      recorder.start(100); // Collect data every 100ms for smoother visualization
      state = 'recording';
      duration = 0;
      startTimer();
      setupVisualization();
    } catch (err) {
      console.error('Failed to start recording:', err);
      if (err instanceof Error) {
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          error = t('audio.errors.access_required');
          permissionDenied = true;
        } else if (err.name === 'NotFoundError') {
          error = t('audio.errors.not_found');
        } else {
          error = t('audio.errors.start_failed');
        }
      }
    }
  }

  // Stop recording
  function stopRecording() {
    if (recorder && state === 'recording') {
      recorder.stop();
      state = 'stopped';
      stopTimer();
      stopVisualization();
    }
  }

  // Handle recording completion
  function handleRecordingComplete() {
    if (chunks.length === 0) {
      error = t('audio.errors.no_audio');
      cleanup();
      return;
    }

    const mimeType = recorder?.mimeType || 'audio/webm';
    audioBlob = new Blob(chunks, { type: mimeType });

    // Check file size (10MB limit)
    if (audioBlob.size > 10 * 1024 * 1024) {
      error = t('audio.errors.too_large');
      cleanup();
      return;
    }

    audioUrl = URL.createObjectURL(audioBlob);
    state = 'preview';
  }

  // Start timer
  function startTimer() {
    timerInterval = window.setInterval(() => {
      duration++;
      if (duration >= MAX_DURATION) {
        stopRecording();
      }
    }, 1000);
  }

  // Stop timer
  function stopTimer() {
    if (timerInterval !== null) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  // Setup waveform visualization
  function setupVisualization() {
    if (!stream || !canvasElement) return;

    try {
      audioContext = new AudioContext();
      analyser = audioContext.createAnalyser();
      const source = audioContext.createMediaStreamSource(stream);

      analyser.fftSize = 256;
      source.connect(analyser);

      drawWaveform();
    } catch (err) {
      console.error('Failed to setup visualization:', err);
      // Continue without visualization
    }
  }

  // Draw waveform
  function drawWaveform() {
    if (!analyser || !canvasElement) return;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const draw = () => {
      if (state !== 'recording') return;

      animationId = requestAnimationFrame(draw);
      analyser!.getByteFrequencyData(dataArray);

      const ctx = canvasElement.getContext('2d');
      if (!ctx) return;

      const width = canvasElement.width;
      const height = canvasElement.height;

      ctx.clearRect(0, 0, width, height);

      const barWidth = width / bufferLength;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        const barHeight = (dataArray[i] / 255) * height * 0.8;
        const gradient = ctx.createLinearGradient(0, height - barHeight, 0, height);
        gradient.addColorStop(0, '#3b82f6');
        gradient.addColorStop(1, '#60a5fa');

        ctx.fillStyle = gradient;
        ctx.fillRect(x, height - barHeight, barWidth - 1, barHeight);
        x += barWidth;
      }
    };

    draw();
  }

  // Stop visualization
  function stopVisualization() {
    if (animationId !== null) {
      cancelAnimationFrame(animationId);
      animationId = null;
    }
    if (audioContext) {
      audioContext.close();
      audioContext = null;
    }
  }

  // Re-record
  function reRecord() {
    cleanup();
    state = 'idle';
    startRecording();
  }

  // Handle device selection change
  async function handleDeviceChange(event: Event) {
    const select = event.target as HTMLSelectElement;
    const newDeviceId = select.value;

    if (state === 'recording') {
      error = t('audio.errors.cannot_switch_while_recording');
      setTimeout(() => error = null, 3000);
      return;
    }

    selectedDeviceId = newDeviceId;

    // If we already have a stream (idle with permission), restart it
    if (stream && state === 'idle') {
      cleanup();
      await startRecording();
    }
  }

  // Send audio
  function sendAudio() {
    if (audioBlob) {
      dispatch('send', audioBlob);
      cleanup();  // Explicitly cleanup before closing
      dispatch('close');  // Then dispatch close
    }
  }

  // Close modal
  function close() {
    cleanup();
    dispatch('close');
  }

  // Cleanup resources
  function cleanup() {
    stopTimer();
    stopVisualization();

    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      stream = null;
    }

    if (recorder) {
      if (recorder.state !== 'inactive') {
        recorder.stop();
      }
      recorder = null;
    }

    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      audioUrl = null;
    }

    chunks = [];
    audioBlob = null;
    duration = 0;
    error = null;
    state = 'idle';
  }

  // Handle escape key
  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      close();
    } else if (e.key === ' ' || e.key === 'Enter') {
      if (state === 'idle') {
        e.preventDefault();
        startRecording();
      } else if (state === 'recording') {
        e.preventDefault();
        stopRecording();
      }
    }
  }

  // Load devices when modal opens
  $: if (isOpen && !devicesLoaded) {
    loadDevices();
  }

  // Auto-start recording when modal opens
  $: if (isOpen && state === 'idle' && !permissionDenied && !error) {
    // Small delay to allow modal to render
    setTimeout(() => {
      if (isOpen) startRecording();
    }, 100);
  }

  // Ensure cleanup when modal closes
  $: if (!isOpen) {
    cleanup();
  }

  // Listen for device changes (plug/unplug)
  onMount(() => {
    const handleDeviceChange = () => loadDevices();
    navigator.mediaDevices?.addEventListener('devicechange', handleDeviceChange);

    return () => {
      navigator.mediaDevices?.removeEventListener('devicechange', handleDeviceChange);
    };
  });

  onDestroy(cleanup);

  // Conditionally attach keyboard listener using Svelte's proper event pattern
  let unsubscribeKeydown: (() => void) | null = null;

  $: if (isOpen && !unsubscribeKeydown) {
    // Attach listener when modal opens
    unsubscribeKeydown = on(window, 'keydown', handleKeydown);
  } else if (!isOpen && unsubscribeKeydown) {
    // Remove listener when modal closes
    unsubscribeKeydown();
    unsubscribeKeydown = null;
  }

</script>

{#if isOpen}
  <div class="modal-backdrop" on:click={close} role="presentation">
    <div class="modal" on:click|stopPropagation role="dialog" aria-labelledby="modal-title" aria-modal="true" tabindex="-1">
      <div class="modal-header">
        <h2 id="modal-title">{$_('audio.title')}</h2>
        <button class="close-btn" on:click={close} aria-label={$_('common.close')}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div class="modal-body">
        {#if availableDevices.length > 1 && state === 'idle'}
          <div class="device-selector">
            <label for="mic-select">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
                <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                <line x1="12" y1="19" x2="12" y2="23"></line>
                <line x1="8" y1="23" x2="16" y2="23"></line>
              </svg>
              {$_('audio.microphone_label')}
            </label>
            <select
              id="mic-select"
              bind:value={selectedDeviceId}
              on:change={handleDeviceChange}
              disabled={state !== 'idle'}
            >
              {#each availableDevices as device, index}
                <option value={device.deviceId}>
                  {getDeviceLabel(device, index)}
                </option>
              {/each}
            </select>
          </div>
        {/if}

        {#if error}
          <div class="error-message">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v4m0 4h.01" />
            </svg>
            <p>{error}</p>
          </div>
        {/if}

        <div class="timer">
          <span class="current-time">{formatTime(duration)}</span>
          <span class="separator">/</span>
          <span class="max-time">{formatTime(MAX_DURATION)}</span>
        </div>

        <div class="visualizer-container">
          <canvas
            bind:this={canvasElement}
            width="400"
            height="100"
            class="waveform-canvas"
            class:recording={state === 'recording'}
          ></canvas>
          {#if state === 'idle' || state === 'stopped'}
            <div class="placeholder-text">
              {state === 'idle' ? $_('audio.ready') : $_('audio.recording_stopped')}
            </div>
          {/if}
        </div>

        {#if state === 'preview' && audioUrl}
          <div class="preview-player">
            <audio bind:this={audioElement} src={audioUrl} controls></audio>
          </div>
        {/if}

        <div class="controls">
          {#if state === 'idle' && !error}
            <button class="btn-record" on:click={startRecording}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="12" r="8" />
              </svg>
              {$_('audio.record')}
            </button>
          {/if}

          {#if state === 'recording'}
            <button class="btn-stop" on:click={stopRecording}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
              {$_('audio.stop')}
            </button>
          {/if}

          {#if state === 'preview'}
            <button class="btn-secondary" on:click={reRecord}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
              {$_('audio.rerecord')}
            </button>
            <button class="btn-secondary" on:click={close}>{$_('common.cancel')}</button>
            <button class="btn-primary" on:click={sendAudio}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
              </svg>
              {$_('audio.send')}
            </button>
          {/if}

          {#if error}
            <button class="btn-secondary" on:click={close}>{$_('common.close')}</button>
          {/if}
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 1rem;
  }

  .modal {
    background: var(--bg-primary, #1e1e1e);
    border-radius: 12px;
    width: 100%;
    max-width: 500px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1.5rem;
    border-bottom: 1px solid var(--border-color, #333);
  }

  .modal-header h2 {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--text-primary, #fff);
  }

  .close-btn {
    background: none;
    border: none;
    color: var(--text-secondary, #999);
    cursor: pointer;
    padding: 0.5rem;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 6px;
    transition: all 0.2s;
  }

  .close-btn:hover {
    background: var(--bg-secondary, #2a2a2a);
    color: var(--text-primary, #fff);
  }

  .modal-body {
    padding: 2rem 1.5rem;
  }

  .device-selector {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 1rem 0;
    margin-bottom: 1rem;
    border-bottom: 1px solid var(--border-color, #333);
  }

  .device-selector label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9rem;
    color: var(--text-secondary, #999);
    white-space: nowrap;
  }

  .device-selector label svg {
    flex-shrink: 0;
  }

  .device-selector select {
    flex: 1;
    padding: 0.5rem 0.75rem;
    background: var(--bg-primary, #1e1e1e);
    border: 1px solid var(--border-color, #333);
    border-radius: 6px;
    color: var(--text-primary, #fff);
    font-size: 0.9rem;
    cursor: pointer;
    transition: all 0.2s;
  }

  .device-selector select:hover {
    border-color: #3b82f6;
  }

  .device-selector select:focus {
    outline: none;
    border-color: #3b82f6;
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
  }

  .device-selector select:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .error-message {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 1rem;
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.3);
    border-radius: 8px;
    color: #ef4444;
    margin-bottom: 1.5rem;
  }

  .error-message svg {
    flex-shrink: 0;
  }

  .error-message p {
    margin: 0;
    font-size: 0.9rem;
  }

  .timer {
    text-align: center;
    font-size: 2rem;
    font-weight: 600;
    margin-bottom: 2rem;
    font-variant-numeric: tabular-nums;
    color: var(--text-primary, #fff);
  }

  .separator {
    color: var(--text-secondary, #666);
    margin: 0 0.25rem;
  }

  .max-time {
    color: var(--text-secondary, #666);
    font-size: 1.5rem;
  }

  .visualizer-container {
    position: relative;
    width: 100%;
    height: 100px;
    margin-bottom: 2rem;
    background: var(--bg-secondary, #2a2a2a);
    border-radius: 8px;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .waveform-canvas {
    width: 100%;
    height: 100%;
  }

  .placeholder-text {
    position: absolute;
    color: var(--text-secondary, #666);
    font-size: 0.9rem;
  }

  .preview-player {
    margin-bottom: 2rem;
  }

  .preview-player audio {
    width: 100%;
  }

  .controls {
    display: flex;
    gap: 0.75rem;
    justify-content: center;
    flex-wrap: wrap;
  }

  button {
    padding: 0.75rem 1.5rem;
    border-radius: 8px;
    font-size: 1rem;
    font-weight: 500;
    cursor: pointer;
    border: none;
    transition: all 0.2s;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-height: 48px;
  }

  .btn-record {
    background: #3b82f6;
    color: white;
    font-size: 1.1rem;
    padding: 1rem 2rem;
  }

  .btn-record:hover {
    background: #2563eb;
  }

  .btn-stop {
    background: #ef4444;
    color: white;
    font-size: 1.1rem;
    padding: 1rem 2rem;
    animation: pulse 2s infinite;
  }

  .btn-stop:hover {
    background: #dc2626;
  }

  @keyframes pulse {
    0%, 100% {
      opacity: 1;
    }
    50% {
      opacity: 0.8;
    }
  }

  .btn-primary {
    background: #3b82f6;
    color: white;
  }

  .btn-primary:hover {
    background: #2563eb;
  }

  .btn-secondary {
    background: var(--bg-secondary, #2a2a2a);
    color: var(--text-primary, #fff);
    border: 1px solid var(--border-color, #333);
  }

  .btn-secondary:hover {
    background: var(--bg-tertiary, #333);
  }

  @media (max-width: 768px) {
    .modal {
      max-width: none;
      border-radius: 0;
      height: 100vh;
      height: 100dvh;
      display: flex;
      flex-direction: column;
    }

    .modal-body {
      flex: 1;
      display: flex;
      flex-direction: column;
      justify-content: center;
    }

    .modal-backdrop {
      padding: 0;
    }

    .device-selector {
      flex-direction: column;
      align-items: stretch;
      gap: 0.5rem;
    }

    .device-selector label {
      font-size: 0.85rem;
    }

    .device-selector select {
      width: 100%;
    }
  }
</style>
