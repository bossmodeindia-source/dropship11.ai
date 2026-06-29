import { Module } from '@nestjs/common';
import { CampaignModeService } from './campaign-mode.service';
import { CampaignModeController } from './campaign-mode.controller';
import { MetaAdsModule } from '../meta-ads/meta-ads.module';
import { OrganicModule } from '../organic/organic.module';
import { MetaAdsExtensionService } from '../meta-ads/meta-ads-extension.service';

@Module({
  imports: [
    MetaAdsModule,
    OrganicModule,
  ],
  controllers: [CampaignModeController],
  providers:   [CampaignModeService, MetaAdsExtensionService],
  exports:     [CampaignModeService],
})
export class CampaignModeModule {}
