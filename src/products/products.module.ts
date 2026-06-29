/**
 * ProductsModule (V2 — AI-Queue Updated)
 *
 * Changes from V1:
 *  - AiMediaModule removed: ProductsService no longer calls AiMediaService directly.
 *    All AI media generation is enqueued via AiJobService (WorkersModule).
 *  - WorkersModule added: exports AiJobService used by ProductsService for
 *    enqueuing listing:generate, hooks:generate, and media:generate jobs.
 *  - AiMediaModule kept temporarily for any controllers that still reference
 *    AiMediaService directly — remove once fully migrated.
 */

import { Module } from '@nestjs/common';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { TrendFetcher } from './engines/trend.fetcher';
import { ShopifyModule } from '../shopify/shopify.module';
import { MetaAdsModule } from '../meta-ads/meta-ads.module';
import { WorkersModule } from '../workers/workers.module';

@Module({
  imports: [
    ShopifyModule,
    MetaAdsModule,
    WorkersModule,   // exports AiJobService — required by ProductsService.generateListing/scoreAndDecide
  ],
  controllers: [ProductsController],
  providers:   [ProductsService, TrendFetcher],
  exports:     [ProductsService],
})
export class ProductsModule {}
