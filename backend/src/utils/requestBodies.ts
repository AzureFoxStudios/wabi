import type { IncomingMessage } from "http";

const DEFAULT_MAX_REQUEST_BODY_BYTES = Math.max(
  64 * 1024,
  Math.min(256 * 1024 * 1024, Number(process.env.MAX_REQUEST_BODY_BYTES || 16 * 1024 * 1024))
);

export type RequestBodyErrorCode = 'REQUEST_BODY_TOO_LARGE' | 'INVALID_JSON_BODY';
export type RequestBodyError = Error & { code?: RequestBodyErrorCode };

function createRequestBodyTooLargeError(maxBytes: number): RequestBodyError {
  const error = new Error(`request_body_too_large:${maxBytes}`) as RequestBodyError;
  error.code = 'REQUEST_BODY_TOO_LARGE';
  return error;
}

function createInvalidJsonBodyError(): RequestBodyError {
  const error = new Error('invalid_json_body') as RequestBodyError;
  error.code = 'INVALID_JSON_BODY';
  return error;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isRequestBodyTooLargeError(error: unknown): boolean {
  return error instanceof Error && (error as RequestBodyError).code === 'REQUEST_BODY_TOO_LARGE';
}

export function isInvalidJsonBodyError(error: unknown): boolean {
  return error instanceof Error && (error as RequestBodyError).code === 'INVALID_JSON_BODY';
}

export function parseBooleanRequestValue(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return null;
}

export function readRequestBuffer(
  req: IncomingMessage,
  maxBytes: number = DEFAULT_MAX_REQUEST_BODY_BYTES
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;

    req.on('data', (chunk: Buffer) => {
      if (done) return;
      total += chunk.length;
      if (total > maxBytes) {
        done = true;
        reject(createRequestBodyTooLargeError(maxBytes));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });

    req.on('error', (error: Error) => {
      if (done) return;
      done = true;
      reject(error);
    });
  });
}

export async function readJsonObjectBody(
  req: IncomingMessage,
  maxBytes: number = DEFAULT_MAX_REQUEST_BODY_BYTES
): Promise<Record<string, unknown>> {
  const buffer = await readRequestBuffer(req, maxBytes);
  return parseJsonObjectBuffer(buffer);
}

export function parseJsonObjectBuffer(buffer: Buffer): Record<string, unknown> {
  if (buffer.length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(buffer.toString('utf-8'));
    if (!isObjectRecord(parsed)) {
      throw createInvalidJsonBodyError();
    }
    return parsed;
  } catch (error) {
    if (isInvalidJsonBodyError(error)) {
      throw error;
    }
    throw createInvalidJsonBodyError();
  }
}

export function readMultipartSingleFile(
  contentTypeHeader: string | string[] | undefined,
  body: Buffer,
  expectedFieldName: string
): { fileName: string; data: Buffer; contentType: string | null } | null {
  const headerValue = Array.isArray(contentTypeHeader)
    ? contentTypeHeader.join(';')
    : contentTypeHeader;
  const boundary = headerValue?.split('boundary=')[1];
  if (!boundary) return null;

  const parts = body.toString('binary').split(`--${boundary}`);
  for (const part of parts) {
    if (!part.includes('Content-Disposition')) continue;
    const fieldMatch = part.match(/name="([^"]+)"/);
    const fieldName = fieldMatch?.[1] || '';
    if (fieldName !== expectedFieldName) continue;

    const filenameMatch = part.match(/filename="([^"]+)"/);
    const fileName = filenameMatch?.[1] || '';
    if (!fileName) continue;

    const dataStart = part.indexOf('\r\n\r\n') + 4;
    const dataEnd = part.lastIndexOf('\r\n');
    if (dataStart < 4 || dataEnd <= dataStart) continue;

    const contentTypeMatch = part.match(/Content-Type:\s*([^\r\n]+)/i);
    return {
      fileName,
      data: Buffer.from(part.substring(dataStart, dataEnd), 'binary'),
      contentType: contentTypeMatch?.[1]?.trim() || null
    };
  }

  return null;
}
