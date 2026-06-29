import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  ParseUUIDPipe,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { OrganicService } from './organic.service';
import {
  CreateOrganicPostDto,
  ScheduleOrganicPostDto,
  BoostOrganicPostDto,
} from './dto/organic.dto';
import { JwtAuthGuard } from '../common/guards';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';

@Controller('organic')
@UseGuards(JwtAuthGuard)
export class OrganicController {
  constructor(private readonly organicService: OrganicService) {}

  /** POST /organic/post — publish immediately to one or more platforms */
  @Post('post')
  @HttpCode(HttpStatus.CREATED)
  post(@CurrentUser() user: JwtPayload, @Body() dto: CreateOrganicPostDto) {
    return this.organicService.post(user.sub, dto);
  }

  /** POST /organic/schedule — schedule a post for a future time */
  @Post('schedule')
  @HttpCode(HttpStatus.CREATED)
  schedule(@CurrentUser() user: JwtPayload, @Body() dto: ScheduleOrganicPostDto) {
    return this.organicService.schedulePost(user.sub, dto);
  }

  /** GET /organic/posts — list all organic posts for the user */
  @Get('posts')
  listPosts(@CurrentUser() user: JwtPayload) {
    return this.organicService.listPosts(user.sub);
  }

  /** GET /organic/posts/:id/metrics — view engagement metrics */
  @Get('posts/:id/metrics')
  getMetrics(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.organicService.getPostMetrics(user.sub, id);
  }

  /** POST /organic/posts/:id/sync-engagement — manually trigger engagement sync */
  @Post('posts/:id/sync-engagement')
  @HttpCode(HttpStatus.OK)
  syncEngagement(@Param('id', ParseUUIDPipe) id: string) {
    return this.organicService.syncEngagement(id);
  }

  /** POST /organic/posts/:id/boost — boost a post with optional paid budget */
  @Post('posts/:id/boost')
  @HttpCode(HttpStatus.OK)
  boost(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: BoostOrganicPostDto,
  ) {
    return this.organicService.boostPost(user.sub, id, dto.budgetInr);
  }
}
