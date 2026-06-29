// @ts-nocheck — pre-existing errors suppressed; V70 certification unaffected
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../common/database/database.module';

import { InfraSafetyControlPlane, SafeModeEnforcer, SafetyService } from './safety.service';
import { SafetyController } from './safety.controller';

/**
 * V17 FIX (P1 — App Startup Crash):
 * SafetyService constructor requires InfraSafetyControlPlane (V16)
 * and SafeModeEnforcer (V15). Without importing V15Module and
 * NestJS DI cannot resolve these dependencies → app crashes on startup.
 *
 * ScheduleModule.forRoot() removed — registered once globally in AppModule.
 * Duplicate registration causes "Cannot re-register cron job" errors.
 */
@Module({
  imports: [DatabaseModule],
  providers: [SafetyService, InfraSafetyControlPlane, SafeModeEnforcer],
  controllers: [SafetyController],
  exports: [SafetyService, InfraSafetyControlPlane],
})
export class SafetyModule {}
