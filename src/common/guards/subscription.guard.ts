import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtPayload } from '../decorators/current-user.decorator';
import { Request } from 'express';

export type SubscriptionTier = 'free' | 'starter' | 'pro' | 'enterprise';

export const REQUIRED_TIER_KEY = 'requiredTier';
export const RequiresTier = (tier: SubscriptionTier) =>
  SetMetadata(REQUIRED_TIER_KEY, tier);

const TIER_HIERARCHY: Record<SubscriptionTier, number> = {
  free:       0,
  starter:    1,
  pro:        2,
  enterprise: 3,
};

@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<SubscriptionTier>(
      REQUIRED_TIER_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return true;

    const req = context
      .switchToHttp()
      .getRequest<Request & { user: JwtPayload }>();

    const userTier = (req.user?.subscriptionTier ?? 'free') as SubscriptionTier;
    const userLevel = TIER_HIERARCHY[userTier] ?? 0;
    const requiredLevel = TIER_HIERARCHY[required] ?? 99;

    if (userLevel < requiredLevel) {
      throw new ForbiddenException(
        `This feature requires a ${required} subscription or higher. ` +
        `Your current plan: ${userTier}.`,
      );
    }
    return true;
  }
}
