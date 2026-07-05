// dto/user-business-connections.dto.ts
import {
  IsString, IsIn, IsOptional, IsArray, IsDateString, IsBoolean, IsNumber, IsObject, IsUrl,
} from 'class-validator';

export type SupportedPlatform =
  | string;

export const WEBSITE_PLATFORM_CATEGORIES = [
  'ecommerce', 'marketplace', 'cms', 'erp', 'pos', 'custom_website',
] as const;

export const WEBSITE_AUTH_TYPES = [
  'oauth2', 'api_key', 'bearer_token', 'jwt', 'username_password', 'webhook', 'custom', 'none',
] as const;

export class ConnectBusinessAccountDto {
  @IsString()
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

export class CreateWebsitePlatformDto {
  @IsString()
  name: string;

  @IsString()
  slug: string;

  @IsOptional() @IsString()
  logoUrl?: string;

  @IsOptional() @IsString()
  description?: string;

  @IsIn(WEBSITE_PLATFORM_CATEGORIES)
  category: typeof WEBSITE_PLATFORM_CATEGORIES[number];

  @IsIn(WEBSITE_AUTH_TYPES)
  authType: typeof WEBSITE_AUTH_TYPES[number];

  @IsOptional() @IsString()
  apiBaseUrl?: string;

  @IsOptional() @IsString()
  oauthUrl?: string;

  @IsOptional() @IsString()
  tokenUrl?: string;

  @IsOptional() @IsString()
  redirectUrl?: string;

  @IsOptional() @IsArray()
  scopes?: string[];

  @IsOptional() @IsArray()
  requiredFields?: Array<Record<string, unknown>>;

  @IsOptional() @IsString()
  webhookSecret?: string;

  @IsOptional() @IsString()
  apiVersion?: string;

  @IsOptional() @IsString()
  healthEndpoint?: string;

  @IsOptional() @IsString()
  documentationUrl?: string;

  @IsOptional() @IsObject()
  supportedFeatures?: Record<string, boolean>;

  @IsOptional() @IsObject()
  connectionWizard?: Record<string, unknown>;

  @IsOptional() @IsBoolean()
  enabled?: boolean;

  @IsOptional() @IsBoolean()
  maintenanceMode?: boolean;

  @IsOptional() @IsBoolean()
  isDefault?: boolean;

  @IsOptional() @IsNumber()
  priority?: number;

  @IsOptional() @IsNumber()
  fallbackPriority?: number;
}

export class UpdateWebsitePlatformDto extends CreateWebsitePlatformDto {}

export class ConnectWebsitePlatformDto {
  @IsString()
  platformSlug: string;

  @IsOptional() @IsString()
  accountLabel?: string;

  @IsOptional() @IsObject()
  credentials?: Record<string, string>;

  @IsOptional() @IsObject()
  metadata?: Record<string, unknown>;
}

export class RotateWebsitePlatformCredentialsDto {
  @IsObject()
  credentials: Record<string, string>;

  @IsOptional() @IsString()
  reason?: string;
}

export class StoreOAuthStartDto {
  @IsString()
  platformSlug: string;

  @IsUrl({ require_tld: false })
  redirectUri: string;
}

export class StoreOAuthCallbackDto {
  @IsString()
  platformSlug: string;

  @IsString()
  state: string;

  @IsUrl({ require_tld: false })
  redirectUri: string;

  @IsString()
  code: string;

  @IsOptional() @IsString()
  refreshToken?: string;
}

export class StoreWebhookDto {
  @IsString()
  platformSlug: string;

  @IsString()
  eventId: string;

  @IsString()
  eventType: string;

  @IsString()
  signature: string;

  @IsObject()
  payload: Record<string, unknown>;
}
