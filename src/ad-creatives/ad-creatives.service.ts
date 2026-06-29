import { Injectable, Logger, Inject, NotFoundException } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq, desc } from 'drizzle-orm';
import { DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';
import { CreativeGeneratorService } from './creative-generator.service';

@Injectable()
export class AdCreativesService {
  private readonly logger = new Logger(AdCreativesService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
    private readonly generator: CreativeGeneratorService,
  ) {}

  /** Generate + store a full creative bundle for a product. */
  async generateForProduct(
    userId:     string,
    productId:  string,
    campaignId: string | null = null,
  ): Promise<typeof schema.adCreativeAssets.$inferSelect> {
    const product = await this.db.query.products.findFirst({
      where: and(
        eq(schema.products.id,     productId),
        eq(schema.products.userId, userId),
      ),
    });

    if (!product) throw new NotFoundException('Product not found');

    return this.generator.generateAndStore(product, userId, campaignId);
  }

  /** List all creative bundles for a product (newest first). */
  async findByProduct(
    userId:    string,
    productId: string,
  ): Promise<(typeof schema.adCreativeAssets.$inferSelect)[]> {
    return this.db.query.adCreativeAssets.findMany({
      where: and(
        eq(schema.adCreativeAssets.productId, productId),
        eq(schema.adCreativeAssets.userId,    userId),
      ),
      orderBy: [desc(schema.adCreativeAssets.createdAt)],
    });
  }

  /** List all creative bundles for a campaign. */
  async findByCampaign(
    userId:     string,
    campaignId: string,
  ): Promise<(typeof schema.adCreativeAssets.$inferSelect)[]> {
    return this.db.query.adCreativeAssets.findMany({
      where: and(
        eq(schema.adCreativeAssets.campaignId, campaignId),
        eq(schema.adCreativeAssets.userId,     userId),
      ),
      orderBy: [desc(schema.adCreativeAssets.createdAt)],
    });
  }

  /** Get one creative bundle by ID. */
  async findOne(
    userId: string,
    id:     string,
  ): Promise<typeof schema.adCreativeAssets.$inferSelect> {
    const row = await this.db.query.adCreativeAssets.findFirst({
      where: and(
        eq(schema.adCreativeAssets.id,     id),
        eq(schema.adCreativeAssets.userId, userId),
      ),
    });
    if (!row) throw new NotFoundException('Creative asset not found');
    return row;
  }
}
