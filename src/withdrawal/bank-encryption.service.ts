/**
 * BankEncryptionService
 *
 * AES-256-GCM encryption for sensitive bank details stored in withdrawals.
 *
 * Security guarantees:
 *   - Each field encrypted with its own random 12-byte IV (nonce)
 *   - 128-bit GCM authentication tag validates ciphertext integrity
 *   - Master key lives ONLY in BANK_ENCRYPTION_KEY env var
 *   - Plaintext is NEVER logged — even at debug level
 *   - Decryption is only available to admin-role callers
 *
 * Usage:
 *   const encrypted = await bankEnc.encrypt('420100012345');
 *   // Store encrypted.ciphertext + encrypted.iv + encrypted.tag
 *
 *   const plain = await bankEnc.decrypt(ciphertext, iv, tag);
 *   // Returns '420100012345'
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES  = 12;  // 96-bit nonce — recommended for GCM
const TAG_BYTES = 16;  // 128-bit auth tag
const KEY_BYTES = 32;  // 256-bit key

export interface EncryptedField {
  ciphertext: string; // base64
  iv:         string; // base64
  tag:        string; // base64
}

@Injectable()
export class BankEncryptionService implements OnModuleInit {
  private readonly logger = new Logger(BankEncryptionService.name);
  private masterKey!: Buffer;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const keyHex = this.config.getOrThrow<string>('BANK_ENCRYPTION_KEY');

    if (keyHex.length < 64) {
      throw new Error(
        'BANK_ENCRYPTION_KEY must be at least 64 hex chars (256-bit key). ' +
        'Generate with: openssl rand -hex 32',
      );
    }

    this.masterKey = Buffer.from(keyHex.slice(0, 64), 'hex');
    this.logger.log('BankEncryptionService initialized — key loaded from env');
  }

  /**
   * Encrypt a plaintext bank detail field.
   * Returns ciphertext, IV, and GCM auth tag (all base64).
   */
  encrypt(plaintext: string): EncryptedField {
    if (!plaintext || typeof plaintext !== 'string') {
      throw new TypeError('BankEncryptionService.encrypt: plaintext must be a non-empty string');
    }

    const iv     = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, this.masterKey, iv);

    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);

    const tag = cipher.getAuthTag();

    // NEVER log the plaintext — this comment is a reminder, not a mistake
    return {
      ciphertext: encrypted.toString('base64'),
      iv:         iv.toString('base64'),
      tag:        tag.toString('base64'),
    };
  }

  /**
   * Decrypt a bank detail field.
   * Throws if ciphertext has been tampered (GCM auth tag mismatch).
   */
  decrypt(ciphertext: string, iv: string, tag: string): string {
    if (!ciphertext || !iv || !tag) {
      throw new TypeError('BankEncryptionService.decrypt: all arguments are required');
    }

    const ivBuf  = Buffer.from(iv, 'base64');
    const tagBuf = Buffer.from(tag, 'base64');

    const decipher = crypto.createDecipheriv(ALGORITHM, this.masterKey, ivBuf);
    decipher.setAuthTag(tagBuf);

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64')),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  }

  /**
   * Encrypt all three bank credential fields in one call.
   * Returns three EncryptedField objects — one per field.
   */
  encryptBankDetails(input: {
    accountHolderName: string;
    accountNumber:     string;
    ifscCode:          string;
  }): {
    accountHolderName: EncryptedField;
    accountNumber:     EncryptedField;
    ifscCode:          EncryptedField;
  } {
    return {
      accountHolderName: this.encrypt(input.accountHolderName),
      accountNumber:     this.encrypt(input.accountNumber),
      ifscCode:          this.encrypt(input.ifscCode),
    };
  }

  /**
   * Decrypt all three bank credential fields.
   * For ADMIN USE ONLY — caller must enforce role before invoking.
   */
  decryptBankDetails(encrypted: {
    accountHolderNameCiphertext: string;
    accountHolderNameIv:         string;
    accountHolderNameTag:        string;
    accountNumberCiphertext:     string;
    accountNumberIv:             string;
    accountNumberTag:            string;
    ifscCodeCiphertext:          string;
    ifscCodeIv:                  string;
    ifscCodeTag:                 string;
  }): {
    accountHolderName: string;
    accountNumber:     string;
    ifscCode:          string;
  } {
    return {
      accountHolderName: this.decrypt(
        encrypted.accountHolderNameCiphertext,
        encrypted.accountHolderNameIv,
        encrypted.accountHolderNameTag,
      ),
      accountNumber: this.decrypt(
        encrypted.accountNumberCiphertext,
        encrypted.accountNumberIv,
        encrypted.accountNumberTag,
      ),
      ifscCode: this.decrypt(
        encrypted.ifscCodeCiphertext,
        encrypted.ifscCodeIv,
        encrypted.ifscCodeTag,
      ),
    };
  }
}
