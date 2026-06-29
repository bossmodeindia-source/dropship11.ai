import {
  IsString, IsOptional, IsBoolean, IsNumber, IsIn,
  IsUrl, IsObject, MaxLength, MinLength,
} from 'class-validator';

export class CreateProviderDto {
  @IsString() @MinLength(2) @MaxLength(50)
  providerKey: string;

  @IsString() @MinLength(2) @MaxLength(100)
  displayName: string;

  @IsIn(['reasoning','image_generation','video_generation','voice','embedding','multimodal'])
  category: string;

  @IsOptional() @IsString() @MaxLength(500)
  description?: string;

  @IsOptional() @IsString()
  sdkClass?: string;

  @IsOptional() @IsUrl()
  baseUrl?: string;

  @IsOptional() @IsUrl()
  docsUrl?: string;

  @IsOptional() @IsBoolean()
  requiresSecondaryKey?: boolean;

  @IsOptional() @IsString()
  secondaryKeyLabel?: string;

  @IsOptional() @IsUrl()
  healthCheckUrl?: string;

  @IsOptional() @IsObject()
  capabilities?: Record<string, unknown>;

  @IsOptional() @IsNumber()
  pricingPerUnit?: number;

  @IsOptional() @IsString()
  pricingUnit?: string;

  @IsOptional() @IsNumber()
  sortOrder?: number;
}

export class UpdateProviderDto {
  @IsOptional() @IsString() @MaxLength(100)
  displayName?: string;

  @IsOptional() @IsString() @MaxLength(500)
  description?: string;

  @IsOptional() @IsUrl()
  baseUrl?: string;

  @IsOptional() @IsUrl()
  docsUrl?: string;

  @IsOptional() @IsObject()
  capabilities?: Record<string, unknown>;

  @IsOptional() @IsNumber()
  pricingPerUnit?: number;

  @IsOptional() @IsString()
  pricingUnit?: string;

  @IsOptional() @IsNumber()
  sortOrder?: number;
}

export class ApproveProviderDto {
  @IsOptional() @IsString() @MaxLength(500)
  notes?: string;
}

export class DisableProviderDto {
  @IsString() @MinLength(10) @MaxLength(500)
  reason: string;
}

export class SubmitProviderRequestDto {
  @IsString() @MinLength(2) @MaxLength(100)
  providerName: string;

  @IsOptional() @IsUrl()
  providerUrl?: string;

  @IsString() @MinLength(20) @MaxLength(1000)
  reason: string;

  @IsOptional() @IsString() @MaxLength(500)
  useCase?: string;
}
