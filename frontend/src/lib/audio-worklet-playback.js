/**
 * AudioWorklet for smooth playback of incoming opus-decoded PCM data.
 * Registers as 'wabidb-audio-playback' processor.
 *
 * Plain JS (not TS) on purpose: AudioWorklet modules must be loaded as
 * classic scripts, so this file is referenced via `new URL(...)` and served
 * as-is by the bundler. `AudioWorkletProcessor` / `registerProcessor` are
 * globals in the AudioWorkletGlobalScope.
 */

// Senders ship 40 ms pages over a TCP socket, so audio lands in uneven bursts. Playing each
// page the moment it lands turns every late burst into a hole, so playback holds a small
// reserve first (a jitter buffer) and only starts once that reserve is in hand.
const START_MS = 120; // reserve held on a steady link: three pages
const MAX_MS = 320; // the most delay a rough link may earn
const STEP_MS = 40; // one page more reserve after each hole
const HEADROOM_MS = 400; // backlog allowed above the reserve before skipping ahead
const SLACK_MS = 240; // backlog above the reserve that is left alone: a stall's burst is free reserve
const QUIET = 0.01; // below this peak a block is a pause between words
const CALM_MS = 30000; // this long without a hole gives one step back
const RESUME_MS = 500; // running dry and resuming this fast is the link, not a pause in talk

class WabidbAudioPlaybackWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    // Bounded ring: a stalled/backgrounded client must not play minutes of
    // old conversation after returning. No allocations in the render loop.
    this.buffer = new Float32Array(Math.ceil(sampleRate * 1));
    this.readIndex = 0;
    this.length = 0;
    this.reported = false;
    this.sinceReport = 0;
    this.sinceTick = 0;
    // What the listener would hear as trouble, counted for the call's connection details:
    // samples thrown away because audio arrived faster than it could be played (a cut), and
    // the times playback ran out of audio mid-stream (a gap).
    this.cutSamples = 0;
    this.gaps = 0;
    this.trimmedSamples = 0; // pauses dropped to catch up: not heard, so not a cut
    this.playing = false;
    this.target = this.samples(START_MS);
    this.waited = 0; // frames spent holding a part-filled reserve with nothing new arriving
    this.sinceDry = Infinity; // frames since playback last ran dry
    this.calm = 0; // frames played since the last hole
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'reset') {
        this.length = 0;
        this.readIndex = 0;
        this.sinceReport = 0;
        this.reported = false;
        this.playing = false;
        this.waited = 0;
        this.sinceDry = Infinity;
        return;
      }
      const pcm = data?.pcm;
      if (!(pcm instanceof Float32Array)) return;
      // Audio back this soon after running dry means the reserve was too thin for this link.
      if (!this.playing && this.sinceDry < this.samples(RESUME_MS)) {
        this.target = Math.min(this.samples(MAX_MS), this.target + this.samples(STEP_MS));
        this.calm = 0;
      }
      this.sinceDry = Infinity;
      this.waited = 0;
      const count = Math.min(pcm.length, this.buffer.length);
      const overflow = Math.max(0, this.length + count - this.buffer.length);
      this.drop(overflow);
      this.cutSamples += pcm.length - count;
      let writeIndex = (this.readIndex + this.length) % this.buffer.length;
      for (let i = pcm.length - count; i < pcm.length; i++) {
        this.buffer[writeIndex] = Number.isFinite(pcm[i]) ? pcm[i] : 0;
        writeIndex = (writeIndex + 1) % this.buffer.length;
      }
      this.length += count;
      // Too far behind (a burst after a stall, or a sender clock running fast): skip ahead to
      // the reserve in one move instead of shaving a sliver off every page from then on.
      if (this.length > this.target + this.samples(HEADROOM_MS)) this.drop(this.length - this.target);
    };
  }

  samples(ms) {
    return Math.round((sampleRate * ms) / 1000);
  }

  /** True when the next `frames` samples are a pause: no peak worth hearing. */
  quietAhead(frames) {
    for (let i = 0; i < frames; i++) {
      const sample = this.buffer[(this.readIndex + i) % this.buffer.length];
      if (sample > QUIET || sample < -QUIET) return false;
    }
    return true;
  }

  drop(count) {
    if (count <= 0) return;
    this.readIndex = (this.readIndex + count) % this.buffer.length;
    this.length -= count;
    this.cutSamples += count;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    for (const channel of output) channel.fill(0);
    const frames = output[0].length;
    this.sinceTick += frames;
    if (this.sinceDry !== Infinity) this.sinceDry += frames;
    if (!this.playing && this.length > 0) {
      // Start once the reserve is in hand. If the talker stopped before it filled, play the
      // tail out now so the end of a sentence is not held back until they speak again.
      this.waited += frames;
      if (this.length >= this.target || this.waited >= this.target) this.playing = true;
    }
    let count = 0;
    let ranDry = false;
    if (this.playing) {
      // Behind after a late burst: catch up by dropping pauses between words, which nobody
      // hears, before it ever comes to skipping speech.
      if (this.length > this.target + this.samples(SLACK_MS) + frames && this.quietAhead(frames)) {
        this.readIndex = (this.readIndex + frames) % this.buffer.length;
        this.length -= frames;
        this.trimmedSamples += frames;
      }
      count = Math.min(frames, this.length);
      for (let i = 0; i < count; i++) {
        for (const channel of output) channel[i] = this.buffer[this.readIndex];
        this.readIndex = (this.readIndex + 1) % this.buffer.length;
      }
      this.length -= count;
      this.sinceReport += count;
      this.calm += count;
      if (this.calm >= this.samples(CALM_MS)) {
        this.calm = 0;
        this.target = Math.max(this.samples(START_MS), this.target - this.samples(STEP_MS));
      }
      // Running dry after audio had been playing is one gap, however long the silence lasts.
      // Playback then waits for the reserve again instead of stuttering page by page.
      if (count < frames) {
        this.gaps++;
        this.playing = false;
        this.waited = 0;
        this.sinceDry = 0;
        ranDry = true;
      }
    }
    // `rendered` proves the processor consumed PCM, not that a physical speaker is audible.
    // Silence is valid audio; do not require someone to talk. While holding the reserve the
    // numbers still go out (as `waiting`) so connection details never freeze on an old value.
    // Running dry is said at once: nothing more is posted while it stays dry.
    const due = !this.reported || this.sinceTick >= sampleRate / 10;
    if (ranDry || (due && (count > 0 || this.sinceReport > 0 || this.length > 0))) {
      this.port.postMessage({
        type: this.sinceReport > 0 ? 'rendered' : 'waiting',
        samples: this.sinceReport,
        buffered: this.length,
        target: this.target,
        cutSamples: this.cutSamples,
        trimmedSamples: this.trimmedSamples,
        gaps: this.gaps
      });
      this.sinceReport = 0;
      this.sinceTick = 0;
      this.reported = true;
    }

    return true;
  }
}

registerProcessor('wabidb-audio-playback', WabidbAudioPlaybackWorklet);
