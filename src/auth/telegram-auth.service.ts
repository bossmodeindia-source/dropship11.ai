/**
 * TelegramAuthService — Validates Telegram Login Widget payloads and
 * issues JWT tokens, creating the user row on first login.
 *
 * Security:
 *   - Verifies HMAC-SHA256 signature using SHA256(BOT_TOKEN) as key
 *   - Rejects stale auth payloads older than 10 minutes
 *   - Uses constant-time comparison for hash check
 *
 * Usage flow:
 *   1. Frontend shows Telegram Login Widget (data-telegram-login="YourBotName")
 *   2. User taps Login → Telegram calls /api/v1/auth/telegram with the payload
 *   3. This service verifies + creates/finds user → issues JWT pair
 */

import {
  Injectable, UnauthorizedException, Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { Inject } from '@nestjs/common';
import { DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';
import { TokenService } from './token.service';
import { AuditService } from '../audit/audit.service';
import { TelegramAuthDto } from './dto/telegram-auth.dto';
import { AuthResult } from './auth.service';

const MAX_AUTH_AGE_SECONDS = 600; // 10 minutes

@Injectable()
export class TelegramAuthService {
  private readonly logger = new Logger(TelegramAuthService.name);
  private readonly secretKey: Buffer | null;

  constructor(
    @Inject(DB_TOKEN) private db: NodePgDatabase<typeof schema>,
    private tokens: TokenService,
    private audit: AuditService,
    private config: ConfigService,
  ) {
    const botToken = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!botToken) {
      this.logger.warn('TELEGRAM_BOT_TOKEN not set — Telegram login disabled');
      this.secretKey = null;
    } else {
      // Per Telegram docs: secret_key = SHA256(bot_token)
      this.secretKey = crypto.createHash('sha256').update(botToken).digest();
    }
  }

  async loginWithTelegram(dto: TelegramAuthDto, ip?: string): Promise<AuthResult> {
    if (!this.secretKey) {
      throw new UnauthorizedException('Telegram login not configured on this server');
    }

    this.verifySignature(dto);
    this.verifyFreshness(dto.auth_date);

    // Find or create user
    const telegramEmail = `tg_${dto.id}@telegram.internal`;
    const existing = await this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, telegramEmail))
      .limit(1);

    let user: typeof schema.users.$inferSelect;

    if (existing.length > 0) {
      user = existing[0];
      if (!user.isActive) {
        throw new UnauthorizedException('Account suspended');
      }
      // Update name if changed
      const fullName = [dto.first_name, dto.last_name].filter(Boolean).join(' ');
      if (fullName && user.fullName !== fullName) {
        await this.db
          .update(schema.users)
          .set({ fullName, lastLoginAt: new Date() })
          .where(eq(schema.users.id, user.id));
        user = { ...user, fullName, lastLoginAt: new Date() };
      } else {
        await this.db
          .update(schema.users)
          .set({ lastLoginAt: new Date() })
          .where(eq(schema.users.id, user.id));
      }
    } else {
      // Create new user from Telegram identity
      const fullName = [dto.first_name, dto.last_name].filter(Boolean).join(' ') || dto.username || `User${dto.id}`;
      const hash = crypto.randomBytes(32).toString('hex'); // placeholder hash — no password login
      const [newUser] = await this.db
        .insert(schema.users)
        .values({
          email: telegramEmail,
          passwordHash: `tg:${hash}`, // prefix marks it as telegram-only
          fullName,
          companyName: dto.username ? `@${dto.username}` : undefined,
          isVerified: true, // Telegram identity is inherently verified
        })
        .returning();
      user = newUser;

      // Create default free subscription
      await this.db.insert(schema.subscriptions).values({ userId: user.id });

      await this.audit.log({
        tenantId: 'system',
        actorId: user.id,
        action: 'user.created',
        resource: 'system',
        ipAddress: ip,
      });
    }

    await this.audit.log({
      tenantId: 'system',
      actorId: user.id,
      action: 'auth.login',
      resource: 'auth',
      severity: 'info' as const,
      ipAddress: ip,
    });

    const [sub] = await this.db
      .select()
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.userId, user.id))
      .limit(1);

    const tier = sub?.tier ?? 'free';

    const accessToken = this.tokens.signAccess({
      sub: user.id,
      email: user.email,
      role: user.role,
      subscriptionTier: tier,
    });
    const refreshToken = await this.tokens.createRefreshToken(user.id);

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        fullName: user.fullName ?? null,
        subscriptionTier: tier,
      },
    };
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private verifySignature(dto: TelegramAuthDto): void {
    const { hash, ...rest } = dto;

    // Build data-check-string: sorted key=value pairs joined by newline
    const dataCheckString = Object.entries(rest)
      .filter(([, v]) => v !== undefined && v !== null)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const expectedHex = crypto
      .createHmac('sha256', this.secretKey!)
      .update(dataCheckString)
      .digest('hex');

    // Constant-time comparison
    const expected = Buffer.from(expectedHex, 'hex');
    const received = Buffer.from(hash.padEnd(expectedHex.length, '0').slice(0, expectedHex.length), 'hex');

    if (!crypto.timingSafeEqual(expected, received)) {
      this.logger.warn('Telegram auth: invalid hash');
      throw new UnauthorizedException('Invalid Telegram auth signature');
    }
  }

  private verifyFreshness(authDate: number): void {
    const age = Math.floor(Date.now() / 1000) - authDate;
    if (age > MAX_AUTH_AGE_SECONDS) {
      throw new UnauthorizedException(
        `Telegram auth payload expired (age: ${age}s, max: ${MAX_AUTH_AGE_SECONDS}s)`,
      );
    }
  }
}
