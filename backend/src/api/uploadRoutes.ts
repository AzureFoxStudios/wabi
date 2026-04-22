import type { IncomingMessage, ServerResponse } from 'http';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { open as openFileAsync, readFile as readFileAsync, stat as statAsync, unlink as unlinkAsync } from 'fs/promises';

import { UPLOADS_DIR } from '../constants.js';
import {
  createUploadFileId,
  createUploadId,
  getFileExtension,
  getMimeTypeFromDataUrl,
  getUploadTokenFromRequest,
  getUploadedBytes,
  loadResumableMeta,
  maybeCompressUploadPayloadNonBlocking,
  resolveUploadPath,
  sanitizeUploadFileName,
  sanitizeUploadVideoCompressionMeta,
  saveResumableMeta,
  signUploadToken,
  verifyUploadToken,
  verifyUploadVideoCompressionMeta,
  writeUploadFileNonBlocking
} from '../services/uploadSupport.js';
import {
  isInvalidJsonBodyError,
  isRequestBodyTooLargeError,
  parseJsonObjectBuffer,
  readJsonObjectBody,
  readRequestBuffer
} from '../utils/requestBodies.js';

const GB = 1024 * 1024 * 1024;
const VIDEO_COMPRESSION_TELEMETRY_WINDOW_MS = 60_000;
const VIDEO_COMPRESSION_TELEMETRY_MAX_EVENTS_PER_WINDOW = 180;
const videoCompressionTelemetryBudget = new Map<string, { windowStart: number; count: number }>();

type UploadLimitSource = 'direct-upload' | 'resumable-init' | 'resumable-chunk';
type VideoCompressionTelemetryOutcome = 'success' | 'failure' | 'cancelled' | 'skipped';
type VideoCompressionTelemetryRuntime = 'desktop' | 'android' | 'ios' | 'web' | 'unknown';

interface VideoCompressionTelemetrySample {
  timestamp: number;
  runtime: VideoCompressionTelemetryRuntime;
  preset: string;
  outcome: VideoCompressionTelemetryOutcome;
  inputBytes: number;
  outputBytes: number | null;
  durationMs: number | null;
  failureCode: string | null;
}

interface CompressionUploadSample {
  timestamp: number;
  source: string;
  fileExt: string;
  mimeType: string;
  originalBytes: number;
  storedBytes: number;
  durationMs: number;
  atRestEncrypted: boolean;
}

interface UploadRouteDependencies {
  getAuthenticatedUserId: (req: IncomingMessage) => number | null;
  getGuestSessionId: (req: IncomingMessage) => string | null;
  hasGuestSession: (sessionId: string) => boolean;
  resolveUploadOwnerKey: (userId: number | null, guestSessionId: string | null) => string | null;
  enforceUploadLimit: (
    res: ServerResponse,
    userId: number | null,
    guestSessionId: string | null,
    fileSize: number,
    fileName: string,
    source: UploadLimitSource
  ) => boolean;
  multipartUploadMaxBytes: number;
  isVideoCompressionClientMetricsEnabled: boolean;
  isAtRestEncryptionEnabled: boolean;
  recordClientVideoCompressionSample: (sample: VideoCompressionTelemetrySample) => void;
  recordCompressionUploadSample: (sample: CompressionUploadSample) => void;
}

interface ParsedMultipartPart {
  headers: string;
  bodyBinary: string;
}

function writeJson(res: ServerResponse, status: number, payload: Record<string, unknown>): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function ensureUploadsDir(): void {
  if (!existsSync(UPLOADS_DIR)) {
    mkdirSync(UPLOADS_DIR, { recursive: true });
  }
}

function parseMultipartBoundary(contentType: string | string[] | undefined): string | null {
  return typeof contentType === 'string' ? contentType.split('boundary=')[1] || null : null;
}

function parseLegacyMultipartParts(buffer: Buffer, boundary: string): ParsedMultipartPart[] {
  return buffer
    .toString('binary')
    .split(`--${boundary}`)
    .filter((part) => part.includes('Content-Disposition'))
    .map((part) => {
      const dataStart = part.indexOf('\r\n\r\n');
      const dataEnd = part.lastIndexOf('\r\n');
      return {
        headers: dataStart >= 0 ? part.substring(0, dataStart) : part,
        bodyBinary: dataStart >= 0 && dataEnd >= dataStart + 4
          ? part.substring(dataStart + 4, dataEnd)
          : ''
      };
    });
}

function getMultipartTextField(parts: ParsedMultipartPart[], fieldName: string): string {
  const target = `name="${fieldName}"`;
  const part = parts.find((candidate) => candidate.headers.includes(target));
  return part ? part.bodyBinary.trim() : '';
}

function getMultipartFileField(
  parts: ParsedMultipartPart[],
  fieldName: string
): { fileName: string; data: Buffer } | null {
  const target = `name="${fieldName}"`;
  for (const part of parts) {
    if (!part.headers.includes(target)) continue;
    const fileNameMatch = part.headers.match(/filename="([^"]+)"/);
    if (!fileNameMatch) continue;
    return {
      fileName: fileNameMatch[1],
      data: Buffer.from(part.bodyBinary, 'binary')
    };
  }
  return null;
}

function getFirstMultipartFile(parts: ParsedMultipartPart[]): { fileName: string; data: Buffer } | null {
  for (const part of parts) {
    const fileNameMatch = part.headers.match(/filename="([^"]+)"/);
    if (!fileNameMatch) continue;
    return {
      fileName: fileNameMatch[1],
      data: Buffer.from(part.bodyBinary, 'binary')
    };
  }
  return null;
}

function sanitizeVideoCompressionTelemetryOutcome(
  value: unknown
): VideoCompressionTelemetryOutcome | null {
  if (value === 'success' || value === 'failure' || value === 'cancelled' || value === 'skipped') {
    return value;
  }
  return null;
}

function sanitizeVideoCompressionTelemetryRuntime(
  value: unknown
): VideoCompressionTelemetryRuntime | null {
  if (value === 'desktop' || value === 'android' || value === 'ios' || value === 'web' || value === 'unknown') {
    return value;
  }
  return null;
}

function sanitizeTelemetryNumericValue(value: unknown, min: number, max: number): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const rounded = Math.round(parsed);
  if (rounded < min || rounded > max) return null;
  return rounded;
}

function sanitizeTelemetryString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, '_')
    .slice(0, maxLength);
  return cleaned.length > 0 ? cleaned : null;
}

function consumeVideoCompressionTelemetryQuota(ownerKey: string): boolean {
  const now = Date.now();
  const current = videoCompressionTelemetryBudget.get(ownerKey);
  if (!current || now - current.windowStart >= VIDEO_COMPRESSION_TELEMETRY_WINDOW_MS) {
    videoCompressionTelemetryBudget.set(ownerKey, { windowStart: now, count: 1 });
    return true;
  }
  if (current.count >= VIDEO_COMPRESSION_TELEMETRY_MAX_EVENTS_PER_WINDOW) {
    return false;
  }
  current.count += 1;
  videoCompressionTelemetryBudget.set(ownerKey, current);
  return true;
}

function validateImageUpload(
  fileName: string,
  payload: Buffer,
  maxBytes: number
): string | null {
  const ext = fileName.split('.').pop()?.toLowerCase();
  if (!ext || !['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
    return 'Invalid file type. Only PNG, JPG, JPEG, GIF, WEBP are allowed.';
  }
  if (payload.length > maxBytes) {
    return `File too large. Maximum size is ${Math.round(maxBytes / (1024 * 1024))}MB.`;
  }
  return null;
}

function writePlainUploadFile(fileId: string, payload: Buffer): string | null {
  const filePath = resolveUploadPath(fileId);
  if (!filePath) return null;
  ensureUploadsDir();
  writeFileSync(filePath, payload);
  return filePath;
}

export async function handleUploadRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: UploadRouteDependencies
): Promise<boolean> {
  if (url.pathname === '/api/upload-profile-picture' && req.method === 'POST') {
    const userId = deps.getAuthenticatedUserId(req);
    if (!userId) {
      writeJson(res, 401, { success: false, error: 'Unauthorized - authentication required' });
      return true;
    }

    try {
      const buffer = await readRequestBuffer(req, deps.multipartUploadMaxBytes);
      const boundary = parseMultipartBoundary(req.headers['content-type']);
      if (!boundary) {
        writeJson(res, 400, { success: false, error: 'Invalid content type' });
        return true;
      }

      const parts = parseLegacyMultipartParts(buffer, boundary);
      const uploaded = getMultipartFileField(parts, 'profilePicture');
      if (!uploaded) {
        writeJson(res, 400, { success: false, error: 'No profile picture file found in request' });
        return true;
      }

      const validationError = validateImageUpload(uploaded.fileName, uploaded.data, 5 * 1024 * 1024);
      if (validationError) {
        writeJson(res, 400, { success: false, error: validationError });
        return true;
      }

      const fileId = createUploadFileId('pfp-', uploaded.fileName);
      if (!writePlainUploadFile(fileId, uploaded.data)) {
        writeJson(res, 500, { success: false, error: 'Failed to resolve upload path' });
        return true;
      }

      writeJson(res, 200, {
        success: true,
        profilePictureUrl: `/uploads/${fileId}`
      });
    } catch (error) {
      if (isRequestBodyTooLargeError(error)) {
        writeJson(res, 413, { success: false, error: 'Upload too large' });
        return true;
      }
      console.error('Profile picture upload error:', error);
      writeJson(res, 500, { success: false, error: 'Internal server error during upload' });
    }
    return true;
  }

  if (url.pathname === '/api/upload-group-avatar' && req.method === 'POST') {
    const userId = deps.getAuthenticatedUserId(req);
    if (!userId) {
      writeJson(res, 401, { success: false, error: 'Unauthorized - authentication required' });
      return true;
    }

    try {
      const buffer = await readRequestBuffer(req, deps.multipartUploadMaxBytes);
      const boundary = parseMultipartBoundary(req.headers['content-type']);
      if (!boundary) {
        writeJson(res, 400, { success: false, error: 'Invalid content type' });
        return true;
      }

      const parts = parseLegacyMultipartParts(buffer, boundary);
      const channelId = getMultipartTextField(parts, 'channelId');
      if (!channelId) {
        writeJson(res, 400, { success: false, error: 'channelId is required' });
        return true;
      }

      const uploaded = getMultipartFileField(parts, 'avatar');
      if (!uploaded) {
        writeJson(res, 400, { success: false, error: 'No avatar file found in request' });
        return true;
      }

      const validationError = validateImageUpload(uploaded.fileName, uploaded.data, 5 * 1024 * 1024);
      if (validationError) {
        writeJson(res, 400, { success: false, error: validationError });
        return true;
      }

      const fileId = createUploadFileId('group-avatar-', uploaded.fileName);
      if (!writePlainUploadFile(fileId, uploaded.data)) {
        writeJson(res, 500, { success: false, error: 'Failed to resolve upload path' });
        return true;
      }

      writeJson(res, 200, {
        success: true,
        avatarUrl: `/uploads/${fileId}`
      });
    } catch (error) {
      if (isRequestBodyTooLargeError(error)) {
        writeJson(res, 413, { success: false, error: 'Upload too large' });
        return true;
      }
      console.error('Group avatar upload error:', error);
      writeJson(res, 500, { success: false, error: 'Internal server error during upload' });
    }
    return true;
  }

  if (url.pathname === '/api/upload-background-image' && req.method === 'POST') {
    const userId = deps.getAuthenticatedUserId(req);
    if (!userId) {
      writeJson(res, 401, { success: false, error: 'Unauthorized - authentication required' });
      return true;
    }

    try {
      const buffer = await readRequestBuffer(req, deps.multipartUploadMaxBytes);
      const boundary = parseMultipartBoundary(req.headers['content-type']);
      if (!boundary) {
        writeJson(res, 400, { success: false, error: 'Invalid content type' });
        return true;
      }

      const parts = parseLegacyMultipartParts(buffer, boundary);
      const uploaded = getMultipartFileField(parts, 'backgroundImage');
      if (!uploaded) {
        writeJson(res, 400, { success: false, error: 'No background image file found in request' });
        return true;
      }

      const validationError = validateImageUpload(uploaded.fileName, uploaded.data, 10 * 1024 * 1024);
      if (validationError) {
        writeJson(res, 400, { success: false, error: validationError });
        return true;
      }

      const fileId = createUploadFileId('bg-', uploaded.fileName);
      if (!writePlainUploadFile(fileId, uploaded.data)) {
        writeJson(res, 500, { success: false, error: 'Failed to resolve upload path' });
        return true;
      }

      writeJson(res, 200, {
        success: true,
        backgroundImageUrl: `/uploads/${fileId}`
      });
    } catch (error) {
      if (isRequestBodyTooLargeError(error)) {
        writeJson(res, 413, { success: false, error: 'Upload too large' });
        return true;
      }
      console.error('Background image upload error:', error);
      writeJson(res, 500, { success: false, error: 'Internal server error during upload' });
    }
    return true;
  }

  if (url.pathname === '/api/telemetry/video-compression' && req.method === 'POST') {
    if (!deps.isVideoCompressionClientMetricsEnabled) {
      res.writeHead(204);
      res.end();
      return true;
    }

    const userId = deps.getAuthenticatedUserId(req);
    const guestSessionId = deps.getGuestSessionId(req);
    const ownerKey = deps.resolveUploadOwnerKey(userId, guestSessionId);
    if (!ownerKey) {
      writeJson(res, 401, { success: false, error: 'Unauthorized - authentication required' });
      return true;
    }

    if (!consumeVideoCompressionTelemetryQuota(ownerKey)) {
      writeJson(res, 429, { success: false, error: 'Telemetry rate limit exceeded' });
      return true;
    }

    try {
      const payload = await readJsonObjectBody(req) as {
        outcome?: unknown;
        runtime?: unknown;
        preset?: unknown;
        inputBytes?: unknown;
        outputBytes?: unknown;
        durationMs?: unknown;
        failureCode?: unknown;
      };

      const outcome = sanitizeVideoCompressionTelemetryOutcome(payload.outcome);
      const runtime = sanitizeVideoCompressionTelemetryRuntime(payload.runtime);
      const preset = sanitizeTelemetryString(payload.preset, 48);
      const inputBytes = sanitizeTelemetryNumericValue(payload.inputBytes, 1, 5 * GB);
      const outputBytes = sanitizeTelemetryNumericValue(payload.outputBytes, 0, 5 * GB);
      const durationMs = sanitizeTelemetryNumericValue(payload.durationMs, 0, 30 * 60 * 1000);
      const failureCode = sanitizeTelemetryString(payload.failureCode, 64);

      if (!outcome || !runtime || !preset || inputBytes === null) {
        writeJson(res, 400, { success: false, error: 'Invalid telemetry payload' });
        return true;
      }
      if (outcome === 'success' && outputBytes === null) {
        writeJson(res, 400, { success: false, error: 'Successful telemetry must include outputBytes' });
        return true;
      }

      deps.recordClientVideoCompressionSample({
        timestamp: Date.now(),
        runtime,
        preset,
        outcome,
        inputBytes,
        outputBytes,
        durationMs,
        failureCode
      });

      writeJson(res, 202, { success: true });
    } catch (error) {
      if (isRequestBodyTooLargeError(error)) {
        writeJson(res, 413, { success: false, error: 'Telemetry payload too large' });
        return true;
      }
      writeJson(res, 400, { success: false, error: 'Invalid telemetry payload' });
    }
    return true;
  }

  if (url.pathname === '/api/upload/resumable/init' && req.method === 'POST') {
    const userId = deps.getAuthenticatedUserId(req);
    const guestSessionId = deps.getGuestSessionId(req);
    const ownerKey = deps.resolveUploadOwnerKey(userId, guestSessionId);
    if (!ownerKey) {
      writeJson(res, 401, { success: false, error: 'Unauthorized - authentication required' });
      return true;
    }

    try {
      const payload = await readJsonObjectBody(req) as {
        uploadId?: unknown;
        fileName?: unknown;
        fileSize?: unknown;
        mimeType?: unknown;
        channelId?: unknown;
        videoCompression?: unknown;
      };

      const fileName = sanitizeUploadFileName(typeof payload.fileName === 'string' ? payload.fileName : '');
      const fileSize =
        typeof payload.fileSize === 'number' || typeof payload.fileSize === 'string'
          ? Number(payload.fileSize)
          : 0;
      const mimeType =
        typeof payload.mimeType === 'string' ? payload.mimeType.slice(0, 100) : 'application/octet-stream';
      const channelId = typeof payload.channelId === 'string' ? payload.channelId.slice(0, 100) : '';
      const videoCompression = sanitizeUploadVideoCompressionMeta(payload.videoCompression, fileSize, 10 * GB);

      if (!fileName || !fileSize || fileSize <= 0 || !Number.isFinite(fileSize)) {
        writeJson(res, 400, { success: false, error: 'Invalid file metadata' });
        return true;
      }
      if (!deps.enforceUploadLimit(res, userId, guestSessionId, fileSize, fileName, 'resumable-init')) {
        return true;
      }

      let uploadId = typeof payload.uploadId === 'string' ? payload.uploadId.trim() : '';
      let meta = null;

      if (uploadId) {
        meta = loadResumableMeta(uploadId);
        if (!meta || meta.ownerKey !== ownerKey || meta.fileSize !== fileSize || meta.fileName !== fileName) {
          uploadId = '';
          meta = null;
        }
      }

      if (!uploadId) {
        uploadId = createUploadId();
        meta = {
          uploadId,
          ownerKey,
          fileName,
          fileSize,
          mimeType,
          channelId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          status: 'uploading',
          ...(videoCompression ? { videoCompression } : {})
        };
        saveResumableMeta(meta);
      }

      const uploadedBytes = getUploadedBytes(uploadId);
      if (meta && videoCompression && uploadedBytes === 0) {
        const existing = meta.videoCompression;
        const changed =
          !existing ||
          existing.originalSize !== videoCompression.originalSize ||
          existing.compressedSize !== videoCompression.compressedSize ||
          existing.preset !== videoCompression.preset ||
          existing.runtime !== videoCompression.runtime ||
          existing.codec !== videoCompression.codec ||
          existing.mimeType !== videoCompression.mimeType;
        if (changed) {
          meta.videoCompression = videoCompression;
          meta.videoCompressionVerification = undefined;
          meta.updatedAt = Date.now();
          saveResumableMeta(meta);
        }
      }
      const completed = !!meta?.fileUrl || (meta?.status === 'completed' && typeof meta.fileUrl === 'string');

      writeJson(res, 200, {
        success: true,
        uploadId,
        uploadedBytes,
        completed,
        fileUrl: meta?.fileUrl || null,
        videoCompression: meta?.videoCompressionVerification || null,
        uploadToken: signUploadToken(uploadId, ownerKey)
      });
    } catch (error) {
      if (isRequestBodyTooLargeError(error)) {
        writeJson(res, 413, { success: false, error: 'Upload metadata exceeds server request limit' });
        return true;
      }
      if (isInvalidJsonBodyError(error)) {
        writeJson(res, 400, { success: false, error: 'Invalid upload metadata payload' });
        return true;
      }
      console.error('Resumable upload init error:', error);
      writeJson(res, 500, { success: false, error: 'Failed to initialize resumable upload' });
    }
    return true;
  }

  if (url.pathname === '/api/upload/resumable/status' && req.method === 'GET') {
    const userId = deps.getAuthenticatedUserId(req);
    const guestSessionId = deps.getGuestSessionId(req);
    const ownerKey = deps.resolveUploadOwnerKey(userId, guestSessionId);
    if (!ownerKey) {
      writeJson(res, 401, { success: false, error: 'Unauthorized - authentication required' });
      return true;
    }

    const uploadId = (url.searchParams.get('uploadId') || '').trim();
    if (!uploadId) {
      writeJson(res, 400, { success: false, error: 'uploadId is required' });
      return true;
    }

    const meta = loadResumableMeta(uploadId);
    if (!meta || meta.ownerKey !== ownerKey) {
      writeJson(res, 404, { success: false, error: 'Upload session not found' });
      return true;
    }

    const uploadToken = getUploadTokenFromRequest(req, url);
    if (!verifyUploadToken(uploadToken, uploadId, ownerKey)) {
      writeJson(res, 403, { success: false, error: 'Invalid or expired upload token' });
      return true;
    }

    const uploadedBytes = getUploadedBytes(uploadId);
    writeJson(res, 200, {
      success: true,
      uploadId,
      uploadedBytes,
      fileSize: meta.fileSize,
      completed: meta.status === 'completed',
      fileUrl: meta.fileUrl || null,
      videoCompression: meta.videoCompressionVerification || null,
      uploadToken: signUploadToken(uploadId, ownerKey)
    });
    return true;
  }

  if (url.pathname === '/api/upload/resumable/chunk' && req.method === 'PUT') {
    const userId = deps.getAuthenticatedUserId(req);
    const guestSessionId = deps.getGuestSessionId(req);
    const ownerKey = deps.resolveUploadOwnerKey(userId, guestSessionId);
    if (!ownerKey) {
      writeJson(res, 401, { success: false, error: 'Unauthorized - authentication required' });
      return true;
    }

    const uploadId = (url.searchParams.get('uploadId') || '').trim();
    const offset = Number(url.searchParams.get('offset') || '0');
    if (!uploadId || !Number.isFinite(offset) || offset < 0) {
      writeJson(res, 400, { success: false, error: 'Invalid uploadId or offset' });
      return true;
    }

    const meta = loadResumableMeta(uploadId);
    if (!meta || meta.ownerKey !== ownerKey) {
      writeJson(res, 404, { success: false, error: 'Upload session not found' });
      return true;
    }

    const uploadToken = getUploadTokenFromRequest(req, url);
    if (!verifyUploadToken(uploadToken, uploadId, ownerKey)) {
      writeJson(res, 403, { success: false, error: 'Invalid or expired upload token' });
      return true;
    }
    if (meta.status === 'completed') {
      writeJson(res, 409, { success: false, error: 'Upload already completed', fileUrl: meta.fileUrl || null });
      return true;
    }
    if (!deps.enforceUploadLimit(res, userId, guestSessionId, meta.fileSize, meta.fileName, 'resumable-chunk')) {
      return true;
    }

    try {
      const chunk = await readRequestBuffer(req, 64 * 1024 * 1024);
      if (!chunk.length) {
        writeJson(res, 400, { success: false, error: 'Empty chunk' });
        return true;
      }

      const currentSize = getUploadedBytes(uploadId);
      if (offset > currentSize) {
        writeJson(res, 409, {
          success: false,
          error: 'Offset mismatch',
          expectedOffset: currentSize,
          uploadToken: signUploadToken(uploadId, ownerKey)
        });
        return true;
      }

      if (offset < currentSize) {
        const alreadyCovered = offset + chunk.length <= currentSize;
        if (alreadyCovered) {
          writeJson(res, 200, {
            success: true,
            uploadedBytes: currentSize,
            uploadToken: signUploadToken(uploadId, ownerKey)
          });
          return true;
        }
        writeJson(res, 409, {
          success: false,
          error: 'Overlapping chunk',
          expectedOffset: currentSize,
          uploadToken: signUploadToken(uploadId, ownerKey)
        });
        return true;
      }

      if (currentSize + chunk.length > meta.fileSize) {
        writeJson(res, 400, { success: false, error: 'Chunk exceeds declared file size' });
        return true;
      }

      const partPath = `${UPLOADS_DIR}/.resumable/${uploadId}.part`;
      const fh = await openFileAsync(partPath, 'a+');
      try {
        await fh.write(chunk, 0, chunk.length, offset);
      } finally {
        await fh.close();
      }

      meta.updatedAt = Date.now();
      saveResumableMeta(meta);

      writeJson(res, 200, {
        success: true,
        uploadedBytes: currentSize + chunk.length,
        uploadToken: signUploadToken(uploadId, ownerKey)
      });
    } catch (error) {
      console.error('Resumable upload chunk error:', error);
      const message = error instanceof Error ? error.message : '';
      if (message.startsWith('request_body_too_large')) {
        writeJson(res, 413, { success: false, error: 'Chunk exceeds server request limit' });
        return true;
      }
      writeJson(res, 500, { success: false, error: 'Failed to upload chunk' });
    }
    return true;
  }

  if (url.pathname === '/api/upload/resumable/complete' && req.method === 'POST') {
    const userId = deps.getAuthenticatedUserId(req);
    const guestSessionId = deps.getGuestSessionId(req);
    const ownerKey = deps.resolveUploadOwnerKey(userId, guestSessionId);
    const uploadStartedAt = Date.now();
    if (!ownerKey) {
      writeJson(res, 401, { success: false, error: 'Unauthorized - authentication required' });
      return true;
    }

    try {
      const payload = await readJsonObjectBody(req) as {
        uploadId?: unknown;
        uploadToken?: unknown;
      };
      const uploadId = typeof payload.uploadId === 'string' ? payload.uploadId.trim() : '';
      if (!uploadId) {
        writeJson(res, 400, { success: false, error: 'uploadId is required' });
        return true;
      }

      const meta = loadResumableMeta(uploadId);
      if (!meta || meta.ownerKey !== ownerKey) {
        writeJson(res, 404, { success: false, error: 'Upload session not found' });
        return true;
      }
      const uploadToken = typeof payload.uploadToken === 'string' ? payload.uploadToken.trim() : '';
      if (!verifyUploadToken(uploadToken, uploadId, ownerKey)) {
        writeJson(res, 403, { success: false, error: 'Invalid or expired upload token' });
        return true;
      }

      if (meta.status === 'completed' && meta.fileUrl) {
        writeJson(res, 200, {
          success: true,
          fileUrl: meta.fileUrl,
          fileName: meta.fileName,
          fileSize: meta.fileSize,
          attachmentStorage: meta.attachmentStorage,
          videoCompression: meta.videoCompressionVerification || null
        });
        return true;
      }

      const uploadedBytes = getUploadedBytes(uploadId);
      if (uploadedBytes !== meta.fileSize) {
        writeJson(res, 409, {
          success: false,
          error: 'Upload incomplete',
          uploadedBytes,
          expectedBytes: meta.fileSize
        });
        return true;
      }

      const fileId = createUploadFileId('upload-', meta.fileName);
      const filePath = resolveUploadPath(fileId);
      if (!filePath) {
        writeJson(res, 500, { success: false, error: 'Failed to resolve upload path' });
        return true;
      }

      const partPath = `${UPLOADS_DIR}/.resumable/${uploadId}.part`;
      const finalPlain = await readFileAsync(partPath);
      const storageResult = await maybeCompressUploadPayloadNonBlocking(
        meta.fileName,
        meta.mimeType || 'application/octet-stream',
        finalPlain,
        `${ownerKey}:${meta.fileName}:${meta.fileSize}`
      );
      await writeUploadFileNonBlocking(filePath, storageResult.payload);
      const storedStat = await statAsync(filePath);
      const storedBytes = storedStat.size;
      deps.recordCompressionUploadSample({
        timestamp: Date.now(),
        source: 'resumable-complete',
        fileExt: getFileExtension(meta.fileName),
        mimeType: meta.mimeType || 'application/octet-stream',
        originalBytes: storageResult.meta.originalSize,
        storedBytes,
        durationMs: Date.now() - uploadStartedAt,
        atRestEncrypted: deps.isAtRestEncryptionEnabled
      });
      await unlinkAsync(partPath);

      meta.status = 'completed';
      meta.fileUrl = `/uploads/${fileId}`;
      meta.attachmentStorage = { ...storageResult.meta, storedSize: storedBytes };
      if (meta.videoCompression) {
        meta.videoCompressionVerification = verifyUploadVideoCompressionMeta(
          meta.videoCompression,
          meta.fileSize,
          meta.mimeType || 'application/octet-stream',
          meta.fileName
        );
      } else {
        meta.videoCompressionVerification = undefined;
      }
      meta.updatedAt = Date.now();
      saveResumableMeta(meta);

      writeJson(res, 200, {
        success: true,
        fileUrl: meta.fileUrl,
        fileName: meta.fileName,
        fileSize: meta.fileSize,
        attachmentStorage: meta.attachmentStorage,
        videoCompression: meta.videoCompressionVerification || null
      });
    } catch (error) {
      if (isRequestBodyTooLargeError(error)) {
        writeJson(res, 413, { success: false, error: 'Upload completion payload too large' });
        return true;
      }
      if (isInvalidJsonBodyError(error)) {
        writeJson(res, 400, { success: false, error: 'Invalid upload completion payload' });
        return true;
      }
      console.error('Resumable upload complete error:', error);
      writeJson(res, 500, { success: false, error: 'Failed to finalize upload' });
    }
    return true;
  }

  if (url.pathname === '/api/upload' && req.method === 'POST') {
    const userId = deps.getAuthenticatedUserId(req);
    const guestSessionId = deps.getGuestSessionId(req);
    const isGuestSessionValid = !!guestSessionId && deps.hasGuestSession(guestSessionId);
    const ownerKey = deps.resolveUploadOwnerKey(userId, guestSessionId) || `anon:${Date.now()}`;
    const uploadStartedAt = Date.now();

    if (!userId && !isGuestSessionValid) {
      writeJson(res, 401, { success: false, error: 'Unauthorized - authentication required' });
      return true;
    }

    try {
      const buffer = await readRequestBuffer(req, deps.multipartUploadMaxBytes);
      const boundary = parseMultipartBoundary(req.headers['content-type']);

      if (!boundary) {
        const data = parseJsonObjectBuffer(buffer);
        const fileName = typeof data.fileName === 'string' ? data.fileName : 'upload.bin';
        const fileData = typeof data.fileData === 'string' ? data.fileData : '';
        const safeFileName = sanitizeUploadFileName(fileName);
        const fileBuffer = Buffer.from(fileData.split(',')[1] || '', 'base64');

        if (!deps.enforceUploadLimit(res, userId, guestSessionId, fileBuffer.length, safeFileName, 'direct-upload')) {
          return true;
        }

        const fileId = createUploadFileId('upload-', safeFileName);
        const filePath = resolveUploadPath(fileId);
        if (!filePath) {
          writeJson(res, 500, { success: false, error: 'Failed to resolve upload path' });
          return true;
        }

        ensureUploadsDir();
        const mimeType = getMimeTypeFromDataUrl(fileData);
        const storageResult = await maybeCompressUploadPayloadNonBlocking(
          safeFileName,
          mimeType,
          fileBuffer,
          `${ownerKey}:${safeFileName}:${fileBuffer.length}`
        );
        await writeUploadFileNonBlocking(filePath, storageResult.payload);
        const storedBytes = (await statAsync(filePath)).size;
        deps.recordCompressionUploadSample({
          timestamp: Date.now(),
          source: 'direct-upload-json',
          fileExt: getFileExtension(safeFileName),
          mimeType,
          originalBytes: storageResult.meta.originalSize,
          storedBytes,
          durationMs: Date.now() - uploadStartedAt,
          atRestEncrypted: deps.isAtRestEncryptionEnabled
        });

        writeJson(res, 200, {
          success: true,
          fileUrl: `/uploads/${fileId}`,
          fileName: safeFileName,
          fileSize: fileBuffer.length,
          attachmentStorage: { ...storageResult.meta, storedSize: storedBytes }
        });
        return true;
      }

      const parts = parseLegacyMultipartParts(buffer, boundary);
      const uploaded = getFirstMultipartFile(parts);
      if (!uploaded) {
        writeJson(res, 400, { success: false, error: 'No file uploaded' });
        return true;
      }

      const safeFileName = sanitizeUploadFileName(uploaded.fileName || 'upload.bin');
      if (!deps.enforceUploadLimit(res, userId, guestSessionId, uploaded.data.length, safeFileName, 'direct-upload')) {
        return true;
      }

      const fileId = createUploadFileId('upload-', safeFileName);
      const filePath = resolveUploadPath(fileId);
      if (!filePath) {
        writeJson(res, 500, { success: false, error: 'Failed to resolve upload path' });
        return true;
      }

      ensureUploadsDir();
      const storageResult = await maybeCompressUploadPayloadNonBlocking(
        safeFileName,
        'application/octet-stream',
        uploaded.data,
        `${ownerKey}:${safeFileName}:${uploaded.data.length}`
      );
      await writeUploadFileNonBlocking(filePath, storageResult.payload);
      const storedBytes = (await statAsync(filePath)).size;
      deps.recordCompressionUploadSample({
        timestamp: Date.now(),
        source: 'direct-upload-multipart',
        fileExt: getFileExtension(safeFileName),
        mimeType: 'application/octet-stream',
        originalBytes: storageResult.meta.originalSize,
        storedBytes,
        durationMs: Date.now() - uploadStartedAt,
        atRestEncrypted: deps.isAtRestEncryptionEnabled
      });

      writeJson(res, 200, {
        success: true,
        fileUrl: `/uploads/${fileId}`,
        fileName: safeFileName,
        fileSize: uploaded.data.length,
        attachmentStorage: { ...storageResult.meta, storedSize: storedBytes }
      });
    } catch (error) {
      if (isRequestBodyTooLargeError(error)) {
        writeJson(res, 413, { success: false, error: 'Upload too large' });
        return true;
      }
      if (error instanceof Error && error.message === 'invalid_json_object') {
        writeJson(res, 400, { success: false, error: 'Invalid upload payload' });
        return true;
      }
      console.error('Upload error:', error);
      writeJson(res, 500, { success: false, error: 'Upload failed' });
    }
    return true;
  }

  return false;
}
