import type { IncomingMessage, ServerResponse } from 'http';
import { spawn, type ChildProcess } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

function boolFromEnv(value: string | undefined, fallback: boolean = false): boolean {
	if (value == null) return fallback;
	return value === 'true' || value === '1';
}

function numberFromEnv(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

interface GatewayHeartbeatState {
	lastSeenAt: number;
	version?: string;
	region?: string;
	activeStreams?: number;
	packetLossPct?: number;
	jitterMs?: number;
	rttMs?: number;
	bitrateKbps?: number;
	reconnections?: number;
}

const gatewayHeartbeat: GatewayHeartbeatState = {
	lastSeenAt: 0
};


interface MediaGatewayMetrics {
	pipelineStartRequests: number;
	pipelineStopRequests: number;
	pipelineRestarts: number;
	pipelineErrors: number;
	forcedKills: number;
	lastPipelineStartAt: number | null;
	lastPipelineStopAt: number | null;
}

const mediaGatewayMetrics: MediaGatewayMetrics = {
	pipelineStartRequests: 0,
	pipelineStopRequests: 0,
	pipelineRestarts: 0,
	pipelineErrors: 0,
	forcedKills: 0,
	lastPipelineStartAt: null,
	lastPipelineStopAt: null
};

const SRT_PRESETS = ['copy', 'low-latency-720p', 'balanced-1080p'] as const;
type SrtPreset = typeof SRT_PRESETS[number];

interface SrtPipelineState {
	pipelineId: string;
	inputUrl: string;
	outputUrl: string;
	startedAt: number;
	updatedAt: number;
	pid: number | null;
	status: 'starting' | 'running' | 'stopped' | 'error';
	transcodePreset: SrtPreset;
	restartCount: number;
	lastExitAt?: number;
	stopRequestedAt?: number;
	lastError?: string;
}

const srtPipelines = new Map<string, SrtPipelineState>();
const srtPipelineProcesses = new Map<string, ChildProcess>();
const pipelineStateFile = process.env.MEDIA_PIPELINE_STATE_FILE || join(process.cwd(), 'data', 'media-pipelines.json');
let mediaConfigValidated = false;

function validateMediaConfigOnce(): void {
	if (mediaConfigValidated) return;
	mediaConfigValidated = true;

	const configuredTokens = (process.env.MEDIA_PIPELINE_TOKENS || '').trim();
	if (!configuredTokens && boolFromEnv(process.env.MEDIA_SRT_GATEWAY_ENABLED, false)) {
		console.warn('[MediaRuntime] MEDIA_PIPELINE_TOKENS is not configured while SRT gateway mode is enabled.');
	}

	const maxPipelines = numberFromEnv(process.env.MEDIA_MAX_PIPELINES, 8);
	if (maxPipelines <= 0) {
		console.warn('[MediaRuntime] MEDIA_MAX_PIPELINES should be > 0. Current value will block new pipelines.');
	}

	const gatewayKey = (process.env.MEDIA_GATEWAY_KEY || '').trim();
	if (!gatewayKey) {
		console.warn('[MediaRuntime] MEDIA_GATEWAY_KEY is not configured; pipeline endpoints remain inaccessible.');
	}

	const restartMax = numberFromEnv(process.env.MEDIA_PIPELINE_MAX_RESTARTS, 3);
	if (restartMax < 0) {
		console.warn('[MediaRuntime] MEDIA_PIPELINE_MAX_RESTARTS should be >= 0.');
	}
}


function loadPersistedPipelineState(): void {
	try {
		const raw = readFileSync(pipelineStateFile, 'utf-8');
		const parsed = JSON.parse(raw) as { pipelines?: SrtPipelineState[] };
		if (!Array.isArray(parsed.pipelines)) return;

		for (const pipeline of parsed.pipelines) {
			srtPipelines.set(pipeline.pipelineId, {
				...pipeline,
				pid: null,
				status: pipeline.status === 'running' || pipeline.status === 'starting' ? 'stopped' : pipeline.status,
				lastError: pipeline.status === 'running' || pipeline.status === 'starting'
					? 'Recovered after backend restart; previous process state was reset'
					: pipeline.lastError,
				updatedAt: Date.now()
			});
		}
	} catch {
		// no persisted state yet
	}
}

function persistPipelineState(): void {
	try {
		mkdirSync(dirname(pipelineStateFile), { recursive: true });
		const pipelines = Array.from(srtPipelines.values()).map(pipeline => ({
			...pipeline,
			pid: null
		}));
		writeFileSync(pipelineStateFile, JSON.stringify({ pipelines }, null, 2), 'utf-8');
	} catch (error) {
		console.error('[MediaRuntime] Failed to persist pipeline state:', error);
	}
}

loadPersistedPipelineState();

function isGatewayAuthorized(req: IncomingMessage): boolean {
	const configuredKey = process.env.MEDIA_GATEWAY_KEY;
	if (!configuredKey) return false;
	const provided = req.headers['x-media-gateway-key'];
	return typeof provided === 'string' && provided === configuredKey;
}

function isPipelineControlAuthorized(payload: Record<string, unknown>): boolean {
	const configured = (process.env.MEDIA_PIPELINE_TOKENS || '')
		.split(',')
		.map(value => value.trim())
		.filter(Boolean);
	if (configured.length === 0) return true;
	const provided = typeof payload.streamToken === 'string' ? payload.streamToken : '';
	return configured.includes(provided);
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
	let body = '';
	await new Promise<void>((resolve, reject) => {
		req.on('data', chunk => {
			body += chunk.toString();
		});
		req.on('end', () => resolve());
		req.on('error', reject);
	});
	return body;
}

function parseJsonBody(body: string): Record<string, unknown> | null {
	if (!body) return {};
	try {
		return JSON.parse(body) as Record<string, unknown>;
	} catch {
		return null;
	}
}


function numberFromPayload(payload: Record<string, unknown>, key: string): number | undefined {
	const value = payload[key];
	if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
	return value;
}

function getPipelineList(): SrtPipelineState[] {
	return Array.from(srtPipelines.values()).sort((a, b) => b.startedAt - a.startedAt);
}

function isSrtPreset(value: string): value is SrtPreset {
	return (SRT_PRESETS as readonly string[]).includes(value);
}

function isAllowedPipelineUrl(url: string): boolean {
	const allowedSchemes = (process.env.MEDIA_ALLOWED_PIPELINE_SCHEMES || 'srt,udp,rtmp,rtmps')
		.split(',')
		.map(value => value.trim().toLowerCase())
		.filter(Boolean);
	const lower = url.toLowerCase();
	return allowedSchemes.some(scheme => lower.startsWith(`${scheme}://`));
}

function updatePipelineState(pipelineId: string, update: Partial<SrtPipelineState>): SrtPipelineState | null {
	const existing = srtPipelines.get(pipelineId);
	if (!existing) return null;
	const next = {
		...existing,
		...update,
		updatedAt: Date.now()
	};
	srtPipelines.set(pipelineId, next);
	persistPipelineState();
	return next;
}

function trimPipelineHistoryIfNeeded(): void {
	const limit = numberFromEnv(process.env.MEDIA_PIPELINE_HISTORY_LIMIT, 100);
	if (srtPipelines.size <= limit) return;

	const removable = getPipelineList()
		.filter(pipeline => pipeline.status !== 'running' && pipeline.status !== 'starting')
		.sort((a, b) => a.updatedAt - b.updatedAt);

	for (const pipeline of removable) {
		if (srtPipelines.size <= limit) break;
		srtPipelines.delete(pipeline.pipelineId);
	}
	persistPipelineState();
}

function buildFfmpegArgs(inputUrl: string, outputUrl: string, preset: SrtPreset): string[] {
	if (preset === 'copy') {
		return ['-re', '-i', inputUrl, '-c', 'copy', '-f', 'mpegts', outputUrl];
	}

	if (preset === 'low-latency-720p') {
		return [
			'-re', '-i', inputUrl,
			'-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'main',
			'-vf', 'scale=-2:720',
			'-b:v', '2500k',
			'-c:a', 'aac', '-b:a', '128k',
			'-f', 'mpegts', outputUrl
		];
	}

	return [
		'-re', '-i', inputUrl,
		'-c:v', 'libx264', '-preset', 'medium', '-profile:v', 'high',
		'-b:v', '4500k',
		'-c:a', 'aac', '-b:a', '160k',
		'-f', 'mpegts', outputUrl
	];
}

function shouldAttemptRestart(pipeline: SrtPipelineState, exitCode: number | null): boolean {
	if (!boolFromEnv(process.env.MEDIA_PIPELINE_AUTO_RESTART_ENABLED, false)) return false;
	if (pipeline.stopRequestedAt && pipeline.stopRequestedAt > pipeline.startedAt) return false;
	if (exitCode === 0) return false;
	const maxRestarts = numberFromEnv(process.env.MEDIA_PIPELINE_MAX_RESTARTS, 3);
	return pipeline.restartCount < maxRestarts;
}

function spawnPipelineProcess(pipelineId: string): boolean {
	const pipeline = srtPipelines.get(pipelineId);
	if (!pipeline) return false;

	const ffmpegPath = process.env.MEDIA_FFMPEG_BIN || 'ffmpeg';
	const ffmpegArgs = buildFfmpegArgs(pipeline.inputUrl, pipeline.outputUrl, pipeline.transcodePreset);
	const child = spawn(ffmpegPath, ffmpegArgs, {
		stdio: 'ignore',
		detached: false
	});

	srtPipelineProcesses.set(pipelineId, child);
	updatePipelineState(pipelineId, {
		pid: child.pid ?? null,
		status: child.pid ? 'running' : 'starting',
		lastError: undefined,
		stopRequestedAt: undefined
	});

	child.once('spawn', () => {
		updatePipelineState(pipelineId, {
			status: 'running',
			pid: child.pid ?? null,
			lastError: undefined
		});
	});

	child.once('error', error => {
		mediaGatewayMetrics.pipelineErrors += 1;
		updatePipelineState(pipelineId, {
			status: 'error',
			lastError: error.message,
			pid: null,
			lastExitAt: Date.now()
		});
		srtPipelineProcesses.delete(pipelineId);
		trimPipelineHistoryIfNeeded();
	});

	child.once('exit', (code, signal) => {
		const existing = srtPipelines.get(pipelineId);
		srtPipelineProcesses.delete(pipelineId);
		if (!existing) return;

		if (shouldAttemptRestart(existing, code)) {
			const restartDelayMs = numberFromEnv(process.env.MEDIA_PIPELINE_RESTART_DELAY_MS, 750);
			mediaGatewayMetrics.pipelineRestarts += 1;
			updatePipelineState(pipelineId, {
				status: 'starting',
				pid: null,
				restartCount: existing.restartCount + 1,
				lastExitAt: Date.now(),
				lastError: `Restarting after exit code ${code ?? 'null'} signal ${signal ?? 'null'}`
			});
			setTimeout(() => {
				const current = srtPipelines.get(pipelineId);
				if (!current || current.status === 'stopped') return;
				try {
					spawnPipelineProcess(pipelineId);
				} catch (restartError) {
					updatePipelineState(pipelineId, {
						status: 'error',
						lastError: restartError instanceof Error ? restartError.message : String(restartError),
						pid: null,
						lastExitAt: Date.now()
					});
				}
			}, restartDelayMs);
			return;
		}

		if (code !== 0) {
			mediaGatewayMetrics.pipelineErrors += 1;
		}
		updatePipelineState(pipelineId, {
			status: code === 0 ? 'stopped' : 'error',
			lastError: code === 0 ? undefined : `Exited with code ${code ?? 'null'} signal ${signal ?? 'null'}`,
			pid: null,
			lastExitAt: Date.now()
		});
		trimPipelineHistoryIfNeeded();
	});

	return true;
}

async function stopProcessGracefully(processHandle: ChildProcess, timeoutMs: number): Promise<{ stopped: boolean; escalated: boolean }> {
	const pid = processHandle.pid;
	if (!pid) return { stopped: true, escalated: false };

	const terminated = processHandle.kill('SIGTERM');
	if (!terminated) {
		return { stopped: false, escalated: false };
	}

	const waitForExit = new Promise<boolean>(resolve => {
		const timer = setTimeout(() => resolve(false), timeoutMs);
		processHandle.once('exit', () => {
			clearTimeout(timer);
			resolve(true);
		});
	});

	const exitedInTime = await waitForExit;
	if (exitedInTime) {
		return { stopped: true, escalated: false };
	}

	processHandle.kill('SIGKILL');
	return { stopped: true, escalated: true };
}

// GET /api/media/runtime
export async function handleGetMediaRuntime(req: IncomingMessage, res: ServerResponse): Promise<void> {
	try {
		validateMediaConfigOnce();
		const srtGatewayEnabled = boolFromEnv(process.env.MEDIA_SRT_GATEWAY_ENABLED, false);
		const localEnhancedEnabled = boolFromEnv(process.env.MEDIA_LOCAL_ENHANCED_ENABLED, true);
		const heartbeatTimeoutMs = numberFromEnv(process.env.MEDIA_GATEWAY_HEARTBEAT_TIMEOUT_MS, 45_000);

		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({
			media: {
				localEnhancedEnabled,
				srtGatewayEnabled,
				srtGatewayUrl: process.env.MEDIA_SRT_GATEWAY_URL || null,
				opus: {
					audioBitrateWeb: numberFromEnv(process.env.MEDIA_OPUS_AUDIO_WEB_BITRATE, 64000),
					audioBitrateLocal: numberFromEnv(process.env.MEDIA_OPUS_AUDIO_LOCAL_BITRATE, 96000)
				},
				gateway: {
					configured: Boolean(process.env.MEDIA_SRT_GATEWAY_URL),
					heartbeatTimeoutMs,
					healthy: gatewayHeartbeat.lastSeenAt > 0 && Date.now() - gatewayHeartbeat.lastSeenAt < heartbeatTimeoutMs,
					lastSeenAt: gatewayHeartbeat.lastSeenAt || null,
					activeStreams: gatewayHeartbeat.activeStreams ?? 0,
					version: gatewayHeartbeat.version || null,
					region: gatewayHeartbeat.region || null,
					transportMetrics: {
						packetLossPct: gatewayHeartbeat.packetLossPct ?? null,
						jitterMs: gatewayHeartbeat.jitterMs ?? null,
						rttMs: gatewayHeartbeat.rttMs ?? null,
						bitrateKbps: gatewayHeartbeat.bitrateKbps ?? null,
						reconnections: gatewayHeartbeat.reconnections ?? null
					},
					pipelines: {
						active: getPipelineList().filter(pipeline => pipeline.status === 'running').length,
						total: srtPipelines.size,
						availablePresets: [...SRT_PRESETS],
						maxConfigured: numberFromEnv(process.env.MEDIA_MAX_PIPELINES, 8),
						autoRestartEnabled: boolFromEnv(process.env.MEDIA_PIPELINE_AUTO_RESTART_ENABLED, false)
					},
					controlPlaneMetrics: mediaGatewayMetrics
				}
			},
			notes: {
				srtDirectBrowserSupported: false,
				message: 'SRT is expected to run through a server-side media gateway, not directly from browser WebRTC peers.'
			}
		}));
	} catch (error) {
		console.error('[MediaRuntime] Failed to return media runtime config:', error);
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Failed to read media runtime configuration' }));
	}
}

// POST /api/media/gateway-heartbeat
export async function handleMediaGatewayHeartbeat(req: IncomingMessage, res: ServerResponse): Promise<void> {
	if (!isGatewayAuthorized(req)) {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Unauthorized gateway heartbeat' }));
		return;
	}


	const body = await readRequestBody(req);
	const payload = parseJsonBody(body);
	if (!payload) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Invalid JSON in gateway heartbeat' }));
		return;
	}

	gatewayHeartbeat.lastSeenAt = Date.now();
	gatewayHeartbeat.version = typeof payload.version === 'string' ? payload.version : undefined;
	gatewayHeartbeat.region = typeof payload.region === 'string' ? payload.region : undefined;
	gatewayHeartbeat.activeStreams = typeof payload.activeStreams === 'number' ? payload.activeStreams : 0;
	gatewayHeartbeat.packetLossPct = numberFromPayload(payload, 'packetLossPct');
	gatewayHeartbeat.jitterMs = numberFromPayload(payload, 'jitterMs');
	gatewayHeartbeat.rttMs = numberFromPayload(payload, 'rttMs');
	gatewayHeartbeat.bitrateKbps = numberFromPayload(payload, 'bitrateKbps');
	gatewayHeartbeat.reconnections = numberFromPayload(payload, 'reconnections');

	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ ok: true }));
}

// GET /api/media/pipelines
export async function handleListMediaPipelines(req: IncomingMessage, res: ServerResponse): Promise<void> {
	if (!isGatewayAuthorized(req)) {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Unauthorized gateway pipeline access' }));
		return;
	}

	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ pipelines: getPipelineList() }));
}


// GET /api/media/metrics
export async function handleGetMediaMetrics(req: IncomingMessage, res: ServerResponse): Promise<void> {
	if (!isGatewayAuthorized(req)) {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Unauthorized media metrics access' }));
		return;
	}

	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({
		metrics: mediaGatewayMetrics,
		pipelines: getPipelineList()
	}));
}

// POST /api/media/pipelines/start
export async function handleStartMediaPipeline(req: IncomingMessage, res: ServerResponse): Promise<void> {
	if (!isGatewayAuthorized(req)) {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Unauthorized gateway pipeline start' }));
		return;
	}

	mediaGatewayMetrics.pipelineStartRequests += 1;
	mediaGatewayMetrics.lastPipelineStartAt = Date.now();

	const body = await readRequestBody(req);
	const payload = parseJsonBody(body);
	if (!payload) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
		return;
	}

	if (!isPipelineControlAuthorized(payload)) {
		res.writeHead(403, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Invalid or missing stream token' }));
		return;
	}

	const pipelineId = typeof payload.pipelineId === 'string' ? payload.pipelineId.trim() : '';
	const inputUrl = typeof payload.inputUrl === 'string' ? payload.inputUrl.trim() : '';
	const outputUrl = typeof payload.outputUrl === 'string' ? payload.outputUrl.trim() : '';
	const transcodePresetInput = typeof payload.transcodePreset === 'string' ? payload.transcodePreset : 'balanced-1080p';

	if (!pipelineId || !inputUrl || !outputUrl) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'pipelineId, inputUrl, and outputUrl are required' }));
		return;
	}

	if (!isAllowedPipelineUrl(inputUrl) || !isAllowedPipelineUrl(outputUrl)) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Only configured media URL schemes are allowed for pipeline URLs' }));
		return;
	}

	if (!isSrtPreset(transcodePresetInput)) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: `Invalid transcodePreset. Allowed: ${SRT_PRESETS.join(', ')}` }));
		return;
	}

	const maxPipelines = numberFromEnv(process.env.MEDIA_MAX_PIPELINES, 8);
	const runningCount = getPipelineList().filter(pipeline => pipeline.status === 'running' || pipeline.status === 'starting').length;
	if (runningCount >= maxPipelines) {
		res.writeHead(429, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: `Maximum concurrent pipelines reached (${maxPipelines})` }));
		return;
	}

	const existingPipeline = srtPipelines.get(pipelineId);
	if (existingPipeline?.status === 'running' || existingPipeline?.status === 'starting') {
		res.writeHead(409, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Pipeline is already running', pipeline: existingPipeline }));
		return;
	}

	const now = Date.now();
	srtPipelines.set(pipelineId, {
		pipelineId,
		inputUrl,
		outputUrl,
		startedAt: now,
		updatedAt: now,
		pid: null,
		status: 'starting',
		transcodePreset: transcodePresetInput,
		restartCount: 0,
		lastError: undefined,
		lastExitAt: undefined,
		stopRequestedAt: undefined
	});
	persistPipelineState();

	try {
		const spawned = spawnPipelineProcess(pipelineId);
		if (!spawned) {
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Failed to initialize pipeline process' }));
			return;
		}

		res.writeHead(202, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ ok: true, pipeline: srtPipelines.get(pipelineId) }));
	} catch (error) {
		srtPipelineProcesses.delete(pipelineId);
		updatePipelineState(pipelineId, {
			status: 'error',
			lastError: error instanceof Error ? error.message : String(error),
			pid: null,
			lastExitAt: Date.now()
		});
		trimPipelineHistoryIfNeeded();
		console.error('[MediaRuntime] Failed to spawn FFmpeg pipeline:', error);
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Failed to start media pipeline' }));
	}
}

// POST /api/media/pipelines/stop
export async function handleStopMediaPipeline(req: IncomingMessage, res: ServerResponse): Promise<void> {
	if (!isGatewayAuthorized(req)) {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Unauthorized gateway pipeline stop' }));
		return;
	}

	mediaGatewayMetrics.pipelineStopRequests += 1;
	mediaGatewayMetrics.lastPipelineStopAt = Date.now();

	const body = await readRequestBody(req);
	const payload = parseJsonBody(body);
	if (!payload) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
		return;
	}

	if (!isPipelineControlAuthorized(payload)) {
		res.writeHead(403, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Invalid or missing stream token' }));
		return;
	}

	const pipelineId = typeof payload.pipelineId === 'string' ? payload.pipelineId.trim() : '';
	if (!pipelineId) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'pipelineId is required' }));
		return;
	}

	const processHandle = srtPipelineProcesses.get(pipelineId);
	const existingPipeline = srtPipelines.get(pipelineId);
	if (!existingPipeline) {
		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Pipeline not found' }));
		return;
	}

	if (!processHandle) {
		updatePipelineState(pipelineId, {
			status: 'stopped',
			pid: null,
			stopRequestedAt: Date.now()
		});
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ ok: true, pipeline: srtPipelines.get(pipelineId), alreadyStopped: true }));
		return;
	}

	const stopTimeoutMs = numberFromEnv(process.env.MEDIA_PIPELINE_STOP_TIMEOUT_MS, 4_000);
	updatePipelineState(pipelineId, { stopRequestedAt: Date.now() });
	const { stopped, escalated } = await stopProcessGracefully(processHandle, stopTimeoutMs);
	if (escalated) mediaGatewayMetrics.forcedKills += 1;
	srtPipelineProcesses.delete(pipelineId);
	updatePipelineState(pipelineId, {
		status: 'stopped',
		pid: null,
		lastError: stopped ? undefined : 'Failed to stop pipeline process',
		lastExitAt: Date.now()
	});
	trimPipelineHistoryIfNeeded();

	res.writeHead(stopped ? 200 : 500, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({
		ok: stopped,
		escalatedToSigkill: escalated,
		pipeline: srtPipelines.get(pipelineId)
	}));
}
