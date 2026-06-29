import {
  Controller,
  Post,
  Body,
  Param,
  ParseUUIDPipe,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { CampaignModeService } from './campaign-mode.service';
import { LaunchCampaignModeDto, ScaleCampaignDto } from './dto/campaign-mode.dto';
import { JwtAuthGuard } from '../common/guards';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';

@Controller('campaigns')
@UseGuards(JwtAuthGuard)
export class CampaignModeController {
  constructor(private readonly campaignModeService: CampaignModeService) {}

  /** POST /campaigns/launch — launch in paid / organic / hybrid mode */
  @Post('launch')
  @HttpCode(HttpStatus.CREATED)
  launch(@CurrentUser() user: JwtPayload, @Body() dto: LaunchCampaignModeDto) {
    return this.campaignModeService.launch(user.sub, dto);
  }

  /** POST /campaigns/:id/scale — scale a paid campaign */
  @Post(':id/scale')
  @HttpCode(HttpStatus.OK)
  scale(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ScaleCampaignDto,
  ) {
    return this.campaignModeService.scale(user.sub, id, dto.factor);
  }

  /** POST /campaigns/:id/pause — pause a campaign */
  @Post(':id/pause')
  @HttpCode(HttpStatus.OK)
  pause(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.campaignModeService.pause(user.sub, id);
  }
}
