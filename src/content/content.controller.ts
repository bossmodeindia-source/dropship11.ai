import { Controller, Get, Post, Patch, Body, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ContentEngine, ContentRequest } from './content.engine';

@UseGuards(JwtAuthGuard)
@Controller('content')
export class ContentController {
  constructor(private readonly contentEngine: ContentEngine) {}

  /** GET /content/stats */
  @Get('stats')
  getStats(@CurrentUser() user: { id: string }) {
    return this.contentEngine.getContentStats(user.id);
  }

  /** POST /content/generate — generate a daily batch for a brand */
  @Post('generate')
  generate(@CurrentUser() user: { id: string }, @Body() body: Omit<ContentRequest, 'userId'>) {
    return this.contentEngine.generateDailyBatch({ ...body, userId: user.id });
  }

  /** PATCH /content/:id/posted */
  @Patch(':id/posted')
  markPosted(@Param('id') id: string) {
    return this.contentEngine.markPosted(id);
  }

  /** PATCH /content/:id/performance */
  @Patch(':id/performance')
  updatePerformance(
    @Param('id') id: string,
    @Body() body: { views?: number; likes?: number; shares?: number; linkClicks?: number },
  ) {
    return this.contentEngine.updatePerformance(id, body);
  }
}
