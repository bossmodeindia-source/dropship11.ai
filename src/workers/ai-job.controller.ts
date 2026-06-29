/**
 * AiJobController
 *
 * Exposes the async job polling endpoint for all AI operations.
 *
 * GET  /ai/jobs/:jobId        — poll result for a specific job
 * GET  /ai/jobs               — list recent jobs for the current user
 */

import {
  Controller,
  Get,
  Param,
  Query,
  NotFoundException,
  UseGuards,
  ParseIntPipe,
  DefaultValuePipe,
  Inject,
} from '@nestjs/common';
import { JwtAuthGuard   } from '../common/guards/jwt-auth.guard';
import { CurrentUser    } from '../common/decorators/current-user.decorator';
import { JwtPayload     } from '../common/decorators/current-user.decorator';
import { AiJobService, JobResult } from './ai-job.service';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DB_TOKEN       } from '../common/database/database.module';
import * as schema from '../common/database/schema';
import { eq, desc } from 'drizzle-orm';

@Controller('ai/jobs')
@UseGuards(JwtAuthGuard)
export class AiJobController {
  constructor(
    @Inject(DB_TOKEN) private readonly db:     NodePgDatabase<typeof schema>,
    private readonly jobService: AiJobService,
  ) {}

  /**
   * GET /ai/jobs/:jobId
   * Poll for the result of a specific async AI job.
   */
  @Get(':jobId')
  async getJob(
    @Param('jobId') jobId: string,
    @CurrentUser()  user:  JwtPayload,
  ): Promise<JobResult> {
    // Verify the job belongs to this user
    const row = await this.db.query.aiJobResults.findFirst({
      where: (j, { and, eq }) => and(
        eq(j.jobId,  jobId),
        eq(j.userId, user.sub),
      ),
    });

    if (!row) throw new NotFoundException(`Job ${jobId} not found`);

    return {
      jobId:       row.jobId,
      queue:       row.queue,
      operation:   row.operation,
      status:      row.status as JobResult['status'],
      result:      row.result,
      error:       row.error ?? undefined,
      createdAt:   row.createdAt,
      completedAt: row.completedAt ?? undefined,
    };
  }

  /**
   * GET /ai/jobs?limit=20&operation=listing
   * List recent jobs for the authenticated user.
   */
  @Get()
  async listJobs(
    @CurrentUser() user: JwtPayload,
    @Query('limit',     new DefaultValuePipe(20), ParseIntPipe) limit:     number,
    @Query('operation') operation?: string,
  ): Promise<JobResult[]> {
    const rows = await this.db.query.aiJobResults.findMany({
      where: (j, { and, eq }) => operation
        ? and(eq(j.userId, user.sub), eq(j.operation, operation))
        : eq(j.userId, user.sub),
      orderBy: [desc(schema.aiJobResults.createdAt)],
      limit:   Math.min(limit, 100),
    });

    return rows.map(r => ({
      jobId:       r.jobId,
      queue:       r.queue,
      operation:   r.operation,
      status:      r.status as JobResult['status'],
      result:      r.result,
      error:       r.error ?? undefined,
      createdAt:   r.createdAt,
      completedAt: r.completedAt ?? undefined,
    }));
  }
}
