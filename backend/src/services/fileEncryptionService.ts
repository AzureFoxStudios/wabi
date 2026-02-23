import { createCipheriv, createDecipheriv, createHash } from "crypto";
import { randomBytes } from "crypto";
import { writeFileSync } from "fs";

// Encryption constants
const AT_REST_MAGIC = Buffer.from('WABIENC1');
const FILE_ENCRYPTION_SECRET = process.env.FILE_ENCRYPTION_KEY || '';
const FILE_ENCRYPTION_KEY = FILE_ENCRYPTION_SECRET
  ? createHash('sha256').update(FILE_ENCRYPTION_SECRET).digest()
  : null;

/**
 * Encrypt data for at-rest storage using AES-256-GCM
 * @param plain - The plaintext buffer to encrypt
 * @returns Encrypted buffer with magic header, IV, auth tag, and ciphertext
 */
export function maybeEncryptForAtRest(plain: Buffer): Buffer {
  if (!FILE_ENCRYPTION_KEY) return plain;
  
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', FILE_ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  
  return Buffer.concat([AT_REST_MAGIC, iv, tag, encrypted]);
}

/**
 * Decrypt data from at-rest storage
 * @param buffer - The encrypted buffer with magic header, IV, auth tag, and ciphertext
 * @returns Decrypted plaintext buffer
 * @throws Error if encrypted but FILE_ENCRYPTION_KEY is not configured
 */
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

/**
 * Write encrypted file to disk
 * @param filePath - Path to write the file to
 * @param payload - The plaintext data to encrypt and write
 */
export function writeUploadFile(filePath: string, payload: Buffer): void {
  writeFileSync(filePath, maybeEncryptForAtRest(payload));
}

/**
 * Check if file encryption is configured and enabled
 */
export function isFileEncryptionEnabled(): boolean {
  return FILE_ENCRYPTION_KEY !== null;
}

/**
 * Get the encryption key (for debugging purposes - returns hash prefix only)
 */
export function getEncryptionKeyPreview(): string {
  if (!FILE_ENCRYPTION_KEY) return '(not configured)';
  return FILE_ENCRYPTION_KEY.slice(0, 8).toString('hex') + '...';
}
