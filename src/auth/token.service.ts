import { Injectable, Inject } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'crypto';
import Redis from 'ioredis';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, and, gt } from 'drizzle-orm';
import { DB_TOKEN } from '../common/database/database.module';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import * as schema from '../common/database/schema';
import { JwtPayload } from '../common/decorators/current-user.decorator';

@Injectable()
export class TokenService {
  constructor(
    private jwt: JwtService,
    private config: ConfigService,
    @Inject(DB_TOKEN) private db: NodePgDatabase<typeof schema>,
    @Inject(REDIS_CLIENT) private redis: Redis,
  ) {}

  signAccess(payload: Omit<JwtPayload, 'iat' | 'exp' | 'jti'>): string {
    const jti = randomBytes(16).toString('hex');
    return this.jwt.sign({ ...payload, jti }, {
      expiresIn: this.config.get('JWT_EXPIRES_IN', '15m'),
    });
  }

  async createRefreshToken(userId: string): Promise<string> {
    const raw = randomBytes(40).toString('hex');
    const hash = createHash('sha256').update(raw).digest('hex');

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    await this.db.insert(schema.refreshTokens).values({
      userId,
      tokenHash: hash,
      expiresAt,
    });

    return raw;
  }

  async rotateRefreshToken(
    rawToken: string,
  ): Promise<{ accessToken: string; refreshToken: string; user: typeof schema.users.$inferSelect }> {
    const hash = createHash('sha256').update(rawToken).digest('hex');

    const [stored] = await this.db
      .select()
      .from(schema.refreshTokens)
      .where(
        and(
          eq(schema.refreshTokens.tokenHash, hash),
          eq(schema.refreshTokens.revoked, false),
          gt(schema.refreshTokens.expiresAt, new Date()),
        ),
      )
      .limit(1);

    if (!stored) throw new Error('Invalid or expired refresh token');

    // Revoke used token
    await this.db
      .update(schema.refreshTokens)
      .set({ revoked: true })
      .where(eq(schema.refreshTokens.id, stored.id));

    const [user] = await this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, stored.userId))
      .limit(1);

    if (!user || !user.isActive) throw new Error('User inactive');

    const [sub] = await this.db
      .select()
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.userId, user.id))
      .limit(1);

    const accessToken = this.signAccess({
      sub: user.id,
      email: user.email,
      role: user.role,
      subscriptionTier: sub?.tier ?? 'free',
    });
    const refreshToken = await this.createRefreshToken(user.id);

    return { accessToken, refreshToken, user };
  }

  async blacklistToken(jti: string, expiresIn: number): Promise<void> {
    await this.redis.setex(`bl:${jti}`, expiresIn, '1');
  }

  async isBlacklisted(jti: string): Promise<boolean> {
    return (await this.redis.exists(`bl:${jti}`)) === 1;
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.db
      .update(schema.refreshTokens)
      .set({ revoked: true })
      .where(eq(schema.refreshTokens.userId, userId));
  }
}
