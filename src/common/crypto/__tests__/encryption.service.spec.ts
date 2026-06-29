import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EncryptionService } from '../encryption.service';

const MASTER_KEY = 'test-master-key-that-is-at-least-32-chars-long!!';

function makeService(masterKey = MASTER_KEY): EncryptionService {
  const config = { get: jest.fn((key: string) => {
    if (key === 'ENCRYPTION_MASTER_KEY') return masterKey;
  })} as unknown as ConfigService;
  return new EncryptionService(config);
}

describe('EncryptionService', () => {
  let service: EncryptionService;

  beforeEach(() => {
    service = makeService();
  });

  // ── Constructor ───────────────────────────────────────────────────────────

  it('should initialise without error when key is valid', () => {
    expect(service).toBeDefined();
  });

  it('should throw if ENCRYPTION_MASTER_KEY is missing', () => {
    expect(() => makeService('')).toThrow('ENCRYPTION_MASTER_KEY must be set');
  });

  it('should throw if ENCRYPTION_MASTER_KEY is shorter than 32 chars', () => {
    expect(() => makeService('short')).toThrow('ENCRYPTION_MASTER_KEY must be set');
  });

  // ── Encrypt / Decrypt round-trip ──────────────────────────────────────────

  it('should encrypt and decrypt a simple string', () => {
    const plaintext = 'shpat_secret_token_abc123';
    const encrypted = service.encrypt(plaintext);
    expect(encrypted).not.toBe(plaintext);
    expect(service.decrypt(encrypted)).toBe(plaintext);
  });

  it('should produce different ciphertexts for the same plaintext (random IV)', () => {
    const pt   = 'same-value';
    const enc1 = service.encrypt(pt);
    const enc2 = service.encrypt(pt);
    expect(enc1).not.toBe(enc2);          // different IV each time
    expect(service.decrypt(enc1)).toBe(pt);
    expect(service.decrypt(enc2)).toBe(pt);
  });

  it('should handle empty string round-trip', () => {
    expect(service.encrypt('')).toBe('');
    expect(service.decrypt('')).toBe('');
  });

  it('should handle unicode / emoji in plaintext', () => {
    const pt = '✅ Shopify token: shpat_🔑_unicode';
    expect(service.decrypt(service.encrypt(pt))).toBe(pt);
  });

  it('should handle a long token (512 chars)', () => {
    const pt = 'x'.repeat(512);
    expect(service.decrypt(service.encrypt(pt))).toBe(pt);
  });

  // ── Tamper detection (GCM auth tag) ──────────────────────────────────────

  it('should throw when the ciphertext has been tampered', () => {
    const token   = service.encrypt('real-value');
    const decoded = Buffer.from(token, 'base64url');
    // Flip a byte in the ciphertext section (after 12B IV + 16B tag = offset 28)
    decoded[28] ^= 0xff;
    const tampered = decoded.toString('base64url');
    expect(() => service.decrypt(tampered)).toThrow('decryption failed');
  });

  it('should throw when the auth tag has been tampered', () => {
    const token   = service.encrypt('real-value');
    const decoded = Buffer.from(token, 'base64url');
    // Flip a byte in the auth tag section (bytes 12–27)
    decoded[12] ^= 0x01;
    const tampered = decoded.toString('base64url');
    expect(() => service.decrypt(tampered)).toThrow('decryption failed');
  });

  it('should throw for a completely invalid token', () => {
    expect(() => service.decrypt('not-valid-base64url!!!')).toThrow();
  });

  it('should throw when token is too short (truncated)', () => {
    expect(() => service.decrypt('YWJj')).toThrow('token too short');
  });

  // ── Cross-key isolation ───────────────────────────────────────────────────

  it('should not decrypt a token encrypted with a different master key', () => {
    const svc2   = makeService('different-master-key-that-is-long-enough!!');
    const token  = service.encrypt('secret');
    expect(() => svc2.decrypt(token)).toThrow();
  });

  // ── safeEqual ─────────────────────────────────────────────────────────────

  it('safeEqual should return true for identical strings', () => {
    expect(service.safeEqual('abc', 'abc')).toBe(true);
  });

  it('safeEqual should return false for different strings', () => {
    expect(service.safeEqual('abc', 'xyz')).toBe(false);
  });

  it('safeEqual should return false for different-length strings', () => {
    expect(service.safeEqual('abc', 'abcd')).toBe(false);
  });

  it('safeEqual should return false for empty vs non-empty', () => {
    expect(service.safeEqual('', 'a')).toBe(false);
  });

  // ── Security: no secrets in encrypt output ─────────────────────────────────

  it('should not leak plaintext in encrypted output', () => {
    const pt      = 'shpat_supersecret_access_token';
    const enc     = service.encrypt(pt);
    const decoded = Buffer.from(enc, 'base64url').toString('utf8');
    expect(decoded).not.toContain(pt);
  });
});
