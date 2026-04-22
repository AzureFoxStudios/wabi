import type { IncomingMessage } from "http";
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, statSync } from "fs";
import { writeFile as writeFileAsync } from "fs/promises";
import { basename, join, resolve, sep } from "path";
import { createHmac, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv, createHash } from "crypto";
import { gunzipSync, gzip as gzipCb } from "zlib";
import { promisify } from "util";

import { UPLOADS_DIR } from "../constants.js";

const gzipAsync = promisify(gzipCb);

const WHITEBOARD_UPLOAD_PREFIX = 'wbi-';
const WHITEBOARD_ORPHAN_UPLOAD_GRACE_MS = 24 * 60 * 60 * 1000;
const RESUMABLE_UPLOADS_DIR = join(UPLOADS_DIR, '.resumable');
const ENABLE_LOGGING = process.env.ENABLE_LOGGING === 'true';

const AT_REST_MAGIC = Buffer.from('WABIENC1');
const FILE_ENCRYPTION_SECRET = process.env.FILE_ENCRYPTION_KEY || '';
export const FILE_ENCRYPTION_KEY = FILE_ENCRYPTION_SECRET
  ? createHash('sha256').update(FILE_ENCRYPTION_SECRET).digest()
  : null;
const UPLOAD_TOKEN_SECRET = (process.env.UPLOAD_TOKEN_SECRET || process.env.JWT_SECRET || process.env.SESSION_SECRET || '').trim();
if (!UPLOAD_TOKEN_SECRET) {
  throw new Error('UPLOAD_TOKEN_SECRET (or JWT_SECRET/SESSION_SECRET) must be configured');
}
const UPLOAD_TOKEN_TTL_MS = 15 * 60 * 1000;

export const UPLOAD_COMPRESSION_ENABLED = (process.env.UPLOAD_COMPRESSION_ENABLED || 'false') === 'true';
export const UPLOAD_COMPRESSION_MIN_BYTES = Math.max(1024, Number(process.env.UPLOAD_COMPRESSION_MIN_BYTES || 4096));
export const UPLOAD_COMPRESSION_GZIP_LEVEL = Math.min(9, Math.max(1, Number(process.env.UPLOAD_COMPRESSION_GZIP_LEVEL || 6)));
export const UPLOAD_COMPRESSION_ROLLOUT_PERCENT = Math.max(0, Math.min(100, Number(process.env.UPLOAD_COMPRESSION_ROLLOUT_PERCENT || 100)));
const UPLOAD_COMPRESSION_ROLLOUT_SALT = process.env.UPLOAD_COMPRESSION_ROLLOUT_SALT || 'wabi-upload-rollout';
const UPLOAD_COMP_MAGIC = Buffer.from('WBZ1');
const UPLOAD_COMP_CODEC_GZIP = 1;
const UPLOAD_COMP_HEADER_SIZE = UPLOAD_COMP_MAGIC.length + 1 + 4;
const ALREADY_COMPRESSED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'mp4', 'webm', 'zip', 'pdf', 'gz', 'br', '7z', 'rar']);
const SAFE_RASTER_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

export type VideoCompressionTelemetryRuntime = 'desktop' | 'android' | 'ios' | 'web' | 'unknown';
export type VideoCompressionPresetId = 'mobile_540p' | 'balanced_720p' | 'quality_1080p';
export type VideoCompressionCodec = 'vp9' | 'vp8' | 'h264' | 'hevc' | 'av1' | 'unknown';

export interface UploadVideoCompressionMeta {
  scheme: 'wabi-video-compression-v1';
  runtime: VideoCompressionTelemetryRuntime;
  preset: VideoCompressionPresetId;
  originalSize: number;
  compressedSize: number;
  codec: VideoCompressionCodec;
  mimeType: string;
  durationMs: number;
  estimatedOutputBytes?: number;
}

export interface UploadVideoCompressionVerificationMeta {
  scheme: 'wabi-video-compression-v1';
  runtime: VideoCompressionTelemetryRuntime;
  preset: VideoCompressionPresetId;
  verified: boolean;
  verifiedAt: number;
  originalSize: number;
  uploadedSize: number;
  compressedSizeClaimed: number;
  codecClaimed: VideoCompressionCodec;
  codecDetected: VideoCompressionCodec;
  mimeTypeClaimed: string;
  mimeTypeStored: string;
  ratio: number | null;
  notes?: string[];
}

export interface ResumableUploadMeta {
  uploadId: string;
  ownerKey: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  channelId: string;
  createdAt: number;
  updatedAt: number;
  status: 'uploading' | 'completed';
  fileUrl?: string;
  attachmentStorage?: AttachmentStorageMeta;
  videoCompression?: UploadVideoCompressionMeta;
  videoCompressionVerification?: UploadVideoCompressionVerificationMeta;
}

export interface AttachmentEncryptionMeta {
  scheme: 'dm-e2ee-v1';
  iv: string;
  mimeType?: string;
  originalSize?: number;
}

export interface AttachmentStorageMeta {
  scheme: 'wabi-storage-v1';
  compressed: boolean;
  codec: 'identity' | 'gzip';
  originalSize: number;
  storedSize: number;
  atRestEncrypted: boolean;
}

export interface WhiteboardUploadCleanupBoard {
  boardId: string;
  document: unknown;
}

export interface WhiteboardUploadCleanupStats {
  boardCount: number;
  referencedCount: number;
  scannedFiles: number;
  deletedFiles: number;
  retainedByGrace: number;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function base64UrlEncodeBuffer(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecodeToBuffer(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((input.length + 3) % 4);
  return Buffer.from(padded, 'base64');
}

export function createUploadId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function sanitizeVideoCompressionPreset(value: unknown): VideoCompressionPresetId | null {
  if (value === 'mobile_540p' || value === 'balanced_720p' || value === 'quality_1080p') {
    return value;
  }
  return null;
}

function sanitizeVideoCompressionCodec(value: unknown): VideoCompressionCodec | null {
  if (value === 'vp9' || value === 'vp8' || value === 'h264' || value === 'hevc' || value === 'av1' || value === 'unknown') {
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

function sanitizeTelemetryNumericValue(
  value: unknown,
  min: number,
  max: number
): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (rounded < min || rounded > max) return null;
  return rounded;
}

export function sanitizeUploadVideoCompressionMeta(
  payload: unknown,
  expectedCompressedSize: number,
  maxBytes: number
): UploadVideoCompressionMeta | null {
  if (!payload || typeof payload !== 'object') return null;
  const candidate = payload as Record<string, unknown>;
  if (candidate.scheme !== 'wabi-video-compression-v1') return null;

  const runtime = sanitizeVideoCompressionTelemetryRuntime(candidate.runtime);
  const preset = sanitizeVideoCompressionPreset(candidate.preset);
  const originalSize = sanitizeTelemetryNumericValue(candidate.originalSize, expectedCompressedSize, maxBytes);
  const compressedSize = sanitizeTelemetryNumericValue(candidate.compressedSize, expectedCompressedSize, expectedCompressedSize);
  const codec = sanitizeVideoCompressionCodec(candidate.codec) || 'unknown';
  const durationMs = sanitizeTelemetryNumericValue(candidate.durationMs, 1, 6 * 60 * 60 * 1000);
  const estimatedOutputBytes = sanitizeTelemetryNumericValue(candidate.estimatedOutputBytes, 1, maxBytes);
  const mimeType = typeof candidate.mimeType === 'string'
    ? candidate.mimeType.trim().toLowerCase().slice(0, 120)
    : '';

  if (!runtime || !preset || !originalSize || !compressedSize || !durationMs || !mimeType) {
    return null;
  }

  return {
    scheme: 'wabi-video-compression-v1',
    runtime,
    preset,
    originalSize,
    compressedSize,
    codec,
    mimeType,
    durationMs,
    ...(estimatedOutputBytes ? { estimatedOutputBytes } : {})
  };
}

function detectVideoCodecFromStoredUpload(fileName: string, mimeType: string): VideoCompressionCodec {
  const lowerMime = (mimeType || '').toLowerCase();
  const lowerName = (fileName || '').toLowerCase();
  if (lowerMime.includes('vp9')) return 'vp9';
  if (lowerMime.includes('vp8')) return 'vp8';
  if (lowerMime.includes('av1')) return 'av1';
  if (lowerMime.includes('hevc') || lowerMime.includes('h265')) return 'hevc';
  if (lowerMime.includes('avc') || lowerMime.includes('h264')) return 'h264';
  if (lowerName.endsWith('.webm')) return 'vp9';
  if (lowerName.endsWith('.mov') || lowerName.endsWith('.m4v') || lowerName.endsWith('.mp4')) return 'h264';
  return 'unknown';
}

export function verifyUploadVideoCompressionMeta(
  claimed: UploadVideoCompressionMeta,
  uploadedSize: number,
  storedMimeType: string,
  storedFileName: string
): UploadVideoCompressionVerificationMeta {
  const notes: string[] = [];
  let verified = true;

  if (claimed.compressedSize !== uploadedSize) {
    verified = false;
    notes.push('compressed_size_mismatch');
  }
  if (claimed.originalSize < uploadedSize) {
    verified = false;
    notes.push('original_size_below_uploaded_size');
  }
  const codecDetected = detectVideoCodecFromStoredUpload(storedFileName, storedMimeType);
  if (claimed.codec !== 'unknown' && codecDetected !== 'unknown' && claimed.codec !== codecDetected) {
    verified = false;
    notes.push('codec_mismatch');
  }
  if (claimed.mimeType !== storedMimeType) {
    notes.push('mime_type_changed_after_upload');
  }

  const ratioRaw = claimed.originalSize > 0 ? uploadedSize / claimed.originalSize : null;
  const ratio = ratioRaw === null ? null : Math.round(ratioRaw * 1_000_000) / 1_000_000;
  if (ratio !== null && ratio >= 1) {
    verified = false;
    notes.push('no_size_reduction');
  }

  return {
    scheme: 'wabi-video-compression-v1',
    runtime: claimed.runtime,
    preset: claimed.preset,
    verified,
    verifiedAt: Date.now(),
    originalSize: claimed.originalSize,
    uploadedSize,
    compressedSizeClaimed: claimed.compressedSize,
    codecClaimed: claimed.codec,
    codecDetected,
    mimeTypeClaimed: claimed.mimeType,
    mimeTypeStored: storedMimeType,
    ratio,
    ...(notes.length > 0 ? { notes } : {})
  };
}

function maybeEncryptForAtRest(plain: Buffer): Buffer {
  if (!FILE_ENCRYPTION_KEY) return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', FILE_ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([AT_REST_MAGIC, iv, tag, encrypted]);
}

export function decodePathSegment(rawSegment: string | undefined | null): string | null {
  if (typeof rawSegment !== 'string' || rawSegment.length === 0) return null;
  try {
    return decodeURIComponent(rawSegment);
  } catch {
    return null;
  }
}

export function normalizeUploadFileIdSegment(rawSegment: string | undefined | null): string | null {
  const decoded = decodePathSegment(rawSegment);
  if (!decoded) return null;
  const normalized = decoded.replace(/\\/g, '/');
  if (normalized.includes('/')) return null;
  const safeId = basename(normalized);
  if (!safeId || safeId === '.' || safeId === '..') return null;
  return safeId;
}

function normalizeWhiteboardUploadFileIdFromUrl(boardId: string, fileUrl: string | undefined | null): string | null {
  if (typeof fileUrl !== 'string' || fileUrl.trim().length === 0) return null;

  try {
    const parsed = new URL(fileUrl, 'http://wabi.local');
    const match = parsed.pathname.match(/^\/api\/whiteboard\/boards\/([^/]+)\/files\/([^/]+)$/);
    if (!match) return null;

    const scopedBoardId = decodePathSegment(match[1])?.trim() || '';
    if (!scopedBoardId || scopedBoardId !== boardId) return null;

    const fileId = normalizeUploadFileIdSegment(match[2]);
    if (!fileId || !isWhiteboardUploadFileIdForBoard(boardId, fileId)) return null;
    return fileId;
  } catch {
    return null;
  }
}

function listWhiteboardScopedUploadFiles(): Array<{ fileId: string; filePath: string; mtimeMs: number }> {
  if (!existsSync(UPLOADS_DIR)) return [];

  const scopedUploads: Array<{ fileId: string; filePath: string; mtimeMs: number }> = [];
  for (const fileId of readdirSync(UPLOADS_DIR)) {
    if (!isWhiteboardUploadFileId(fileId)) continue;

    const filePath = resolveUploadPath(fileId);
    if (!filePath || !existsSync(filePath)) continue;

    try {
      const fileStat = statSync(filePath);
      if (!fileStat.isFile()) continue;
      scopedUploads.push({
        fileId,
        filePath,
        mtimeMs: fileStat.mtimeMs
      });
    } catch (error) {
      console.error(`[WhiteboardCleanup] Failed to inspect whiteboard upload ${fileId}:`, error);
    }
  }

  return scopedUploads;
}

function collectWhiteboardUploadFileIdsFromDocument(boardId: string, document: unknown): Set<string> {
  const referencedFileIds = new Set<string>();
  const rawElements =
    isObjectRecord(document) && Array.isArray(document.elements)
      ? document.elements
      : [];

  for (const rawElement of rawElements) {
    if (!isObjectRecord(rawElement)) continue;

    const rawAssetId = typeof rawElement.assetId === 'string' ? rawElement.assetId.trim() : '';
    if (rawAssetId) {
      const assetId = normalizeUploadFileIdSegment(rawAssetId);
      if (assetId && isWhiteboardUploadFileIdForBoard(boardId, assetId)) {
        referencedFileIds.add(assetId);
      }
    }

    const rawSrc = typeof rawElement.src === 'string' ? rawElement.src.trim() : '';
    if (!rawSrc) continue;

    const fileId = normalizeWhiteboardUploadFileIdFromUrl(boardId, rawSrc);
    if (fileId) {
      referencedFileIds.add(fileId);
    }
  }

  return referencedFileIds;
}

function shouldCompressUploadPayload(fileName: string, mimeType: string, payloadSize: number): boolean {
  if (!UPLOAD_COMPRESSION_ENABLED) return false;
  if (!Number.isFinite(payloadSize) || payloadSize < UPLOAD_COMPRESSION_MIN_BYTES) return false;
  const ext = getFileExtension(fileName);
  if (ALREADY_COMPRESSED_EXTENSIONS.has(ext)) return false;
  const mime = (mimeType || '').toLowerCase();
  if (!mime || mime === 'application/octet-stream') return false;
  return (
    mime.startsWith('text/') ||
    mime.includes('application/json') ||
    mime.includes('application/javascript') ||
    mime.includes('application/xml') ||
    mime.includes('image/svg+xml')
  );
}

function sniffRasterImageExtension(payload: Buffer): 'png' | 'jpg' | 'gif' | 'webp' | null {
  if (
    payload.length >= 8 &&
    payload[0] === 0x89 &&
    payload[1] === 0x50 &&
    payload[2] === 0x4e &&
    payload[3] === 0x47 &&
    payload[4] === 0x0d &&
    payload[5] === 0x0a &&
    payload[6] === 0x1a &&
    payload[7] === 0x0a
  ) {
    return 'png';
  }

  if (payload.length >= 3 && payload[0] === 0xff && payload[1] === 0xd8 && payload[2] === 0xff) {
    return 'jpg';
  }

  const gifHeader = payload.subarray(0, 6).toString('ascii');
  if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') {
    return 'gif';
  }

  if (
    payload.length >= 12 &&
    payload.subarray(0, 4).toString('ascii') === 'RIFF' &&
    payload.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }

  return null;
}

function isUploadCompressionInRollout(rolloutKey: string): boolean {
  if (UPLOAD_COMPRESSION_ROLLOUT_PERCENT <= 0) return false;
  if (UPLOAD_COMPRESSION_ROLLOUT_PERCENT >= 100) return true;
  const digest = createHash('sha1').update(`${UPLOAD_COMPRESSION_ROLLOUT_SALT}:${rolloutKey}`).digest();
  const bucket = digest.readUInt32BE(0) % 100;
  return bucket < UPLOAD_COMPRESSION_ROLLOUT_PERCENT;
}

export function ensureUploadDirectories(): void {
  if (!existsSync(UPLOADS_DIR)) {
    mkdirSync(UPLOADS_DIR, { recursive: true });
  }
  if (!existsSync(RESUMABLE_UPLOADS_DIR)) {
    mkdirSync(RESUMABLE_UPLOADS_DIR, { recursive: true });
  }
}

export function signUploadToken(uploadId: string, ownerKey: string): string {
  const payload = {
    uploadId,
    ownerKey,
    exp: Date.now() + UPLOAD_TOKEN_TTL_MS,
    nonce: randomBytes(6).toString('hex')
  };
  const payloadB64 = base64UrlEncodeBuffer(Buffer.from(JSON.stringify(payload)));
  const sig = createHmac('sha256', UPLOAD_TOKEN_SECRET).update(payloadB64).digest();
  return `${payloadB64}.${base64UrlEncodeBuffer(sig)}`;
}

export function verifyUploadToken(token: string, uploadId: string, ownerKey: string): boolean {
  if (!token || token.indexOf('.') === -1) return false;
  const [payloadB64, sigB64] = token.split('.', 2);
  if (!payloadB64 || !sigB64) return false;
  try {
    const expectedSig = createHmac('sha256', UPLOAD_TOKEN_SECRET).update(payloadB64).digest();
    const providedSig = base64UrlDecodeToBuffer(sigB64);
    if (providedSig.length !== expectedSig.length || !timingSafeEqual(providedSig, expectedSig)) {
      return false;
    }
    const payload = JSON.parse(base64UrlDecodeToBuffer(payloadB64).toString('utf8')) as {
      uploadId: string;
      ownerKey: string;
      exp: number;
    };
    if (payload.uploadId !== uploadId) return false;
    if (payload.ownerKey !== ownerKey) return false;
    if (!payload.exp || payload.exp < Date.now()) return false;
    return true;
  } catch {
    return false;
  }
}

export function maybeDecryptFromAtRest(buffer: Buffer): Buffer {
  if (!buffer.slice(0, AT_REST_MAGIC.length).equals(AT_REST_MAGIC)) {
    return buffer;
  }
  if (!FILE_ENCRYPTION_KEY) {
    throw new Error('Encrypted upload payload found but FILE_ENCRYPTION_KEY is not configured');
  }
  const headerEnd = AT_REST_MAGIC.length + 12 + 16;
  if (buffer.length < headerEnd) {
    throw new Error('Invalid encrypted upload payload');
  }
  const iv = buffer.slice(AT_REST_MAGIC.length, AT_REST_MAGIC.length + 12);
  const tag = buffer.slice(AT_REST_MAGIC.length + 12, headerEnd);
  const ciphertext = buffer.slice(headerEnd);
  const decipher = createDecipheriv('aes-256-gcm', FILE_ENCRYPTION_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function isAtRestEncryptedBuffer(buffer: Buffer): boolean {
  return buffer.slice(0, AT_REST_MAGIC.length).equals(AT_REST_MAGIC);
}

export async function writeUploadFileNonBlocking(filePath: string, payload: Buffer): Promise<void> {
  await writeFileAsync(filePath, maybeEncryptForAtRest(payload));
}

export function getFileExtension(fileName: string): string {
  const clean = sanitizeUploadFileName(fileName || '');
  const idx = clean.lastIndexOf('.');
  if (idx < 0 || idx === clean.length - 1) return 'unknown';
  return clean.substring(idx + 1).toLowerCase();
}

export function getMimeTypeFromDataUrl(input: string): string {
  if (!input || !input.startsWith('data:')) return 'application/octet-stream';
  const match = input.match(/^data:([^;,]+)[;,]/);
  return match?.[1] || 'application/octet-stream';
}

export function isSafeRasterImageUpload(fileName: string, payload: Buffer): boolean {
  const ext = fileName.split('.').pop()?.toLowerCase();
  if (!ext || !SAFE_RASTER_IMAGE_EXTENSIONS.has(ext)) return false;

  const detected = sniffRasterImageExtension(payload);
  if (!detected) return false;

  if (ext === 'jpg' || ext === 'jpeg') {
    return detected === 'jpg';
  }

  return detected === ext;
}

export async function maybeCompressUploadPayloadNonBlocking(
  fileName: string,
  mimeType: string,
  payload: Buffer,
  rolloutKey: string
): Promise<{ payload: Buffer; meta: AttachmentStorageMeta }> {
  const identityMeta = (): AttachmentStorageMeta => ({
    scheme: 'wabi-storage-v1',
    compressed: false,
    codec: 'identity',
    originalSize: payload.length,
    storedSize: payload.length,
    atRestEncrypted: Boolean(FILE_ENCRYPTION_KEY)
  });

  if (!shouldCompressUploadPayload(fileName, mimeType, payload.length)) {
    return { payload, meta: identityMeta() };
  }
  if (!isUploadCompressionInRollout(rolloutKey)) {
    return { payload, meta: identityMeta() };
  }
  if (payload.length > 0xffffffff) {
    return { payload, meta: identityMeta() };
  }

  try {
    const compressed = await gzipAsync(payload, { level: UPLOAD_COMPRESSION_GZIP_LEVEL });
    if (compressed.length >= payload.length) {
      return { payload, meta: identityMeta() };
    }

    const header = Buffer.alloc(UPLOAD_COMP_HEADER_SIZE);
    UPLOAD_COMP_MAGIC.copy(header, 0);
    header.writeUInt8(UPLOAD_COMP_CODEC_GZIP, UPLOAD_COMP_MAGIC.length);
    header.writeUInt32BE(payload.length, UPLOAD_COMP_MAGIC.length + 1);
    const encoded = Buffer.concat([header, compressed]);
    return {
      payload: encoded,
      meta: {
        scheme: 'wabi-storage-v1',
        compressed: true,
        codec: 'gzip',
        originalSize: payload.length,
        storedSize: encoded.length,
        atRestEncrypted: Boolean(FILE_ENCRYPTION_KEY)
      }
    };
  } catch (error) {
    console.warn('[UploadCompression] Failed to compress upload payload; storing uncompressed', error);
    return { payload, meta: identityMeta() };
  }
}

export function maybeDecompressUploadPayload(buffer: Buffer): { payload: Buffer; compressed: boolean } {
  if (buffer.length < UPLOAD_COMP_HEADER_SIZE) return { payload: buffer, compressed: false };
  if (!buffer.slice(0, UPLOAD_COMP_MAGIC.length).equals(UPLOAD_COMP_MAGIC)) {
    return { payload: buffer, compressed: false };
  }

  const codec = buffer.readUInt8(UPLOAD_COMP_MAGIC.length);
  const originalSize = buffer.readUInt32BE(UPLOAD_COMP_MAGIC.length + 1);
  const payload = buffer.slice(UPLOAD_COMP_HEADER_SIZE);

  try {
    if (codec === UPLOAD_COMP_CODEC_GZIP) {
      const decompressed = gunzipSync(payload);
      if (decompressed.length !== originalSize) {
        throw new Error(`Size mismatch after gzip decode: expected=${originalSize}, actual=${decompressed.length}`);
      }
      return { payload: decompressed, compressed: true };
    }
  } catch (error) {
    console.warn('[UploadCompression] Failed to decompress upload payload; returning stored bytes', error);
    return { payload: buffer, compressed: false };
  }

  return { payload: buffer, compressed: false };
}

export function sanitizeUploadFileName(fileName: string): string {
  const base = basename(fileName || 'upload.bin');
  return base.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
}

export function createUploadFileId(prefix: string, fileName: string): string {
  const safeName = sanitizeUploadFileName(fileName || 'upload.bin');
  const nonce = randomBytes(6).toString('hex');
  return `${prefix}${Date.now()}-${nonce}-${safeName}`;
}

function getWhiteboardUploadScopeTag(boardId: string): string {
  return createHash('sha256').update(boardId).digest('hex').slice(0, 16);
}

export function createWhiteboardUploadFileId(boardId: string, fileName: string): string {
  const safeName = sanitizeUploadFileName(fileName || 'whiteboard-image.bin');
  const nonce = randomBytes(6).toString('hex');
  return `${WHITEBOARD_UPLOAD_PREFIX}${getWhiteboardUploadScopeTag(boardId)}-${Date.now()}-${nonce}-${safeName}`;
}

function isWhiteboardUploadFileId(fileId: string): boolean {
  return typeof fileId === 'string' && fileId.startsWith(WHITEBOARD_UPLOAD_PREFIX);
}

export function isWhiteboardUploadFileIdForBoard(boardId: string, fileId: string): boolean {
  return fileId.startsWith(`${WHITEBOARD_UPLOAD_PREFIX}${getWhiteboardUploadScopeTag(boardId)}-`);
}

export function createWhiteboardUploadUrl(boardId: string, fileId: string): string {
  return `/api/whiteboard/boards/${encodeURIComponent(boardId)}/files/${encodeURIComponent(fileId)}`;
}

export function cleanupWhiteboardOrphanUploads(
  logLabel: string,
  listBoards: () => WhiteboardUploadCleanupBoard[],
  enableLogging: boolean = ENABLE_LOGGING
): WhiteboardUploadCleanupStats {
  const boards = listBoards();
  const referencedFileIds = new Set<string>();
  for (const board of boards) {
    for (const fileId of collectWhiteboardUploadFileIdsFromDocument(board.boardId, board.document)) {
      referencedFileIds.add(fileId);
    }
  }

  const cutoffMs = Date.now() - WHITEBOARD_ORPHAN_UPLOAD_GRACE_MS;
  let scannedFiles = 0;
  let deletedFiles = 0;
  let retainedByGrace = 0;

  for (const candidate of listWhiteboardScopedUploadFiles()) {
    scannedFiles++;
    if (referencedFileIds.has(candidate.fileId)) continue;
    if (candidate.mtimeMs > cutoffMs) {
      retainedByGrace++;
      continue;
    }

    try {
      unlinkSync(candidate.filePath);
      deletedFiles++;
      if (enableLogging) {
        console.log(`[${logLabel}] Deleted orphan whiteboard upload: ${candidate.fileId}`);
      }
    } catch (error) {
      console.error(`[${logLabel}] Failed to delete orphan whiteboard upload ${candidate.fileId}:`, error);
    }
  }

  return {
    boardCount: boards.length,
    referencedCount: referencedFileIds.size,
    scannedFiles,
    deletedFiles,
    retainedByGrace
  };
}

export function resolveUploadPath(fileId: string): string | null {
  const safeId = basename(fileId || '');
  if (!safeId) return null;
  const uploadsRoot = resolve(UPLOADS_DIR);
  const candidate = resolve(uploadsRoot, safeId);
  if (candidate !== uploadsRoot && !candidate.startsWith(`${uploadsRoot}${sep}`)) {
    return null;
  }
  return candidate;
}

export function normalizeUploadFileIdFromUrl(fileUrl: string | undefined | null): string | null {
  if (typeof fileUrl !== 'string' || !fileUrl.startsWith('/uploads/')) return null;
  return normalizeUploadFileIdSegment(fileUrl.slice('/uploads/'.length));
}

export function normalizeClientUploadUrl(fileUrl: string | undefined | null): string | null {
  const fileId = normalizeUploadFileIdFromUrl(fileUrl);
  if (!fileId) return null;
  return `/uploads/${fileId}`;
}

export function deleteUploadFileByUrl(fileUrl: string | undefined | null, logLabel: string): void {
  const fileId = normalizeUploadFileIdFromUrl(fileUrl);
  if (!fileId) return;
  const filePath = resolveUploadPath(fileId);
  if (!filePath) return;

  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      if (ENABLE_LOGGING) {
        console.log(`[${logLabel}] Deleted upload file: ${fileId}`);
      }
    }
  } catch (error) {
    console.error(`[${logLabel}] Failed to delete upload file ${fileId}:`, error);
  }
}

export function normalizeClientFileAttachment(
  file: {
    fileUrl: string;
    fileName: string;
    fileSize: number;
    attachmentEncryption?: AttachmentEncryptionMeta;
    attachmentStorage?: AttachmentStorageMeta;
  }
): {
  fileUrl: string;
  fileName: string;
  fileSize: number;
  attachmentEncryption?: AttachmentEncryptionMeta;
  attachmentStorage?: AttachmentStorageMeta;
} | null {
  const normalizedUrl = normalizeClientUploadUrl(file.fileUrl);
  if (!normalizedUrl) return null;
  return {
    fileUrl: normalizedUrl,
    fileName: sanitizeUploadFileName(file.fileName || basename(normalizedUrl)),
    fileSize: Number.isFinite(file.fileSize) ? Math.max(0, Math.floor(file.fileSize)) : 0,
    attachmentEncryption: file.attachmentEncryption,
    attachmentStorage: file.attachmentStorage
  };
}

export function getUploadOwnerKey(
  userId: number | null,
  guestSessionId: string | null,
  hasGuestSession: (sessionId: string) => boolean
): string | null {
  if (userId) return `user:${userId}`;
  if (guestSessionId && hasGuestSession(guestSessionId)) return `guest:${guestSessionId}`;
  return null;
}

function getResumableMetaPath(uploadId: string): string {
  return join(RESUMABLE_UPLOADS_DIR, `${uploadId}.json`);
}

function getResumablePartPath(uploadId: string): string {
  return join(RESUMABLE_UPLOADS_DIR, `${uploadId}.part`);
}

export function loadResumableMeta(uploadId: string): ResumableUploadMeta | null {
  const metaPath = getResumableMetaPath(uploadId);
  if (!existsSync(metaPath)) return null;
  try {
    const raw = readFileSync(metaPath, 'utf8');
    return JSON.parse(raw) as ResumableUploadMeta;
  } catch {
    return null;
  }
}

export function saveResumableMeta(meta: ResumableUploadMeta): void {
  const metaPath = getResumableMetaPath(meta.uploadId);
  writeFileSync(metaPath, JSON.stringify(meta));
}

export function getUploadedBytes(uploadId: string): number {
  const partPath = getResumablePartPath(uploadId);
  if (!existsSync(partPath)) return 0;
  try {
    return statSync(partPath).size;
  } catch {
    return 0;
  }
}

export function getUploadTokenFromRequest(req: IncomingMessage, url: URL): string {
  const headerToken = req.headers['x-upload-token'];
  if (typeof headerToken === 'string' && headerToken.trim()) {
    return headerToken.trim();
  }
  const queryToken = url.searchParams.get('uploadToken');
  return queryToken?.trim() || '';
}
