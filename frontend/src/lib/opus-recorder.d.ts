declare module 'opus-recorder' {
  interface OpusRecorderConfig {
    encoderSampleRate?: number;
    sourceNode?: MediaStreamAudioSourceNode;
    bufferLength?: number;
    encoderFrameSize?: number;
    maxFramesPerPage?: number;
    monitorGain?: number;
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
    ondataavailable?: (data: Uint8Array) => void;
    onpause?: () => void;
    onstop?: () => void;
    /** Constructor's asynchronous encoder/worklet initialization. */
    initialize: Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    close(): Promise<void>;
    pause(): void;
    resume(): void;
  }
}
