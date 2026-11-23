class ProbeMeter extends AudioWorkletProcessor {
  constructor() {
    super();
    this.calls = 0;
    this.frames = 0;
    this.peak = 0;
    this.nonZeroBlocks = 0;
  }
  process(inputs) {
    this.calls++;
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      this.frames += ch.length;
      let blockPeak = 0;
      for (let i = 0; i < ch.length; i++) {
        const v = Math.abs(ch[i]);
        if (v > blockPeak) blockPeak = v;
      }
      if (blockPeak > 0) this.nonZeroBlocks++;
      if (blockPeak > this.peak) this.peak = blockPeak;
    }
    if (this.calls % 50 === 0) {
      this.port.postMessage({ calls: this.calls, frames: this.frames, peak: this.peak, nonZeroBlocks: this.nonZeroBlocks });
    }
    return true;
  }
}
registerProcessor('probe-meter', ProbeMeter);
