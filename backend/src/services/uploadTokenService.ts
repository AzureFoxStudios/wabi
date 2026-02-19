import { createHmac, randomBytes, timingSafeEqual } from "crypto";

// Token configuration
const UPLOAD_TOKEN_SECRET = process.env.UPLOAD_TOKEN_SECRET || process.env.JWT_SECRET || process.env.SESSION_SECRET || 'wabi-upload-secret-change-me';
const UPLOAD_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Encode a buffer to base64URL format (no padding, URL-safe characters)
 */
export function base64UrlEncodeBuffer(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/**
 * Decode a base64URL string back to a Buffer
 */
export function base64UrlDecodeToBuffer(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((input.length + 3) % 4);
  return Buffer.from(padded, 'base64');
}

/**
 * Generate a signed upload token for resumable uploads
 * @param uploadId - Unique identifier for the upload session
 * @param ownerKey - Owner key (e.g., "user:123" or "guest:sessionId")
 * @returns Signed token string
 */
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

/**
 * Verify an upload token and extract its payload
 * @param token - The token string to verify
 * @param uploadId - Expected upload ID to match
 * @param ownerKey - Expected owner key to match
 * @returns true if valid, false otherwise
 */
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

/**
 * Get the token TTL in milliseconds
 */
export function getUploadTokenTtlMs(): number {
  return UPLOAD_TOKEN_TTL_MS;
}

/**
 * Get the token secret (for debugging - returns masked version)
 */
export function getUploadTokenSecretPreview(): string {
  if (!UPLOAD_TOKEN_SECRET) return '(not set)';
  return UPLOAD_TOKEN_SECRET.slice(0, 8) + '...';
}
