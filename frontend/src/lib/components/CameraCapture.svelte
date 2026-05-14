<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import { on } from 'svelte/events';
  import { get } from 'svelte/store';
  import { _ } from '$lib/i18n';

  export let isOpen = false;

  const dispatch = createEventDispatcher<{
    close: void;
    capture: Blob;
  }>();

  type CaptureState = 'preview' | 'captured';

  let state: CaptureState = 'preview';
  let videoElement: HTMLVideoElement;
  let stream: MediaStream | null = null;
  let facingMode: 'user' | 'environment' = 'user';
  let capturedImage: string | null = null;
  let capturedBlob: Blob | null = null;
  let error: string | null = null;
  let permissionDenied = false;
  let hasMultipleCameras = false;
  const t = (key: string) => get(_)(key);

  // Start camera
  async function startCamera() {
    try {
      error = null;
      permissionDenied = false;

      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          facingMode: facingMode
        }
      });

      if (videoElement) {
        videoElement.srcObject = stream;
      }

      // Check if device has multiple cameras
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter(device => device.kind === 'videoinput');
      hasMultipleCameras = videoDevices.length > 1;
    } catch (err) {
      console.error('Camera access denied:', err);
      if (err instanceof Error) {
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          error = t('camera.errors.access_required');
          permissionDenied = true;
        } else if (err.name === 'NotFoundError') {
          error = t('camera.errors.not_found');
        } else {
          error = t('camera.errors.access_failed');
        }
      }
    }
  }

  // Stop camera
  function stopCamera() {
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      stream = null;
    }
    if (videoElement) {
      videoElement.srcObject = null;
    }
  }

  // Capture photo
  function capturePhoto() {
    if (!videoElement || !stream) return;

    const canvas = document.createElement('canvas');
    canvas.width = videoElement.videoWidth;
    canvas.height = videoElement.videoHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      error = t('camera.errors.capture_failed');
      return;
    }

    ctx.drawImage(videoElement, 0, 0);

    canvas.toBlob(
      (blob) => {
        if (blob) {
          // Check file size (10MB limit)
          if (blob.size > 10 * 1024 * 1024) {
            error = t('camera.errors.photo_too_large');
            return;
          }

          capturedBlob = blob;
          capturedImage = URL.createObjectURL(blob);
          state = 'captured';
          stopCamera();
        } else {
          error = t('camera.errors.capture_failed');
        }
      },
      'image/jpeg',
      0.85 // 85% quality
    );
  }

  // Toggle camera (front/back)
  async function toggleCamera() {
    facingMode = facingMode === 'user' ? 'environment' : 'user';
    stopCamera();
    await startCamera();
  }

  // Retake photo
  async function retake() {
    if (capturedImage) {
      URL.revokeObjectURL(capturedImage);
      capturedImage = null;
    }
    capturedBlob = null;
    state = 'preview';
    await startCamera();
  }

  // Send photo
  function sendPhoto() {
    if (capturedBlob) {
      dispatch('capture', capturedBlob);
      close();
    }
  }

  // Close modal
  function close() {
    cleanup();
    dispatch('close');
  }

  // Cleanup resources
  function cleanup() {
    stopCamera();
    if (capturedImage) {
      URL.revokeObjectURL(capturedImage);
      capturedImage = null;
    }
    capturedBlob = null;
    state = 'preview';
    error = null;
  }

  // Handle keyboard shortcuts
  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      close();
    } else if (e.key === ' ' || e.key === 'Enter') {
      if (state === 'preview' && !error && !permissionDenied) {
        e.preventDefault();
        capturePhoto();
      }
    }
  }

  // Auto-start camera when modal opens
  $: if (isOpen && !stream && !permissionDenied && !error) {
    setTimeout(() => {
      if (isOpen) startCamera();
    }, 100);
  }

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
  <!-- svelte-ignore a11y_click_events_have_key_events: backdrop closes on pointer; keyboard close is handled by Escape and the close button -->
  <div class="modal-backdrop" on:click={close} role="presentation">
    <div class="modal" on:click|stopPropagation role="dialog" aria-labelledby="modal-title" aria-modal="true" tabindex="-1">
      <div class="modal-header">
        <h2 id="modal-title">{$_('camera.title')}</h2>
        <button class="close-btn" on:click={close} aria-label={$_('common.close')}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div class="modal-body">
        {#if error}
          <div class="error-message">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v4m0 4h.01" />
            </svg>
            <p>{error}</p>
          </div>
        {/if}

        <div class="camera-container">
          {#if state === 'preview'}
            <video
              bind:this={videoElement}
              autoplay
              playsinline
              class="camera-preview"
              class:hidden={!stream}
            ></video>
            {#if hasMultipleCameras && !error && !permissionDenied}
              <button class="camera-toggle" on:click={toggleCamera} aria-label={$_('camera.switch_camera')}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                  <polyline points="7.5 4.21 12 6.81 16.5 4.21" />
                  <polyline points="7.5 19.79 7.5 14.6 3 12" />
                  <polyline points="21 12 16.5 14.6 16.5 19.79" />
                  <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                  <line x1="12" y1="22.08" x2="12" y2="12" />
                </svg>
              </button>
            {/if}
          {:else if state === 'captured' && capturedImage}
            <img src={capturedImage} alt={$_('camera.captured_alt')} class="captured-preview" />
          {/if}

          {#if !stream && !error && !permissionDenied}
            <div class="loading-indicator">
              <div class="spinner"></div>
              <p>{$_('camera.accessing')}</p>
            </div>
          {/if}
        </div>

        <div class="controls">
          {#if state === 'preview' && stream && !error}
            <button class="btn-capture" on:click={capturePhoto} aria-label={$_('camera.take_photo')}>
              <div class="capture-ring">
                <div class="capture-circle"></div>
              </div>
            </button>
          {/if}

          {#if state === 'captured'}
            <button class="btn-secondary" on:click={retake}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
              {$_('camera.retake')}
            </button>
            <button class="btn-secondary" on:click={close}>{$_('common.cancel')}</button>
            <button class="btn-primary" on:click={sendPhoto}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
              </svg>
              {$_('camera.send')}
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
    background: var(--surface-overlay, var(--surface-overlay, var(--surface-modal-overlay, rgba(0, 0, 0, 0.9))));
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: var(--z-modal);
    padding: 1rem;
  }

  .modal {
    background: var(--surface-app, #1e1e1e);
    border-radius: 12px;
    width: 100%;
    max-width: 640px;
    box-shadow: 0 20px 60px var(--shadow-md, var(--shadow-md, var(--shadow-lg, var(--surface-modal-overlay, rgba(0, 0, 0, 0.5)))));
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1.5rem;
    border-bottom: 1px solid var(--border-color, var(--surface-base, #333));
  }

  .modal-header h2 {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--text-heading, var(--text-inverse, var(--text-inverse, #fff)));
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
    background: var(--surface-base, #2a2a2a);
    color: var(--text-heading, var(--text-inverse, var(--text-inverse, #fff)));
  }

  .modal-body {
    padding: 1.5rem;
  }

  .error-message {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 1rem;
    background: var(--accent-danger-soft, var(--accent-danger-soft, rgba(var(--color-danger-rgb, 239, 68, 68), 0.1)));
    border: 1px solid rgba(var(--color-danger-rgb, 239, 68, 68), 0.3);
    border-radius: 8px;
    color: var(--color-danger, var(--color-danger, #ef4444));
    margin-bottom: 1.5rem;
  }

  .error-message svg {
    flex-shrink: 0;
  }

  .error-message p {
    margin: 0;
    font-size: 0.9rem;
  }

  .camera-container {
    position: relative;
    width: 100%;
    aspect-ratio: 4 / 3;
    background: var(--surface-app, var(--surface-app, #000));
    border-radius: 8px;
    overflow: hidden;
    margin-bottom: 1.5rem;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .camera-preview,
  .captured-preview {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  .camera-preview.hidden {
    display: none;
  }

  .camera-toggle {
    position: absolute;
    top: 1rem;
    right: 1rem;
    background: var(--shadow-md, var(--shadow-md, var(--shadow-lg, var(--surface-modal-overlay, rgba(0, 0, 0, 0.5)))));
    backdrop-filter: blur(10px);
    border: 1px solid rgba(var(--text-inverse-rgb, 255, 255, 255), 0.2);
    color: white;
    cursor: pointer;
    padding: 0.75rem;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
    z-index: 10;
  }

  .camera-toggle:hover {
    background: var(--surface-overlay, var(--surface-overlay, var(--surface-overlay, var(--surface-modal-overlay, rgba(0, 0, 0, 0.7)))));
    transform: scale(1.05);
  }

  .loading-indicator {
    text-align: center;
    color: var(--text-secondary, #999);
  }

  .spinner {
    width: 40px;
    height: 40px;
    border: 4px solid rgba(var(--text-inverse-rgb, 255, 255, 255), 0.1);
    border-top-color: var(--color-info, var(--color-info, #3b82f6));
    border-radius: 50%;
    animation: spin 1s linear infinite;
    margin: 0 auto 1rem;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .loading-indicator p {
    margin: 0;
    font-size: 0.9rem;
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

  .btn-capture {
    background: none;
    padding: 0;
    min-height: auto;
  }

  .capture-ring {
    width: 80px;
    height: 80px;
    border: 4px solid white;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
  }

  .btn-capture:hover .capture-ring {
    transform: scale(1.05);
    border-color: var(--color-info, var(--color-info, #3b82f6));
  }

  .btn-capture:active .capture-ring {
    transform: scale(0.95);
  }

  .capture-circle {
    width: 60px;
    height: 60px;
    background: white;
    border-radius: 50%;
    transition: all 0.2s;
  }

  .btn-capture:hover .capture-circle {
    background: var(--color-info, var(--color-info, #3b82f6));
  }

  .btn-primary {
    background: var(--color-info, var(--color-info, #3b82f6));
    color: white;
  }

  .btn-primary:hover {
    background: var(--color-info, #2563eb);
  }

  .btn-secondary {
    background: var(--surface-base, #2a2a2a);
    color: var(--text-heading, var(--text-inverse, var(--text-inverse, #fff)));
    border: 1px solid var(--border-color, var(--surface-base, #333));
  }

  .btn-secondary:hover {
    background: var(--surface-raised, var(--surface-base, #333));
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
      padding: 1rem;
    }

    .camera-container {
      flex: 1;
      margin-bottom: 1rem;
      aspect-ratio: auto;
    }

    .modal-backdrop {
      padding: 0;
    }
  }

  @media (orientation: landscape) and (max-height: 600px) {
    .camera-container {
      aspect-ratio: 16 / 9;
    }
  }
</style>
