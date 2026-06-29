/**
 * AdCreativesModule — V60 PATCHED
 *
 * Fix [H7]: AiCreativeProviderService is now exported so PlatformAdsModule
 * can import it from here instead of instantiating its own copy.
 *
 * BEFORE: PlatformAdsModule listed AiCreativeProviderService in its providers[]
 *         directly, creating a second instance that didn't share config/state
 *         with the instance in AdCreativesModule.
 *
 * AFTER:  AiCreativeProviderService is added to exports[]. PlatformAdsModule
 *         imports AdCreativesModule and receives the shared singleton.
 *         Split-state bug eliminated.
 */

import { Module } from '@nestjs/common';
import { AdCreativesController }     from './ad-creatives.controller';
import { AdCreativesService }        from './ad-creatives.service';
import { CreativeGeneratorService }  from './creative-generator.service';
import { AiCreativeProviderService } from './ai-creative-provider.service';

@Module({
  controllers: [AdCreativesController],
  providers: [
    AiCreativeProviderService,
    CreativeGeneratorService,
    AdCreativesService,
  ],
  exports: [
    AiCreativeProviderService,   // [H7 FIX] — exported for PlatformAdsModule
    CreativeGeneratorService,
    AdCreativesService,
  ],
})
export class AdCreativesModule {}
