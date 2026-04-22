import type { IncomingMessage } from "http";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "zlib";

export const HTTP_TEXT_COMPRESSION_ENABLED = (process.env.HTTP_TEXT_COMPRESSION_ENABLED || 'true') === 'true';
export const HTTP_TEXT_COMPRESSION_MIN_BYTES = Math.max(0, Number(process.env.HTTP_TEXT_COMPRESSION_MIN_BYTES || 1024));
export const HTTP_TEXT_COMPRESSION_BROTLI_QUALITY = Math.min(11, Math.max(1, Number(process.env.HTTP_TEXT_COMPRESSION_BROTLI_QUALITY || 5)));
export const HTTP_TEXT_COMPRESSION_GZIP_LEVEL = Math.min(9, Math.max(1, Number(process.env.HTTP_TEXT_COMPRESSION_GZIP_LEVEL || 6)));

function isCompressibleContentType(contentType: string): boolean {
  const normalized = (contentType || '').toLowerCase();
  return (
    normalized.startsWith('text/') ||
    normalized.includes('application/json') ||
    normalized.includes('application/javascript') ||
    normalized.includes('application/xml') ||
    normalized.includes('image/svg+xml')
  );
}

function chooseEncoding(acceptEncodingHeader: string | string[] | undefined): 'br' | 'gzip' | null {
  const rawValue = Array.isArray(acceptEncodingHeader)
    ? acceptEncodingHeader.join(',')
    : (acceptEncodingHeader || '');
  const raw = rawValue.toLowerCase();
  if (!raw) return null;
  if (raw.includes('br')) return 'br';
  if (raw.includes('gzip')) return 'gzip';
  return null;
}

export function maybeCompressTextResponse(
  req: Pick<IncomingMessage, 'headers' | 'method'>,
  contentType: string,
  payload: Buffer
): { payload: Buffer; contentEncoding: 'br' | 'gzip' | null } {
  if (!HTTP_TEXT_COMPRESSION_ENABLED) return { payload, contentEncoding: null };
  if (req.method === 'HEAD') return { payload, contentEncoding: null };
  if (payload.length < HTTP_TEXT_COMPRESSION_MIN_BYTES) return { payload, contentEncoding: null };
  if (!isCompressibleContentType(contentType)) return { payload, contentEncoding: null };

  const encoding = chooseEncoding(req.headers['accept-encoding']);
  if (!encoding) return { payload, contentEncoding: null };

  try {
    const compressed = encoding === 'br'
      ? brotliCompressSync(payload, {
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: HTTP_TEXT_COMPRESSION_BROTLI_QUALITY
        }
      })
      : gzipSync(payload, { level: HTTP_TEXT_COMPRESSION_GZIP_LEVEL });
    if (compressed.length >= payload.length) {
      return { payload, contentEncoding: null };
    }
    return { payload: compressed, contentEncoding: encoding };
  } catch (error) {
    console.warn('[Compression] Failed to compress response, falling back to identity:', error);
    return { payload, contentEncoding: null };
  }
}
