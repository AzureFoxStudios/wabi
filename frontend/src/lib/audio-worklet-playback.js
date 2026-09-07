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
    // Bounded ring: a stalled/backgrounded client must not play minutes of
    // old conversation after returning. No allocations in the render loop.
    this.buffer = new Float32Array(Math.ceil(sampleRate * 0.5));
    this.readIndex = 0;
    this.length = 0;
    this.reported = false;
    this.sinceReport = 0;
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'reset') {
        this.length = 0;
        this.readIndex = 0;
        this.sinceReport = 0;
        this.reported = false;
        return;
      }
      const pcm = data?.pcm;
      if (!(pcm instanceof Float32Array)) return;
      const count = Math.min(pcm.length, this.buffer.length);
      const overflow = Math.max(0, this.length + count - this.buffer.length);
      this.readIndex = (this.readIndex + overflow) % this.buffer.length;
      this.length -= overflow;
      let writeIndex = (this.readIndex + this.length) % this.buffer.length;
      for (let i = pcm.length - count; i < pcm.length; i++) {
        this.buffer[writeIndex] = Number.isFinite(pcm[i]) ? pcm[i] : 0;
        writeIndex = (writeIndex + 1) % this.buffer.length;
      }
      this.length += count;
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    for (const channel of output) channel.fill(0);
    const count = Math.min(output[0].length, this.length);
    for (let i = 0; i < count; i++) {
      for (const channel of output) channel[i] = this.buffer[this.readIndex];
      this.readIndex = (this.readIndex + 1) % this.buffer.length;
    }
    this.length -= count;
    this.sinceReport += count;
    // This proves the processor consumed PCM, not that a physical speaker
    // is audible. Silence is valid audio; do not require someone to talk.
    if (count > 0 && (!this.reported || this.sinceReport >= sampleRate / 10)) {
      this.port.postMessage({ type: 'rendered', samples: this.sinceReport });
      this.sinceReport = 0;
      this.reported = true;
    }

    return true;
  }
}

registerProcessor('wabidb-audio-playback', WabidbAudioPlaybackWorklet);
