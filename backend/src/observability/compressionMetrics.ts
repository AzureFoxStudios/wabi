type UploadSource = 'direct-upload-json' | 'direct-upload-multipart' | 'resumable-complete';
export type ClientVideoCompressionOutcome = 'success' | 'failure' | 'cancelled' | 'skipped';
export type ClientVideoCompressionRuntime = 'desktop' | 'android' | 'ios' | 'web' | 'unknown';

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

export interface ClientVideoCompressionSample {
	timestamp: number;
	runtime: ClientVideoCompressionRuntime;
	preset: string;
	outcome: ClientVideoCompressionOutcome;
	inputBytes: number;
	outputBytes: number | null;
	durationMs: number | null;
	failureCode: string | null;
}

interface CompressionCounters {
	uploadCount: number;
	downloadCount: number;
	uploadOriginalBytes: number;
	uploadStoredBytes: number;
	downloadStoredBytes: number;
	downloadResponseBytes: number;
}

interface ClientVideoCompressionCounters {
	attemptCount: number;
	successCount: number;
	failureCount: number;
	cancelledCount: number;
	skippedCount: number;
	timeoutCount: number;
	notSmallerCount: number;
	inputBytes: number;
	outputBytes: number;
}

const MAX_SAMPLES = 250;

const uploadSamples: CompressionUploadSample[] = [];
const downloadSamples: CompressionDownloadSample[] = [];
const clientVideoCompressionSamples: ClientVideoCompressionSample[] = [];

const counters: CompressionCounters = {
	uploadCount: 0,
	downloadCount: 0,
	uploadOriginalBytes: 0,
	uploadStoredBytes: 0,
	downloadStoredBytes: 0,
	downloadResponseBytes: 0
};

const clientVideoCompressionCounters: ClientVideoCompressionCounters = {
	attemptCount: 0,
	successCount: 0,
	failureCount: 0,
	cancelledCount: 0,
	skippedCount: 0,
	timeoutCount: 0,
	notSmallerCount: 0,
	inputBytes: 0,
	outputBytes: 0
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

export function recordClientVideoCompressionSample(sample: ClientVideoCompressionSample): void {
	if (sample.outcome !== 'skipped') {
		clientVideoCompressionCounters.attemptCount += 1;
	}

	if (sample.outcome === 'success') {
		clientVideoCompressionCounters.successCount += 1;
		clientVideoCompressionCounters.inputBytes += sample.inputBytes;
		if (sample.outputBytes !== null) {
			clientVideoCompressionCounters.outputBytes += sample.outputBytes;
		}
	} else if (sample.outcome === 'failure') {
		clientVideoCompressionCounters.failureCount += 1;
	} else if (sample.outcome === 'cancelled') {
		clientVideoCompressionCounters.cancelledCount += 1;
	} else if (sample.outcome === 'skipped') {
		clientVideoCompressionCounters.skippedCount += 1;
	}

	if (sample.failureCode === 'timeout') {
		clientVideoCompressionCounters.timeoutCount += 1;
	}
	if (sample.failureCode === 'not_smaller') {
		clientVideoCompressionCounters.notSmallerCount += 1;
	}

	pushBounded(clientVideoCompressionSamples, sample);
}

export function resetCompressionMetrics(): void {
	uploadSamples.length = 0;
	downloadSamples.length = 0;
	clientVideoCompressionSamples.length = 0;
	counters.uploadCount = 0;
	counters.downloadCount = 0;
	counters.uploadOriginalBytes = 0;
	counters.uploadStoredBytes = 0;
	counters.downloadStoredBytes = 0;
	counters.downloadResponseBytes = 0;
	clientVideoCompressionCounters.attemptCount = 0;
	clientVideoCompressionCounters.successCount = 0;
	clientVideoCompressionCounters.failureCount = 0;
	clientVideoCompressionCounters.cancelledCount = 0;
	clientVideoCompressionCounters.skippedCount = 0;
	clientVideoCompressionCounters.timeoutCount = 0;
	clientVideoCompressionCounters.notSmallerCount = 0;
	clientVideoCompressionCounters.inputBytes = 0;
	clientVideoCompressionCounters.outputBytes = 0;
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

function summarizeClientByRuntime(samples: ClientVideoCompressionSample[]) {
	const runtimeMap = new Map<
		string,
		{
			count: number;
			successCount: number;
			failureCount: number;
			cancelledCount: number;
			skippedCount: number;
		}
	>();

	for (const sample of samples) {
		const key = sample.runtime || 'unknown';
		const current = runtimeMap.get(key) || {
			count: 0,
			successCount: 0,
			failureCount: 0,
			cancelledCount: 0,
			skippedCount: 0
		};
		current.count += 1;
		if (sample.outcome === 'success') current.successCount += 1;
		if (sample.outcome === 'failure') current.failureCount += 1;
		if (sample.outcome === 'cancelled') current.cancelledCount += 1;
		if (sample.outcome === 'skipped') current.skippedCount += 1;
		runtimeMap.set(key, current);
	}

	return Array.from(runtimeMap.entries())
		.map(([runtime, data]) => ({ runtime, ...data }))
		.sort((a, b) => b.count - a.count);
}

function summarizeClientFailureCodes(samples: ClientVideoCompressionSample[]) {
	const codeMap = new Map<string, number>();
	for (const sample of samples) {
		if (!sample.failureCode) continue;
		codeMap.set(sample.failureCode, (codeMap.get(sample.failureCode) || 0) + 1);
	}
	return Array.from(codeMap.entries())
		.map(([failureCode, count]) => ({ failureCode, count }))
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
	const clientSuccessRate =
		clientVideoCompressionCounters.attemptCount > 0
			? clientVideoCompressionCounters.successCount / clientVideoCompressionCounters.attemptCount
			: null;
	const clientStoredRatio =
		clientVideoCompressionCounters.inputBytes > 0
			? clientVideoCompressionCounters.outputBytes / clientVideoCompressionCounters.inputBytes
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
		},
		clientVideoCompression: {
			counters: {
				...clientVideoCompressionCounters,
				successRate: clientSuccessRate,
				outputToInputRatio: clientStoredRatio
			},
			summaryByRuntime: summarizeClientByRuntime(clientVideoCompressionSamples),
			topFailureCodes: summarizeClientFailureCodes(clientVideoCompressionSamples),
			recentSamples: clientVideoCompressionSamples.slice(-50)
		}
	};
}
