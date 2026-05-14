/**
 * STDB audio media relay — capture/playback pipeline via SpaceTimeDB call state.
 *
 * Capture: getUserMedia → opus-recorder WASM encoder → Socket.IO binary emit
 * Receive: Socket.IO listen → jitter buffer → opus-recorder decoder → AudioWorklet playback
 */

import { OpusRecorder } from 'opus-recorder';

export interface StdbMediaRelayConfig {
  sessionId: string;
  userId: string;
  socket: any; // Socket.IO client
  onError?: (err: Error) => void;
}

interface JitterEntry {
  data: ArrayBuffer;
  timestamp: number;
}

export class StdbMediaRelay {
  private sessionId: string;
  private userId: string;
  private socket: any;
  private onError?: (err: Error) => void;
  private localStream: MediaStream | null = null;
  private opusRecorder: OpusRecorder | null = null;
  private audioContext: AudioContext | null = null;
  private audioWorklet: AudioWorkletNode | null = null;
  private jitterBuffer: JitterEntry[] = [];
  private opusDecoder: Worker | null = null;
  private isActive = false;
  private jitterTargetMs = 80;
  private playbackTimer: number | null = null;

  constructor(cfg: StdbMediaRelayConfig) {
    this.sessionId = cfg.sessionId;
    this.userId = cfg.userId;
    this.socket = cfg.socket;
    this.onError = cfg.onError;
  }

  async start(stream: MediaStream): Promise<void> {
    try {
      this.isActive = true;
      this.localStream = stream;

      this.audioContext = new AudioContext({ sampleRate: 48000 });

      this.opusRecorder = new OpusRecorder({
        encoderSampleRate: 48000,
        encoderChannels: 1,
        streamPages: true,
        numberOfChannels: 1,
      });

      this.opusRecorder.ondataavailable = (data: ArrayBuffer) => {
        if (this.isActive) {
          this.socket.emit('stdb-media', {
            sessionId: this.sessionId,
            userId: this.userId,
            payload: data,
          });
        }
      };

      await this.opusRecorder.start(stream);

      this.socket.on('stdb-media', (msg: any) => {
        if (msg.userId !== this.userId && msg.sessionId === this.sessionId) {
          this.handleIncomingMedia(msg.payload);
        }
      });

      this.startPlaybackLoop();

      console.log(`[StdbMediaRelay] Started capture for session ${this.sessionId}`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.onError?.(err);
      throw err;
    }
  }

  private handleIncomingMedia(opusPayload: ArrayBuffer): void {
    this.jitterBuffer.push({ data: opusPayload, timestamp: Date.now() });

    if (this.jitterBuffer.length > 50) {
      this.jitterBuffer.splice(0, this.jitterBuffer.length - 50);
    }
  }

  private startPlaybackLoop(): void {
    if (this.playbackTimer != null) return;
    this.playbackTimer = window.setInterval(() => {
      this.drainJitterBuffer();
    }, 20);
  }

  private drainJitterBuffer(): void {
    if (!this.isActive || this.jitterBuffer.length === 0) return;

    const now = Date.now();
    while (this.jitterBuffer.length > 0) {
      const entry = this.jitterBuffer[0];
      const age = now - entry.timestamp;
      if (age >= this.jitterTargetMs) {
        this.jitterBuffer.shift();
        void this.decodeAndPlay(entry.data);
      } else {
        break;
      }
    }
  }

  private async decodeAndPlay(opusPayload: ArrayBuffer): Promise<void> {
    try {
      if (!this.opusDecoder) {
        await this.initializeOpusDecoder();
      }
      const pcmData = await this.decodeOpus(opusPayload);
      if (pcmData) {
        await this.playbackViaAudioWorklet(pcmData);
      }
    } catch (error) {
      console.error('[StdbMediaRelay] decode/playback error:', error);
    }
  }

  private async initializeOpusDecoder(): Promise<void> {
    const workerUrl = new URL('opus-recorder/dist/decoderWorker.min.js', import.meta.url);
    this.opusDecoder = new Worker(workerUrl, { type: 'classic' });
    // TODO: verify decoder init command matches opus-recorder v8.0.5 worker API
  }

  private async decodeOpus(opusPayload: ArrayBuffer): Promise<Float32Array | null> {
    return new Promise((resolve) => {
      if (!this.opusDecoder) {
        resolve(null);
        return;
      }
      const id = Math.random().toString(36).slice(2);
      const handler = (e: MessageEvent) => {
        if (e.data?.id === id) {
          this.opusDecoder!.removeEventListener('message', handler);
          resolve(e.data.result ?? null);
        }
      };
      this.opusDecoder.addEventListener('message', handler);
      this.opusDecoder.postMessage({ id, cmd: 'decode', payload: opusPayload });
      setTimeout(() => {
        this.opusDecoder!.removeEventListener('message', handler);
        resolve(null);
      }, 100);
    });
  }

  private async playbackViaAudioWorklet(pcmData: Float32Array): Promise<void> {
    if (!this.audioContext) return;
    if (!this.audioWorklet) {
      try {
        const workletUrl = new URL('./audio-worklet-playback.ts', import.meta.url);
        await this.audioContext.audioWorklet.addModule(workletUrl);
        this.audioWorklet = new AudioWorkletNode(this.audioContext, 'stdb-audio-playback');
        this.audioWorklet.connect(this.audioContext.destination);
      } catch (error) {
        console.error('[StdbMediaRelay] Failed to load AudioWorklet:', error);
        return;
      }
    }
    this.audioWorklet.port.postMessage({ pcm: pcmData });
  }

  stop(): void {
    this.isActive = false;
    if (this.playbackTimer != null) {
      window.clearInterval(this.playbackTimer);
      this.playbackTimer = null;
    }
    if (this.opusRecorder) {
      this.opusRecorder.stop();
      this.opusRecorder = null;
    }
    if (this.audioWorklet) {
      this.audioWorklet.disconnect();
      this.audioWorklet = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    if (this.opusDecoder) {
      this.opusDecoder.terminate();
      this.opusDecoder = null;
    }
    this.jitterBuffer = [];
    this.socket.off('stdb-media');
    console.log(`[StdbMediaRelay] Stopped for session ${this.sessionId}`);
  }
}
