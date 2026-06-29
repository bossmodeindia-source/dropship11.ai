import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OrganicService } from './organic.service';

@Injectable()
export class OrganicScheduler {
  private readonly logger = new Logger(OrganicScheduler.name);

  constructor(private readonly organicService: OrganicService) {}

  /** Publish scheduled posts — runs every 5 minutes */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async publishScheduledPosts(): Promise<void> {
    this.logger.debug('Running scheduled posts publisher');
    await this.organicService.publishDueScheduledPosts();
  }

  /** Sync engagement metrics — runs every 6 hours */
  @Cron('0 */6 * * *')
  async syncEngagement(): Promise<void> {
    this.logger.log('Running engagement metrics sync');
    await this.organicService.syncAllEngagement();
  }
}
