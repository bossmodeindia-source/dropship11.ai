import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, sql } from 'drizzle-orm';
import { DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';

export type EngineMode = 'AI' | 'BOT';

@Injectable()
export class ToggleService {
  constructor(@Inject(DB_TOKEN) private readonly db: NodePgDatabase<typeof schema>) {}

  async getMode(userId: string): Promise<EngineMode> {
    const user = await this.db.query.users.findFirst({
      where: eq(schema.users.id, userId),
      columns: { aiMode: true },
    });
    if (!user) throw new NotFoundException('User not found');
    return user.aiMode as EngineMode;
  }

  async setMode(userId: string, mode: EngineMode): Promise<void> {
    await this.db.update(schema.users).set({ aiMode: mode }).where(eq(schema.users.id, userId));
  }

  async hasAiQuota(userId: string): Promise<boolean> {
    const sub = await this.db.query.subscriptions.findFirst({
      where: eq(schema.subscriptions.userId, userId),
      columns: { aiRequestsLimit: true, aiRequestsUsed: true, tier: true },
    });
    if (!sub) return false;
    if (sub.tier === 'enterprise') return true;
    return sub.aiRequestsUsed < sub.aiRequestsLimit;
  }

  async consumeAiQuota(userId: string): Promise<void> {
    await this.db
      .update(schema.subscriptions)
      .set({ aiRequestsUsed: sql`${schema.subscriptions.aiRequestsUsed} + 1` })
      .where(eq(schema.subscriptions.userId, userId));
  }
}
