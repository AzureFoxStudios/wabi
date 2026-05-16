/**
 * AudioWorklet for smooth playback of incoming opus-decoded PCM data.
 * Registers as 'stdb-audio-playback' processor.
 */

// AudioWorklet processor scope globals — not in standard lib.dom.d.ts
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;

class StdbAudioPlaybackWorklet extends AudioWorkletProcessor {
  private buffer: Float32Array[] = [];
  private bufferIndex = 0;
  private currentFrame = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => {
      if (e.data.pcm) {
        this.buffer.push(e.data.pcm);
      }
    };
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>
  ): boolean {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const channel = output[0];
    let frameCount = 0;

    // Fill output buffer from queued PCM data
    while (frameCount < channel.length && this.buffer.length > 0) {
      const pcm = this.buffer[0];
      const remaining = pcm.length - this.bufferIndex;
      const toWrite = Math.min(remaining, channel.length - frameCount);

      for (let i = 0; i < toWrite; i++) {
        channel[frameCount + i] = pcm[this.bufferIndex + i];
      }

      this.bufferIndex += toWrite;
      frameCount += toWrite;

      if (this.bufferIndex >= pcm.length) {
        this.buffer.shift();
        this.bufferIndex = 0;
      }
    }

    return true;
  }
}

registerProcessor('stdb-audio-playback', StdbAudioPlaybackWorklet);
