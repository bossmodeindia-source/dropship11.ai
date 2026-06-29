import { IsString, IsNumber, IsOptional, IsUUID, IsObject, ValidateNested, Min } from 'class-validator';
import { Type } from 'class-transformer';

class CustomerDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() email?: string;
}

export class WebhookOrderDto {
  @IsString() platformOrderId: string;
  @IsOptional() @IsString() platform?: string;
  /**
   * userId — required when the webhook is sent by an authenticated partner;
   * optional on @Public() inbound webhooks where the sender is a third-party
   * (e.g. Shopify) that carries its own tenant identifier in the payload.
   */
  @IsOptional() @IsUUID() userId?: string;
  @IsOptional() @IsUUID() productId?: string;
  @IsOptional() @IsString() idempotencyKey?: string;
  @IsOptional() @IsObject() @ValidateNested() @Type(() => CustomerDto) customer?: CustomerDto;
  @IsOptional() @IsObject() shippingAddress?: Record<string, unknown>;
  @IsOptional() @IsNumber() @Min(1) quantity?: number;
  @IsNumber() @Min(0) unitPrice: number;
  @IsNumber() @Min(0) totalAmount: number;
  @IsOptional() @IsString() currency?: string;
  @IsOptional() @IsString() supplierType?: string;
}
