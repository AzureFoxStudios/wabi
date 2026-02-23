import type { BackendPlugin, PluginContext } from '../../../backend/src/plugins/types';

type BlendImportPreset = 'fast-preview' | 'balanced' | 'high-fidelity';
type BlendIncludeScope = 'visible-only' | 'selected-only' | 'full-scene';
type BlendAxisPreset = 'blender-default' | 'y-up';
type BlendOutputFormat = 'glb';

interface BlendImportRequest {
  sourcePath: string;
  fileName: string;
  preset?: BlendImportPreset;
  applyModifiers?: boolean;
  dracoCompression?: boolean;
  embedTextures?: boolean;
  includeScope?: BlendIncludeScope;
  axisPreset?: BlendAxisPreset;
  scale?: number;
  outputFormat?: BlendOutputFormat;
}

type BlendJobStatus = 'queued' | 'cancelled';

interface BlendJobRecord {
  id: string;
  plugin: 'model-viewer';
  status: BlendJobStatus;
  createdAt: number;
  updatedAt: number;
  sourcePath: string;
  fileName: string;
  settings: {
    preset: BlendImportPreset;
    applyModifiers: boolean;
    dracoCompression: boolean;
    embedTextures: boolean;
    includeScope: BlendIncludeScope;
    axisPreset: BlendAxisPreset;
    scale: number;
    outputFormat: BlendOutputFormat;
  };
}

const STORAGE_KEY = 'blend-jobs';
const MAX_JOBS = 200;

let pluginCtx: PluginContext | null = null;
let jobCache: BlendJobRecord[] = [];

function normalizeRequest(body: unknown): BlendImportRequest | null {
  if (!body || typeof body !== 'object') return null;
  return body as BlendImportRequest;
}

function sanitizeBlendJobInput(input: BlendImportRequest): { ok: true; value: BlendJobRecord['settings'] } | { ok: false; error: string } {
  const preset = input.preset ?? 'balanced';
  const includeScope = input.includeScope ?? 'visible-only';
  const axisPreset = input.axisPreset ?? 'blender-default';
  const outputFormat = input.outputFormat ?? 'glb';
  const scaleRaw = input.scale ?? 1;

  if (!['fast-preview', 'balanced', 'high-fidelity'].includes(preset)) {
    return { ok: false, error: 'Invalid preset' };
  }
  if (!['visible-only', 'selected-only', 'full-scene'].includes(includeScope)) {
    return { ok: false, error: 'Invalid includeScope' };
  }
  if (!['blender-default', 'y-up'].includes(axisPreset)) {
    return { ok: false, error: 'Invalid axisPreset' };
  }
  if (outputFormat !== 'glb') {
    return { ok: false, error: 'Only glb output is currently supported' };
  }
  const scale = Number(scaleRaw);
  if (!Number.isFinite(scale) || scale <= 0) {
    return { ok: false, error: 'Scale must be a positive number' };
  }

  return {
    ok: true,
    value: {
      preset,
      applyModifiers: input.applyModifiers !== false,
      dracoCompression: input.dracoCompression === true,
      embedTextures: input.embedTextures !== false,
      includeScope,
      axisPreset,
      scale,
      outputFormat
    }
  };
}

function trimJobs(jobs: BlendJobRecord[]): BlendJobRecord[] {
  if (jobs.length <= MAX_JOBS) return jobs;
  return jobs.slice(jobs.length - MAX_JOBS);
}

async function persistJobs(): Promise<void> {
  if (!pluginCtx) return;
  await pluginCtx.storage.set(STORAGE_KEY, jobCache);
}

const plugin: BackendPlugin = {
  name: 'model-viewer',

  async onLoad(ctx: PluginContext) {
    pluginCtx = ctx;
    const stored = await ctx.storage.get(STORAGE_KEY);
    jobCache = Array.isArray(stored) ? stored : [];
    ctx.logger.info('Model Viewer backend loaded', { jobs: jobCache.length });
  },

  routes: [
    {
      method: 'get',
      path: '/blend/capabilities',
      handler: async (_req, res) => {
        res.json({
          success: true,
          plugin: 'model-viewer',
          blend: {
            enabled: true,
            acceptedExtensions: ['.blend'],
            outputFormats: ['glb'],
            presets: ['fast-preview', 'balanced', 'high-fidelity'],
            threadModes: ['auto', 'always', 'single'],
            note: 'Jobs are queued metadata records; conversion workers are optional and not bundled.'
          }
        });
      }
    },
    {
      method: 'get',
      path: '/blend/jobs',
      handler: async (req, res) => {
        const limitParam = Number(req.query?.limit ?? 25);
        const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(200, limitParam)) : 25;
        const jobs = [...jobCache].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
        res.json({ success: true, jobs });
      }
    },
    {
      method: 'post',
      path: '/blend/jobs',
      handler: async (req, res) => {
        const body = normalizeRequest(await req.json());
        if (!body) {
          res.status(400).json({ success: false, error: 'Invalid request body' });
          return;
        }
        if (typeof body.sourcePath !== 'string' || body.sourcePath.trim().length === 0) {
          res.status(400).json({ success: false, error: 'sourcePath is required' });
          return;
        }
        if (typeof body.fileName !== 'string' || body.fileName.trim().length === 0) {
          res.status(400).json({ success: false, error: 'fileName is required' });
          return;
        }
        if (!body.fileName.toLowerCase().endsWith('.blend')) {
          res.status(400).json({ success: false, error: 'Only .blend files are supported by this endpoint' });
          return;
        }

        const settings = sanitizeBlendJobInput(body);
        if (!settings.ok) {
          res.status(400).json({ success: false, error: settings.error });
          return;
        }

        const now = Date.now();
        const job: BlendJobRecord = {
          id: `blend-${now}-${Math.random().toString(36).slice(2, 8)}`,
          plugin: 'model-viewer',
          status: 'queued',
          createdAt: now,
          updatedAt: now,
          sourcePath: body.sourcePath.trim(),
          fileName: body.fileName.trim(),
          settings: settings.value
        };

        jobCache = trimJobs([...jobCache, job]);
        await persistJobs();
        pluginCtx?.logger.info('Blend import job queued', {
          jobId: job.id,
          fileName: job.fileName,
          preset: job.settings.preset
        });
        res.status(202).json({ success: true, job });
      }
    },
    {
      method: 'post',
      path: '/blend/job/cancel',
      handler: async (req, res) => {
        const body = await req.json();
        const jobId = typeof body?.jobId === 'string' ? body.jobId.trim() : '';
        if (!jobId) {
          res.status(400).json({ success: false, error: 'jobId is required' });
          return;
        }

        const index = jobCache.findIndex((item) => item.id === jobId);
        if (index === -1) {
          res.status(404).json({ success: false, error: 'Job not found' });
          return;
        }

        const existing = jobCache[index];
        if (existing.status === 'cancelled') {
          res.json({ success: true, job: existing });
          return;
        }

        const updated: BlendJobRecord = {
          ...existing,
          status: 'cancelled',
          updatedAt: Date.now()
        };
        jobCache = [
          ...jobCache.slice(0, index),
          updated,
          ...jobCache.slice(index + 1)
        ];
        await persistJobs();
        pluginCtx?.logger.info('Blend import job cancelled', { jobId: updated.id });
        res.json({ success: true, job: updated });
      }
    }
  ]
};

export default plugin;
