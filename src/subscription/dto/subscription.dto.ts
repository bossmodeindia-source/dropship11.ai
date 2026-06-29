/**
 * Subscription DTOs — Platform Razorpay billing only.
 * Users do NOT connect Razorpay. Platform owns the Razorpay account.
 */

import {
  IsString,
  IsNotEmpty,
  IsEnum,
  IsOptional,
  IsBoolean,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export type SubscriptionPlan = 'free' | 'pro' | 'elite';

export class CreateSubscriptionDto {
  @ApiProperty({ enum: ['pro', 'elite'], description: 'Plan to subscribe to' })
  @IsEnum(['pro', 'elite'])
  plan!: 'pro' | 'elite';
}

export class UpgradeSubscriptionDto {
  @ApiProperty({ enum: ['pro', 'elite'], description: 'Target plan' })
  @IsEnum(['pro', 'elite'])
  plan!: 'pro' | 'elite';
}

export class CancelSubscriptionDto {
  @ApiPropertyOptional({ description: 'Cancel immediately or at period end (default: at end)' })
  @IsOptional()
  @IsBoolean()
  immediate?: boolean;
}

export class RazorpayWebhookDto {
  @ApiProperty({ description: 'Razorpay event type' })
  @IsString()
  @IsNotEmpty()
  event!: string;

  @ApiProperty({ description: 'Razorpay payload' })
  payload!: Record<string, any>;
}

export interface SubscriptionStatus {
  plan:             SubscriptionPlan;
  status:           string;
  maxBots:          number;
  adsEnabled:       boolean;
  advancedAutomation: boolean;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  monthlyAmountInr: number;
  razorpaySubscriptionId: string | null;
}

// Plan feature definitions — single source of truth
export const PLAN_FEATURES: Record<SubscriptionPlan, {
  maxBots: number;
  adsEnabled: boolean;
  advancedAutomation: boolean;
  monthlyAmountInr: number;
}> = {
  free: {
    maxBots:           1,
    adsEnabled:        false,
    advancedAutomation: false,
    monthlyAmountInr:  0,
  },
  pro: {
    maxBots:           5,
    adsEnabled:        true,
    advancedAutomation: false,
    monthlyAmountInr:  1999,
  },
  elite: {
    maxBots:           999, // unlimited
    adsEnabled:        true,
    advancedAutomation: true,
    monthlyAmountInr:  4999,
  },
};
