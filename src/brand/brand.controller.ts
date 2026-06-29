import { Controller, Get, Patch, Param, Body, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { BrandService } from './brand.service';

@UseGuards(JwtAuthGuard)
@Controller('brands')
export class BrandController {
  constructor(private readonly brandService: BrandService) {}

  /** GET /brands — all brands with performance metrics */
  @Get()
  async getBrands(@CurrentUser() user: { id: string }) {
    return this.brandService.getBrandsWithPerformance(user.id);
  }

  /** PATCH /brands/:id/status — update store status */
  @Patch(':id/status')
  async updateStatus(
    @Param('id') id: string,
    @Body() body: { status: 'PENDING' | 'BUILDING' | 'LIVE'; homepageUrl?: string; productPageUrl?: string },
  ) {
    await this.brandService.updateStoreStatus(id, body.status, {
      homepageUrl:    body.homepageUrl,
      productPageUrl: body.productPageUrl,
    });
    return { success: true };
  }
}
