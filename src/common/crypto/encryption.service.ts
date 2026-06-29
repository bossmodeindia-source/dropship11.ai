import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
  timingSafeEqual,
} from 'crypto';

/**
 * AES-256-GCM encryption service for sensitive credentials.
 *
 * Envelope format (base64-encoded):
 *   <iv:12B> + <authTag:16B> + <ciphertext:nB>  →  base64url string
 *
 * Key derivation: SHA-256(ENCRYPTION_MASTER_KEY) → 32-byte AES key.
 * This ensures the env var does not need to be exactly 32 bytes, and
 * key material is never logged.
 *
 * NEVER log the plaintext, key, or any intermediate key material.
 */
@Injectable()
export class EncryptionService {
  private readonly logger = new Logger(EncryptionService.name);
  private readonly key: Buffer;
  private readonly ALGORITHM = 'aes-256-gcm';
  private readonly IV_LEN = 12;   // 96-bit IV (GCM recommended)
  private readonly TAG_LEN = 16;  // 128-bit auth tag

  constructor(private readonly config: ConfigService) {
    const masterKey = this.config.get<string>('ENCRYPTION_MASTER_KEY');
    if (!masterKey || masterKey.length < 32) {
      throw new Error(
        'ENCRYPTION_MASTER_KEY must be set and at least 32 characters. ' +
        'Generate with: openssl rand -hex 32',
      );
    }
    // Derive a fixed 32-byte key — never log this
    this.key = createHash('sha256').update(masterKey).digest();
    this.logger.log('EncryptionService initialized (key material not logged)');
  }

  /**
   * Encrypt plaintext → opaque base64url token.
   * Safe to store in DB; meaningless without the master key.
   */
  encrypt(plaintext: string): string {
    if (!plaintext) return plaintext;

    const iv         = randomBytes(this.IV_LEN);
    const cipher     = createCipheriv(this.ALGORITHM, this.key, iv, {
      authTagLength: this.TAG_LEN,
    });

    const encrypted  = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag    = cipher.getAuthTag();

    // Pack: iv || authTag || ciphertext
    const packed = Buffer.concat([iv, authTag, encrypted]);
    return packed.toString('base64url');
  }

  /**
   * Decrypt a base64url token → original plaintext.
   * Throws if tampering is detected (GCM auth tag mismatch).
   */
  decrypt(token: string): string {
    if (!token) return token;

    let packed: Buffer;
    try {
      packed = Buffer.from(token, 'base64url');
    } catch {
      throw new Error('EncryptionService: invalid token encoding');
    }

    if (packed.length < this.IV_LEN + this.TAG_LEN + 1) {
      throw new Error('EncryptionService: token too short, likely corrupted');
    }

    const iv         = packed.subarray(0, this.IV_LEN);
    const authTag    = packed.subarray(this.IV_LEN, this.IV_LEN + this.TAG_LEN);
    const ciphertext = packed.subarray(this.IV_LEN + this.TAG_LEN);

    const decipher = createDecipheriv(this.ALGORITHM, this.key, iv, {
      authTagLength: this.TAG_LEN,
    });
    decipher.setAuthTag(authTag);

    try {
      const decrypted = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      return decrypted.toString('utf8');
    } catch {
      // Do NOT include the token or key in the error message
      throw new Error('EncryptionService: decryption failed — data may be tampered or key mismatch');
    }
  }

  /**
   * Constant-time equality to prevent timing attacks.
   * Use when comparing tokens (e.g., webhook secrets).
   */
  safeEqual(a: string, b: string): boolean {
    try {
      const ab = Buffer.from(a);
      const bb = Buffer.from(b);
      if (ab.length !== bb.length) return false;
      return timingSafeEqual(ab, bb);
    } catch {
      return false;
    }
  }
}
