import { Controller, Get, Post, Put, Body, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SafetyService } from './safety.service';

@UseGuards(JwtAuthGuard)
@Controller('safety')
export class SafetyController {
  constructor(private readonly safetyService: SafetyService) {}

  /** GET /safety/status — full safety dashboard */
  @Get('status')
  getStatus(@CurrentUser() user: { id: string }) {
    return this.safetyService.getSafetyStatus(user.id);
  }

  /** POST /safety/kill-switch — activate or deactivate */
  @Post('kill-switch')
  setKillSwitch(@CurrentUser() user: { id: string }, @Body() body: { active: boolean; reason?: string }) {
    return this.safetyService.setKillSwitch(user.id, body.active, body.reason);
  }

  /** PUT /safety/config — update limits */
  @Put('config')
  updateConfig(
    @CurrentUser() user: { id: string },
    @Body() body: {
      dailyLossLimitInr?: number;
      dailySpendCapInr?:  number;
      fraudCheckEnabled?: boolean;
      fraudThresholdPct?: number;
      autoPauseOnLoss?:   boolean;
    },
  ) {
    return this.safetyService.updateSafetyConfig(user.id, body);
  }

  /** POST /safety/fraud-check — score a single order */
  @Post('fraud-check')
  fraudCheck(
    @CurrentUser() user: { id: string },
    @Body() body: Parameters<SafetyService['scoreFraudRisk']>[1],
  ) {
    return this.safetyService.scoreFraudRisk(user.id, body);
  }
}
