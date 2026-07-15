/**
 * AudioWorklet for smooth playback of incoming opus-decoded PCM data.
 * Registers as 'wabidb-audio-playback' processor.
 *
 * Plain JS (not TS) on purpose: AudioWorklet modules must be loaded as
 * classic scripts, so this file is referenced via `new URL(...)` and served
 * as-is by the bundler. `AudioWorkletProcessor` / `registerProcessor` are
 * globals in the AudioWorkletGlobalScope.
 */

class WabidbAudioPlaybackWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
    this.bufferIndex = 0;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const channel = output[0];
    let frameCount = 0;

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

registerProcessor('wabidb-audio-playback', WabidbAudioPlaybackWorklet);
