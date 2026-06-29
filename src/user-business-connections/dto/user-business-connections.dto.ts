// dto/user-business-connections.dto.ts
import {
  IsString, IsIn, IsOptional, IsArray, IsUrl, IsDateString,
} from 'class-validator';

export type SupportedPlatform =
  | 'meta_ads'
  | 'meta_instagram'
  | 'meta_facebook_page'
  | 'tiktok'
  | 'youtube'
  | 'shopify'
  | 'whatsapp_business'
  | 'telegram_notify';

const PLATFORMS: SupportedPlatform[] = [
  'meta_ads','meta_instagram','meta_facebook_page',
  'tiktok','youtube','shopify','whatsapp_business','telegram_notify',
];

export class ConnectBusinessAccountDto {
  @IsIn(PLATFORMS)
  platform: SupportedPlatform;

  @IsOptional() @IsString()
  accountLabel?: string;

  @IsOptional() @IsString()
  primaryToken?: string;

  @IsOptional() @IsString()
  secondaryToken?: string;

  /** Meta: ad account ID or Shopify: store domain */
  @IsOptional() @IsString()
  accountId?: string;

  @IsOptional() @IsString()
  pixelId?: string;

  @IsOptional() @IsArray()
  scopesGranted?: string[];

  @IsOptional() @IsDateString()
  tokenExpiresAt?: string;
}

export class DisconnectAccountDto {
  @IsString()
  reason?: string;
}
