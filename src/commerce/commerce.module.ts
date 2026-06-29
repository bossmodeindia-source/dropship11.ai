/**
 * CommerceModule
 *
 * Final Execution Commerce Layer — root module.
 *
 * Aggregates:
 *   CommissionModule    — hidden commission engine (admin-controlled)
 *   OrganicModule       — zero-rupee Instagram/Facebook posting
 *   CampaignModeModule  — paid / organic / hybrid routing
 *   CommercePipelineService — main runCommercePipeline() orchestrator
 *
 * Also registers the execution-layer controllers:
 *   ProductsCommerceController   — approval + pending list
 *   ShopifyCommerceController    — Shopify product creation
 *   CampaignExecutionController  — generate + launch
 *   OrdersCommerceController     — orders + supplier payments
 *   CommerceDashboardController  — dashboard + pipeline trigger
 */

import { Module } from '@nestjs/common';
import { CommissionModule }     from '../commission/commission.module';
import { OrganicModule }        from '../organic/organic.module';
import { CampaignModeModule }   from '../campaign-mode/campaign-mode.module';
import { ShopifyModule }        from '../shopify/shopify.module';
import { AdCreativesModule }    from '../ad-creatives/ad-creatives.module';
import { SupplierModule }       from '../supplier/supplier.module';

import { CommercePipelineService }       from './commerce-pipeline.service';
import {
  ProductsCommerceController,
  ShopifyCommerceController,
  CampaignExecutionController,
  OrdersCommerceController,
  CommerceDashboardController,
} from './commerce.controller';

@Module({
  imports: [
    CommissionModule,    // @Global — available everywhere
    OrganicModule,       // Instagram + Facebook zero-rupee posting
    CampaignModeModule,  // paid / organic / hybrid mode routing
    ShopifyModule,       // ShopifyAutoListingService
    AdCreativesModule,   // CreativeGeneratorService
    SupplierModule,      // @Global — SupplierService
  ],
  controllers: [
    ProductsCommerceController,
    ShopifyCommerceController,
    CampaignExecutionController,
    OrdersCommerceController,
    CommerceDashboardController,
  ],
  providers: [CommercePipelineService],
  exports:   [CommercePipelineService],
})
export class CommerceModule {}
