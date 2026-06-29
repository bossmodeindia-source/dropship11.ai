import { IsString, IsNotEmpty, MaxLength, IsOptional, IsUrl } from 'class-validator';

export class SaveShopifyApiKeyDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  shopDomain: string; // e.g. "my-store.myshopify.com"

  @IsString()
  @IsNotEmpty()
  accessToken: string; // Shopify Admin API access token

  @IsOptional()
  @IsString()
  @MaxLength(255)
  webhookSecret?: string; // Secret used to verify incoming Shopify webhooks
}
