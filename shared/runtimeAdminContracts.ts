export type UploadRoleTier = 'new' | 'trusted' | 'moderator' | 'admin' | 'owner';

export interface UploadLimitConfig {
  perRoleBytes: Record<UploadRoleTier, number | null>;
  globalUploadCapBytes: number | null;
}

export interface DownloadLimitConfig {
  perRoleBytes: Record<UploadRoleTier, number | null>;
  globalDownloadCapBytes: number | null;
}

export interface RuntimeTuningConfig {
  applyOnRestart: true;
  threadPoolSize: number | null;
  heavyProfilingEnabled: boolean;
  heavyProfilingSampleRate: number;
}

export interface AdminCompressionConfig {
  httpTextCompression: {
    enabled: boolean;
    minBytes: number;
    brotliQuality: number;
    gzipLevel: number;
  };
  uploadCompression: {
    enabled: boolean;
    minBytes: number;
    gzipLevel: number;
    rolloutPercent: number;
  };
}

export interface AdminCompressionMetrics {
  counters: {
    uploadCount: number;
    downloadCount: number;
    uploadOriginalBytes: number;
    uploadStoredBytes: number;
    downloadStoredBytes: number;
    downloadResponseBytes: number;
    uploadStoredToOriginalRatio: number | null;
    downloadResponseToStoredRatio: number | null;
  };
  summaryByExt: {
    uploads: Array<{
      fileExt: string;
      count: number;
      originalBytes: number;
      storedBytes: number;
      responseBytes: number;
    }>;
    downloads: Array<{
      fileExt: string;
      count: number;
      originalBytes: number;
      storedBytes: number;
      responseBytes: number;
    }>;
  };
  recentSamples: {
    uploads: Array<Record<string, unknown>>;
    downloads: Array<Record<string, unknown>>;
  };
  clientVideoCompression?: {
    counters: {
      attemptCount: number;
      successCount: number;
      failureCount: number;
      cancelledCount: number;
      skippedCount: number;
      timeoutCount: number;
      notSmallerCount: number;
      inputBytes: number;
      outputBytes: number;
      successRate: number | null;
      outputToInputRatio: number | null;
    };
    summaryByRuntime: Array<{
      runtime: string;
      count: number;
      successCount: number;
      failureCount: number;
      cancelledCount: number;
      skippedCount: number;
    }>;
    topFailureCodes: Array<{
      failureCode: string;
      count: number;
    }>;
    recentSamples: Array<Record<string, unknown>>;
  };
}

export interface RuntimeGuardrailsSnapshot {
  uptimeSeconds: number;
  memory: {
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    externalBytes: number;
    arrayBuffersBytes: number;
  };
  cpu: {
    userMicros: number;
    systemMicros: number;
  };
  heavyProfiling: {
    enabled: boolean;
    eventLoopDelayP95Ms: number | null;
    eventLoopDelayMaxMs: number | null;
  };
}

export interface AdminRuntimeGuardrailsResponse {
  runtimeTuning: {
    configured: RuntimeTuningConfig;
    startupApplied: RuntimeTuningConfig;
    restartRequired: boolean;
    effective: {
      uvThreadpoolSize: number | null;
      heavyProfilingEnabled: boolean;
    };
  };
  guardrails: RuntimeGuardrailsSnapshot;
}

export type DesktopHelperMode = 'files-only' | 'desktop-assist';

export interface DesktopHelperRegistrationPayload {
  helperId: string;
  name: string;
  mode: DesktopHelperMode;
  region?: string | null;
}
