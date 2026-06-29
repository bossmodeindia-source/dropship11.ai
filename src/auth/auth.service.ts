import {
  Injectable, Inject, ConflictException, UnauthorizedException,
  NotFoundException,
} from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { AuditService } from '../audit/audit.service';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResult extends AuthTokens {
  user: {
    id: string;
    email: string;
    role: string;
    fullName: string | null;
    subscriptionTier: string;
  };
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB_TOKEN) private db: NodePgDatabase<typeof schema>,
    private password: PasswordService,
    private tokens: TokenService,
    private audit: AuditService,
  ) {}

  async register(dto: RegisterDto, ip?: string): Promise<AuthResult> {
    const existing = await this.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, dto.email.toLowerCase()))
      .limit(1);

    if (existing.length > 0) {
      throw new ConflictException('Email already registered');
    }

    const hash = await this.password.hash(dto.password);

    const [user] = await this.db
      .insert(schema.users)
      .values({
        email: dto.email.toLowerCase(),
        passwordHash: hash,
        fullName: dto.fullName,
        companyName: dto.companyName,
      })
      .returning();

    // Create default free subscription
    await this.db.insert(schema.subscriptions).values({ userId: user.id });

    await this.audit.log({
      tenantId: 'system',
      actorId: user.id,
      action: 'user.created',
      resource: 'system',
      severity: 'info',
      ipAddress: ip,
    });

    const accessToken = this.tokens.signAccess({
      sub: user.id,
      email: user.email,
      role: user.role,
      subscriptionTier: 'free',
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
        subscriptionTier: 'free',
      },
    };
  }

  /** Used by PassportJS LocalStrategy — returns user or null (never throws) */
  async validateUser(
    email: string,
    password: string,
  ): Promise<typeof schema.users.$inferSelect | null> {
    try {
      const [user] = await this.db
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, email.toLowerCase()))
        .limit(1);
      if (!user || !user.isActive) return null;
      const valid = await this.password.verify(user.passwordHash, password);
      return valid ? user : null;
    } catch {
      return null;
    }
  }

  async login(dto: LoginDto, ip?: string): Promise<AuthResult> {
    const [user] = await this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, dto.email.toLowerCase()))
      .limit(1);

    if (!user) throw new UnauthorizedException('Invalid credentials');
    if (!user.isActive) throw new UnauthorizedException('Account suspended');

    const valid = await this.password.verify(user.passwordHash, dto.password);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    const [sub] = await this.db
      .select()
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.userId, user.id))
      .limit(1);

    // Update last login
    await this.db
      .update(schema.users)
      .set({ lastLoginAt: new Date() })
      .where(eq(schema.users.id, user.id));

    await this.audit.log({
      tenantId: 'system',
      actorId: user.id,
      action: 'auth.login',
      resource: 'system',

      ipAddress: ip,
    });

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

  async refresh(rawToken: string): Promise<AuthTokens> {
    try {
      const { accessToken, refreshToken } =
        await this.tokens.rotateRefreshToken(rawToken);
      return { accessToken, refreshToken };
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  async logout(userId: string, ip?: string, jti?: string, tokenExp?: number): Promise<void> {
    await this.tokens.revokeAllForUser(userId);
    // Blacklist the current access token so it cannot be reused within its remaining TTL
    if (jti && tokenExp) {
      const remainingSecs = Math.max(0, tokenExp - Math.floor(Date.now() / 1000));
      if (remainingSecs > 0) await this.tokens.blacklistToken(jti, remainingSecs);
    }
    await this.audit.log({
      tenantId: 'system',
      actorId: userId,
      action: 'auth.logout',
      resource: 'auth',
      severity: 'info' as const,
      ipAddress: ip,
    });
  }

  async getMe(userId: string): Promise<object> {
    const [user] = await this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);

    if (!user) throw new NotFoundException('User not found');

    const [sub] = await this.db
      .select()
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.userId, userId))
      .limit(1);

    return {
      id: user.id,
      email: user.email,
      role: user.role,
      fullName: user.fullName,
      companyName: user.companyName,
      aiMode: user.aiMode,
      isVerified: user.isVerified,
      subscription: sub
        ? {
            tier: sub.tier,
            status: sub.status,
            productLimit: sub.productLimit,
            orderLimit: sub.orderLimit,
            aiRequestsLimit: sub.aiRequestsLimit,
            aiRequestsUsed: sub.aiRequestsUsed,
            currentPeriodEnd: sub.currentPeriodEnd,
          }
        : null,
    };
  }
}
