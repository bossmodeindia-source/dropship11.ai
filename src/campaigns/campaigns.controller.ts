import { Controller, Post, Get, Body, Param, Query, ParseUUIDPipe, ParseIntPipe, DefaultValuePipe } from '@nestjs/common';
import { CampaignsService } from './campaigns.service';
import { GenerateCampaignDto } from './dto/generate-campaign.dto';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';

@Controller('campaign')
export class CampaignsController {
  constructor(private readonly campaignsService: CampaignsService) {}

  @Post('generate')
  generate(@CurrentUser() user: JwtPayload, @Body() dto: GenerateCampaignDto) {
    return this.campaignsService.generate(user, dto);
  }

  @Get()
  findAll(
    @CurrentUser() user: JwtPayload,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.campaignsService.findAll(user.sub, page, Math.min(limit, 100));
  }

  @Get(':id')
  findOne(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string) {
    return this.campaignsService.findOne(user.sub, id);
  }
}
