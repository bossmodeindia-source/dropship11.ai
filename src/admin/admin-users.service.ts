import {
  Injectable,
  NotFoundException,
  ConflictException,
  Inject,
  Logger,
} from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, desc, ilike, or, sql } from 'drizzle-orm';
import { DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';
import { AuditService } from '../audit/audit.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateSubscriptionDto } from './dto/update-subscription.dto';
import { JwtPayload } from '../common/decorators/current-user.decorator';

@Injectable()
export class AdminUsersService {
  private readonly logger = new Logger(AdminUsersService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
    private readonly audit: AuditService,
  ) {}

  async findAll(page = 1, limit = 50, search?: string) {
    const offset = (page - 1) * limit;

    const rows = await this.db.query.users.findMany({
      where: search
        ? or(
            ilike(schema.users.email, `%${search}%`),
            ilike(schema.users.fullName ?? schema.users.email, `%${search}%`),
          )
        : undefined,
      orderBy: [desc(schema.users.createdAt)],
      limit,
      offset,
      columns: {
        passwordHash: false, // never expose password hash
      },
      with: {
        subscriptions: true,
      },
    });

    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.users);

    return { items: rows, total: count, page, limit };
  }

  async findOne(userId: string) {
    const user = await this.db.query.users.findFirst({
      where: eq(schema.users.id, userId),
      columns: { passwordHash: false },
      with: { subscriptions: true },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async updateUser(userId: string, dto: UpdateUserDto, actorId: string) {
    const before = await this.findOne(userId);

    const [updated] = await this.db
      .update(schema.users)
      .set({
        role: dto.role,
        isActive: dto.isActive,
        fullName: dto.fullName,
        companyName: dto.companyName,
        aiMode: dto.aiMode,
      })
      .where(eq(schema.users.id, userId))
      .returning({ id: schema.users.id, email: schema.users.email, role: schema.users.role, isActive: schema.users.isActive });

    await this.audit.log({
      tenantId: 'system',
      actorId: actorId,
      action: 'admin.action',
      resource: 'user',
      resourceId: userId,
      severity: 'info',
    });

    this.logger.log(`Admin ${actorId} updated user ${userId}`);
    return updated;
  }

  async suspendUser(actorId: string, userId: string) {
    if (userId === actorId) {
      throw new ConflictException('Cannot suspend your own account');
    }

    const [updated] = await this.db
      .update(schema.users)
      .set({ isActive: false })
      .where(eq(schema.users.id, userId))
      .returning({ id: schema.users.id, isActive: schema.users.isActive });

    await this.audit.log({
      tenantId: 'system',
      actorId: actorId,
      action: 'user.suspended',
      resource: 'user',
      severity: 'info',
    });

    this.logger.warn(`Admin ${actorId} suspended user ${userId}`);
    return updated;
  }

  async reactivateUser(actorId: string, userId: string) {
    const [updated] = await this.db
      .update(schema.users)
      .set({ isActive: true })
      .where(eq(schema.users.id, userId))
      .returning({ id: schema.users.id, isActive: schema.users.isActive });

    await this.audit.log({
      tenantId: 'system',
      actorId: actorId,
      action: 'user.updated',
      resource: 'user',
      resourceId: userId,
      severity: 'info',
    });

    return updated;
  }

  async updateSubscription(userId: string, dto: UpdateSubscriptionDto, actorId: string) {
    // Ensure user exists
    await this.findOne(userId);

    const [updated] = await this.db
      .update(schema.subscriptions)
      .set({
        tier: dto.tier,
        status: dto.status,
        productLimit: dto.productLimit,
        orderLimit: dto.orderLimit,
        aiRequestsLimit: dto.aiRequestsLimit,
      })
      .where(eq(schema.subscriptions.userId, userId))
      .returning();

    await this.audit.log({
      tenantId: 'system',
      actorId: actorId,
      action: 'subscription.changed',
      resource: 'subscription',
      resourceId: updated.id,
      severity: 'info',
    });

    return updated;
  }

  async getUserAuditLog(userId: string, page = 1, limit = 50) {
    return this.audit.query({ actorId: userId, limit, offset: (page - 1) * limit });
  }

  async getStats() {
    const [userCount] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.users);

    const [activeCount] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.users)
      .where(eq(schema.users.isActive, true));

    const [orderCount] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.orders);

    const [productCount] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.products);

    const tierBreakdown = await this.db
      .select({
        tier: schema.subscriptions.tier,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.subscriptions)
      .groupBy(schema.subscriptions.tier);

    return {
      users: { total: userCount.total, active: activeCount.total },
      orders: { total: orderCount.total },
      products: { total: productCount.total },
      subscriptionTiers: tierBreakdown,
    };
  }

// ── V60 Controller aliases ─────────────────────────────────────────────────
  /** Alias for findAll — used by AdminV60Controller */
  async listUsers(opts: { page?: number; limit?: number } = {}) {
    return this.findAll(opts.page ?? 1, opts.limit ?? 50);
  }

  /** Hard-delete a user (super-admin only). Cascades via FK. */
  async deleteUser(userId: string, actorId: string): Promise<{ deleted: true }> {
    await this.db.delete(schema.users).where(eq(schema.users.id, userId));
    await this.audit.log({
      tenantId: 'system', actorId, action: 'admin.delete_user',
      resource: 'users', resourceId: userId, severity: 'warn',
    });
    return { deleted: true };
  }
}
