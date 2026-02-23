type UploadSource = 'direct-upload-json' | 'direct-upload-multipart' | 'resumable-complete';

export interface CompressionUploadSample {
	timestamp: number;
	source: UploadSource;
	fileExt: string;
	mimeType: string;
	originalBytes: number;
	storedBytes: number;
	durationMs: number;
	atRestEncrypted: boolean;
}

export interface CompressionDownloadSample {
	timestamp: number;
	fileExt: string;
	mimeType: string;
	storedBytes: number;
	responseBytes: number;
	durationMs: number;
	decryptedAtRest: boolean;
	rangeRequest: boolean;
	streamed: boolean;
	statusCode: number;
}

interface CompressionCounters {
	uploadCount: number;
	downloadCount: number;
	uploadOriginalBytes: number;
	uploadStoredBytes: number;
	downloadStoredBytes: number;
	downloadResponseBytes: number;
}

const MAX_SAMPLES = 250;

const uploadSamples: CompressionUploadSample[] = [];
const downloadSamples: CompressionDownloadSample[] = [];

const counters: CompressionCounters = {
	uploadCount: 0,
	downloadCount: 0,
	uploadOriginalBytes: 0,
	uploadStoredBytes: 0,
	downloadStoredBytes: 0,
	downloadResponseBytes: 0
};

function pushBounded<T>(arr: T[], value: T): void {
	arr.push(value);
	if (arr.length > MAX_SAMPLES) {
		arr.splice(0, arr.length - MAX_SAMPLES);
	}
}

export function recordCompressionUploadSample(sample: CompressionUploadSample): void {
	counters.uploadCount += 1;
	counters.uploadOriginalBytes += sample.originalBytes;
	counters.uploadStoredBytes += sample.storedBytes;
	pushBounded(uploadSamples, sample);
}

export function recordCompressionDownloadSample(sample: CompressionDownloadSample): void {
	counters.downloadCount += 1;
	counters.downloadStoredBytes += sample.storedBytes;
	counters.downloadResponseBytes += sample.responseBytes;
	pushBounded(downloadSamples, sample);
}

export function resetCompressionMetrics(): void {
	uploadSamples.length = 0;
	downloadSamples.length = 0;
	counters.uploadCount = 0;
	counters.downloadCount = 0;
	counters.uploadOriginalBytes = 0;
	counters.uploadStoredBytes = 0;
	counters.downloadStoredBytes = 0;
	counters.downloadResponseBytes = 0;
}

function summarizeByExt(samples: Array<{ fileExt: string; originalBytes?: number; storedBytes: number; responseBytes?: number }>) {
	const extMap = new Map<string, { count: number; originalBytes: number; storedBytes: number; responseBytes: number }>();
	for (const sample of samples) {
		const ext = sample.fileExt || 'unknown';
		const current = extMap.get(ext) || { count: 0, originalBytes: 0, storedBytes: 0, responseBytes: 0 };
		current.count += 1;
		current.originalBytes += sample.originalBytes || 0;
		current.storedBytes += sample.storedBytes;
		current.responseBytes += sample.responseBytes || 0;
		extMap.set(ext, current);
	}
	return Array.from(extMap.entries())
		.map(([fileExt, data]) => ({ fileExt, ...data }))
		.sort((a, b) => b.count - a.count)
		.slice(0, 20);
}

export function getCompressionMetricsSnapshot() {
	const uploadRatio =
		counters.uploadOriginalBytes > 0
			? counters.uploadStoredBytes / counters.uploadOriginalBytes
			: null;
	const downloadRatio =
		counters.downloadStoredBytes > 0
			? counters.downloadResponseBytes / counters.downloadStoredBytes
			: null;

	return {
		counters: {
			...counters,
			uploadStoredToOriginalRatio: uploadRatio,
			downloadResponseToStoredRatio: downloadRatio
		},
		summaryByExt: {
			uploads: summarizeByExt(uploadSamples),
			downloads: summarizeByExt(downloadSamples)
		},
		recentSamples: {
			uploads: uploadSamples.slice(-50),
			downloads: downloadSamples.slice(-50)
		}
	};
}
