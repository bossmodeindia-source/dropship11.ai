/**
 * GlobalModule — V55
 *
 * Provides:
 *   - RegionService            (country profiles, logistics)
 *   - CurrencyService          (FX conversion)
 *   - CountryProfitService     (per-country P&L)
 *   - CountrySelectorService   (best-country ranking)
 *   - GlobalController         (GET /global/*)
 *
 * @Global — exported services injectable anywhere without re-import.
 */

import { Global, Module } from '@nestjs/common';
import { RegionService }          from './region.service';
import { CurrencyService }        from './currency.service';
import { CountryProfitService }   from './country-profit.service';
import { CountrySelectorService } from './country-selector.service';
import { GlobalController }       from './global.controller';

@Global()
@Module({
  providers: [
    RegionService,
    CurrencyService,
    CountryProfitService,
    CountrySelectorService,
  ],
  controllers: [GlobalController],
  exports: [
    RegionService,
    CurrencyService,
    CountryProfitService,
    CountrySelectorService,
  ],
})
export class GlobalModule {}
