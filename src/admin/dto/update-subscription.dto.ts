import { IsOptional, IsEnum, IsInt, Min } from 'class-validator';

export class UpdateSubscriptionDto {
  @IsOptional() @IsEnum(['free', 'starter', 'pro', 'enterprise']) tier?: 'free' | 'starter' | 'pro' | 'enterprise';
  @IsOptional() @IsEnum(['active', 'trialing', 'past_due', 'canceled', 'paused']) status?: 'active' | 'trialing' | 'past_due' | 'canceled' | 'paused';
  @IsOptional() @IsInt() @Min(0) productLimit?: number;
  @IsOptional() @IsInt() @Min(0) orderLimit?: number;
  @IsOptional() @IsInt() @Min(0) aiRequestsLimit?: number;
}
