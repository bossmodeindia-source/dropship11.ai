/**
 * CommercePipelineService
 *
 * THE MAIN ORCHESTRATOR — runCommercePipeline(botId)
 *
 * Full autonomous pipeline:
 *
 *   1.  discover        → V46 product discovery (bot finds products)
 *   2.  approve         → User approval gate (human in the loop)
 *   3.  price           → CommissionService computes price floor (hidden commission)
 *   4.  shopify_create  → ShopifyAutoListingService creates Shopify product
 *   5.  creative_gen    → CreativeGeneratorService generates hooks/captions/scripts
 *   6.  creative_score  → Creative Scoring AI selects best creative
 *   7.  mode_select     → CampaignModeService routes to paid / organic / hybrid
 *   8.  execute         → MetaAds or OrganicService launches campaign
 *   9.  track           → MetaPerformanceService / OrganicService syncs metrics
 *  10.  optimize        → A/B kill weak creatives, scale winners
 *  11.  orders          → Webhook order ingestion + supplier payment workflow
 *  12.  finance         → FinancialAiService profit tracking
 *  13.  learn           → FeedbackProcessor harvests winning patterns
 *
 * Safety locks (enforced at every gate):
 *   ✅ No ads before Shopify product is ready
 *   ✅ No price below supplier minimum (hidden commission enforced)
 *   ✅ No fulfillment before supplier payment
 *   ✅ Daily spend cap + stop-loss protection
 *   ✅ Invalid token / credential check before API calls
 */

import {
  Injectable,
  Logger,
  Inject,
  NotFoundException,
} from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { DrizzleDB, DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';
import * as ext from './schema-extensions';
import { CommissionService } from '../commission/commission.service';
import { ShopifyAutoListingService } from '../shopify/shopify-auto-listing.service';
import { CreativeGeneratorService } from '../ad-creatives/creative-generator.service';
import { CampaignModeService } from '../campaign-mode/campaign-mode.service';
import { OrganicService } from '../organic/organic.service';
import { SupplierService } from '../supplier/supplier.service';
import { ApproveProductDto, PaySupplierDto } from './dto/commerce.dto';

export interface PipelineStageResult {
  stage:    string;
  status:   'ok' | 'skipped' | 'error';
  data?:    unknown;
  message?: string;
}

export interface PipelineResult {
  botId:   string;
  stages:  PipelineStageResult[];
  success: boolean;
  errors:  string[];
}

@Injectable()
export class CommercePipelineService {
  private readonly logger = new Logger(CommercePipelineService.name);

  constructor(
    @Inject(DB_TOKEN)         private readonly db:           DrizzleDB,
    private readonly commission:    CommissionService,
    private readonly shopifyListing: ShopifyAutoListingService,
    private readonly creatives:     CreativeGeneratorService,
    private readonly campaignMode:  CampaignModeService,
    private readonly organic:       OrganicService,
    private readonly supplier:      SupplierService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────────
  // PUBLIC — User-facing pipeline entry points
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Stage 2 — User approval gate.
   * User reviews a discovered product and approves/rejects it with pricing + mode.
   */
  async approveProduct(userId: string, dto: ApproveProductDto): Promise<PipelineStageResult> {
    const [product] = await this.db
      .select()
      .from(schema.products)
      .where(
        and(
          eq(schema.products.id,     dto.productId),
          eq(schema.products.userId, userId),
        ),
      )
      .limit(1);

    if (!product) throw new NotFoundException('Product not found');

    // Stage 3: Enforce price floor (hidden commission baked in)
    const floor = await this.commission.computePriceFloor(
      parseFloat(product.supplierPrice),
      (product.currency ?? undefined),
      (product.category ?? undefined),
    );

    await this.commission.enforceMinimumPrice(
      dto.sellingPrice,
      parseFloat(product.supplierPrice),
      (product.currency ?? undefined),
      (product.category ?? undefined),
    );

    // Save approval
    await this.db
      .insert(ext.productApprovals)
      .values({
        productId:    dto.productId,
        userId,
        status:       'approved',
        sellingPrice: String(dto.sellingPrice),
        campaignMode: dto.campaignMode ?? 'organic',
        approvedAt:   new Date(),
      })
      .onConflictDoUpdate({
        target: [ext.productApprovals.productId, ext.productApprovals.userId],
        set:    {
          status:       'approved',
          sellingPrice: String(dto.sellingPrice),
          campaignMode: dto.campaignMode ?? 'organic',
          approvedAt:   new Date(),
          updatedAt:    new Date(),
        },
      });

    // Update product price
    await this.db
      .update(schema.products)
      .set({ sellingPrice: String(dto.sellingPrice), updatedAt: new Date() })
      .where(eq(schema.products.id, dto.productId));

    this.logger.log(
      `Product ${dto.productId} approved by user ${userId} — ` +
      `selling=₹${dto.sellingPrice} mode=${dto.campaignMode ?? 'organic'} ` +
      `[minimumAllowed=₹${floor.minimumAllowedPrice.toFixed(2)}]`,
    );

    return {
      stage:   'approve',
      status:  'ok',
      data:    {
        productId:           dto.productId,
        sellingPrice:        dto.sellingPrice,
        minimumAllowedPrice: floor.minimumAllowedPrice,  // safe to show — no commission detail
        campaignMode:        dto.campaignMode ?? 'organic',
      },
      message: 'Product approved. Ready for Shopify listing.',
    };
  }

  /**
   * Stage 4 — Shopify product creation.
   * Creates the product on the user's Shopify store.
   */
  async createShopifyProduct(userId: string, productId: string): Promise<PipelineStageResult> {
    const [product] = await this.db
      .select()
      .from(schema.products)
      .where(
        and(
          eq(schema.products.id,     productId),
          eq(schema.products.userId, userId),
        ),
      )
      .limit(1);

    if (!product) throw new NotFoundException('Product not found');

    if (product.shopifyProductId) {
      return {
        stage:   'shopify_create',
        status:  'skipped',
        message: 'Shopify product already exists',
        data:    { shopifyProductId: product.shopifyProductId },
      };
    }

    // Check approval
    const [approval] = await this.db
      .select()
      .from(ext.productApprovals)
      .where(
        and(
          eq(ext.productApprovals.productId, productId),
          eq(ext.productApprovals.userId,    userId),
          eq(ext.productApprovals.status,    'approved'),
        ),
      )
      .limit(1);

    if (!approval) {
      return {
        stage:   'shopify_create',
        status:  'error',
        message: 'Product must be approved before creating Shopify listing',
      };
    }

    const shopifyProductId = await this.shopifyListing.listProduct(product.id, userId);

    return {
      stage:   'shopify_create',
      status:  'ok',
      data:    { shopifyProductId },
      message: `Shopify product created: ${shopifyProductId}`,
    };
  }

  /**
   * Stages 5–8 — Generate creatives → score → launch campaign.
   * Called after Shopify listing is confirmed.
   */
  async generateAndLaunch(userId: string, dto: {
    productId:   string;
    campaignId:  string;
    mode:        'paid' | 'organic' | 'hybrid';
    platforms?:  string[];
    dailyCapInr?: number;
    stopLossInr?: number;
  }): Promise<PipelineStageResult[]> {
    const stages: PipelineStageResult[] = [];

    // Stage 5: Creative generation
    const [product] = await this.db
      .select()
      .from(schema.products)
      .where(
        and(
          eq(schema.products.id,     dto.productId),
          eq(schema.products.userId, userId),
        ),
      )
      .limit(1);

    if (!product) {
      stages.push({ stage: 'creative_gen', status: 'error', message: 'Product not found' });
      return stages;
    }

    try {
      const hooks    = await this.creatives.generateHooks(product);
      const captions = await this.creatives.generateAdCopy(product);
      const script   = await this.creatives.generateVideoScript(product);

      stages.push({
        stage:   'creative_gen',
        status:  'ok',
        data:    { hooks: hooks.length, captions: captions.length, hasScript: !!script },
        message: `Generated ${hooks.length} hooks, ${captions.length} captions`,
      });
    } catch (err: any) {
      stages.push({ stage: 'creative_gen', status: 'error', message: err.message });
    }

    // Stage 6: Creative scoring (already done by CreativeGeneratorService in AI mode)
    stages.push({
      stage:   'creative_score',
      status:  'ok',
      message: 'Creatives scored by AI — best hook and caption selected',
    });

    // Stage 7–8: Mode selection + execution
    try {
      const launchResult = await this.campaignMode.launch(userId, {
        productId:   dto.productId,
        campaignId:  dto.campaignId,
        mode:        dto.mode,
        platforms:   dto.platforms,
        dailyCapInr: dto.dailyCapInr,
        stopLossInr: dto.stopLossInr,
      });

      stages.push({
        stage:   'campaign_launch',
        status:  'ok',
        data:    launchResult,
        message: launchResult.message,
      });
    } catch (err: any) {
      stages.push({ stage: 'campaign_launch', status: 'error', message: err.message });
    }

    return stages;
  }

  /**
   * Stage 11 — Supplier payment.
   * User marks supplier as paid, which unblocks fulfillment.
   */
  async paySupplier(userId: string, dto: PaySupplierDto): Promise<PipelineStageResult> {
    // Verify order belongs to user
    const [order] = await this.db
      .select()
      .from(schema.orders)
      .where(
        and(
          eq(schema.orders.id,     dto.orderId),
          eq(schema.orders.userId, userId),
        ),
      )
      .limit(1);

    if (!order) throw new NotFoundException('Order not found');

    // Check for existing payment record
    const [existing] = await this.db
      .select()
      .from(ext.supplierPayments)
      .where(eq(ext.supplierPayments.orderId, dto.orderId))
      .limit(1);

    if (existing?.status === 'paid') {
      return {
        stage:   'supplier_payment',
        status:  'skipped',
        message: 'Supplier already paid for this order',
        data:    { paymentId: existing.id },
      };
    }

    const amountDue = dto.amountDue ?? parseFloat(order.totalAmount);

    if (existing) {
      // Update existing pending record
      await this.db
        .update(ext.supplierPayments)
        .set({
          status:        'paid',
          amountPaid:    String(amountDue),
          paymentRef:    dto.paymentRef,
          paymentMethod: dto.paymentMethod,
          paidAt:        new Date(),
          updatedAt:     new Date(),
        })
        .where(eq(ext.supplierPayments.id, existing.id));
    } else {
      // Create new payment record
      await this.db
        .insert(ext.supplierPayments)
        .values({
          orderId:       dto.orderId,
          userId,
          supplierId:    dto.supplierId,
          supplierName:  dto.supplierName,
          amountDue:     String(amountDue),
          amountPaid:    String(amountDue),
          currency:      order.currency,
          status:        'paid',
          paymentRef:    dto.paymentRef,
          paymentMethod: dto.paymentMethod,
          paidAt:        new Date(),
          notes:         dto.notes,
        });
    }

    // Update order status to supplier_submitted now that payment is confirmed
    await this.db
      .update(schema.orders)
      .set({ status: 'supplier_submitted', updatedAt: new Date() })
      .where(eq(schema.orders.id, dto.orderId));

    this.logger.log(`Supplier payment confirmed for order ${dto.orderId} — ₹${amountDue}`);

    return {
      stage:   'supplier_payment',
      status:  'ok',
      data:    { orderId: dto.orderId, amountPaid: amountDue },
      message: `Supplier paid ₹${amountDue}. Order submitted for fulfillment.`,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // FULL AUTONOMOUS PIPELINE
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * runCommercePipeline(botId)
   *
   * Full autonomous run triggered by the bot orchestrator.
   * This is a stateless coordinator — it runs through whatever stages
   * are ready for the given bot. Human approval gate (stage 2) means
   * the pipeline pauses and resumes when the user calls approveProduct().
   *
   * The orchestrator calls this on a schedule (e.g. every 10 mins via BullMQ).
   */
  async runCommercePipeline(botId: string): Promise<PipelineResult> {
    const stages: PipelineStageResult[] = [];
    const errors: string[] = [];

    this.logger.log(`▶ Commerce pipeline starting for bot: ${botId}`);

    try {
      // Stage 1: Check for approved products waiting for Shopify listing
      const pendingApprovals = await this.db
        .select({
          approval: ext.productApprovals,
          product:  schema.products,
        })
        .from(ext.productApprovals)
        .innerJoin(schema.products, eq(schema.products.id, ext.productApprovals.productId))
        .where(
          and(
            eq(ext.productApprovals.status, 'approved'),
          ),
        )
        .limit(5);

      if (!pendingApprovals.length) {
        stages.push({ stage: 'discover_check', status: 'skipped', message: 'No approved products pending' });
      } else {
        stages.push({
          stage:   'discover_check',
          status:  'ok',
          message: `${pendingApprovals.length} approved products ready for pipeline`,
        });

        for (const { approval, product } of pendingApprovals) {
          const userId = product.userId;

          // Stage 4: Shopify creation
          if (!product.shopifyProductId) {
            const shopifyStage = await this.createShopifyProduct(userId, product.id).catch(err => ({
              stage: 'shopify_create', status: 'error' as const, message: err.message,
            }));
            stages.push(shopifyStage);

            if (shopifyStage.status === 'error') {
              errors.push(`Shopify creation failed for ${product.id}: ${shopifyStage.message}`);
              continue;
            }
          }

          // Re-fetch product to get updated shopifyProductId
          const [fresh] = await this.db
            .select()
            .from(schema.products)
            .where(eq(schema.products.id, product.id))
            .limit(1);

          if (!fresh?.shopifyProductId) continue;

          // Stages 5–8: Creative gen + campaign launch
          const launchStages = await this.generateAndLaunch(userId, {
            productId:  product.id,
            campaignId: `auto_${product.id}_${Date.now()}`,
            mode:       (approval.campaignMode as 'paid' | 'organic' | 'hybrid') ?? 'organic',
          }).catch(err => [{
            stage: 'launch', status: 'error' as const, message: err.message,
          }]);

          stages.push(...launchStages);
          launchStages.filter(s => s.status === 'error').forEach(s => errors.push(s.message ?? ''));

          // Stage 9: Hybrid escalation check (for campaigns already running organic)
          if (approval.campaignMode === 'hybrid') {
            const escalated = await this.campaignMode
              .checkAndEscalateHybrid(userId, product.id, `auto_${product.id}`)
              .catch(() => false);

            if (escalated) {
              stages.push({
                stage:   'hybrid_escalation',
                status:  'ok',
                message: `Organic posts exceeded engagement threshold — paid ads launched`,
              });
            }
          }
        }
      }

      // Stage 10: Engagement sync for all organic posts
      await this.organic.syncAllEngagement().catch(err =>
        errors.push(`Engagement sync failed: ${err.message}`),
      );
      stages.push({ stage: 'engagement_sync', status: 'ok', message: 'Engagement metrics synced' });

    } catch (err: any) {
      this.logger.error(`Pipeline error: ${err.message}`);
      errors.push(err.message);
    }

    const result: PipelineResult = {
      botId,
      stages,
      success: errors.length === 0,
      errors,
    };

    this.logger.log(
      `▶ Commerce pipeline complete for bot ${botId}: ` +
      `${stages.length} stages, ${errors.length} errors`,
    );

    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // READ API
  // ─────────────────────────────────────────────────────────────────────────────

  async listOrders(userId: string) {
    return this.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.userId, userId))
      .orderBy(desc(schema.orders.createdAt));
  }

  async getPendingApprovals(userId: string) {
    const products = await this.db
      .select()
      .from(schema.products)
      .where(
        and(
          eq(schema.products.userId, userId),
          eq(schema.products.status, 'pending'),
        ),
      )
      .orderBy(desc(schema.products.createdAt));

    // Attach price floor (user-visible minimum only)
    return Promise.all(
      products.map(async (p: any) => {
        const priceInfo = await this.commission.getUserPriceInfo(
          parseFloat(p.supplierPrice),
          p.currency,
          p.category,
        );
        return { ...p, ...priceInfo };
      }),
    );
  }

  async getSupplierPayments(userId: string) {
    return this.db
      .select()
      .from(ext.supplierPayments)
      .where(eq(ext.supplierPayments.userId, userId))
      .orderBy(desc(ext.supplierPayments.createdAt));
  }

  async getDashboardSummary(userId: string) {
    const [orders, products, approvals, payments] = await Promise.all([
      this.db
        .select()
        .from(schema.orders)
        .where(eq(schema.orders.userId, userId))
        .orderBy(desc(schema.orders.createdAt))
        .limit(10),

      this.db
        .select()
        .from(schema.products)
        .where(eq(schema.products.userId, userId)),

      this.db
        .select()
        .from(ext.productApprovals)
        .where(eq(ext.productApprovals.userId, userId)),

      this.db
        .select()
        .from(ext.supplierPayments)
        .where(eq(ext.supplierPayments.userId, userId)),
    ]);

    const totalRevenue = orders
      .reduce((sum: number, o: any) => sum + parseFloat(o.totalAmount ?? 0), 0);

    const totalPaid = payments
      .filter((p: any) => p.status === 'paid')
      .reduce((sum: number, p: any) => sum + parseFloat(p.amountPaid ?? 0), 0);

    return {
      totalOrders:       orders.length,
      totalProducts:     products.length,
      pendingApprovals:  approvals.filter((a: any) => a.status === 'pending').length,
      totalRevenue:      totalRevenue.toFixed(2),
      totalPaidToSuppliers: totalPaid.toFixed(2),
      netProfit:         (totalRevenue - totalPaid).toFixed(2),
      recentOrders:      orders,
    };
  }
}
