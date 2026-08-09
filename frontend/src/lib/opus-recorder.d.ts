declare module 'opus-recorder' {
  interface OpusRecorderConfig {
    encoderSampleRate?: number;
    encoderChannels?: number;
    streamPages?: boolean;
    numberOfChannels?: number;
    resampleQuality?: number;
    encoderComplexity?: number;
    encoderBitRate?: number;
    encoderApplication?: number;
    /** Path/URL to the encoder worker script (defaults to root "encoderWorker.min.js"). */
    encoderPath?: string | URL;
  }

  export default class OpusRecorder {
    constructor(config?: OpusRecorderConfig);
    ondataavailable?: (data: ArrayBuffer) => void;
    onpause?: () => void;
    onstop?: () => void;
    start(stream: MediaStream): Promise<void>;
    stop(): void;
    pause(): void;
    resume(): void;
  }
}
