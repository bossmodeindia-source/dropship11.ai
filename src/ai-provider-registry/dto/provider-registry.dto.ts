import {
  IsString, IsOptional, IsBoolean, IsNumber, IsIn,
  IsUrl, IsObject, MaxLength, MinLength, IsArray,
} from 'class-validator';

export const AI_PROVIDER_TYPES = [
  'chat', 'vision', 'image', 'video', 'audio', 'embedding', 'ocr', 'code',
] as const;

export const AI_PROVIDER_CATEGORIES = [
  'reasoning','image_generation','video_generation','voice','embedding','multimodal',
] as const;

export class CreateProviderDto {
  @IsString() @MinLength(2) @MaxLength(50)
  providerKey: string;

  @IsString() @MinLength(2) @MaxLength(100)
  displayName: string;

  @IsIn(AI_PROVIDER_CATEGORIES)
  category: string;

  @IsOptional() @IsIn(AI_PROVIDER_TYPES)
  providerType?: string;

  @IsOptional() @IsString() @MaxLength(500)
  description?: string;

  @IsOptional() @IsUrl()
  logoUrl?: string;

  @IsOptional() @IsString()
  sdkClass?: string;

  @IsOptional() @IsUrl()
  baseUrl?: string;

  @IsOptional() @IsUrl()
  apiBaseUrl?: string;

  @IsOptional() @IsString()
  apiKey?: string;

  @IsOptional() @IsString()
  organizationId?: string;

  @IsOptional() @IsUrl()
  docsUrl?: string;

  @IsOptional() @IsBoolean()
  requiresSecondaryKey?: boolean;

  @IsOptional() @IsString()
  secondaryKeyLabel?: string;

  @IsOptional() @IsUrl()
  healthCheckUrl?: string;

  @IsOptional() @IsString()
  healthCheckEndpoint?: string;

  @IsOptional() @IsObject()
  capabilities?: Record<string, unknown>;

  @IsOptional() @IsArray()
  supportedModels?: string[];

  @IsOptional() @IsArray()
  modelList?: string[];

  @IsOptional() @IsString()
  defaultModel?: string;

  @IsOptional() @IsNumber()
  maxTokens?: number;

  @IsOptional() @IsNumber()
  temperature?: number;

  @IsOptional() @IsNumber()
  topP?: number;

  @IsOptional() @IsNumber()
  timeoutMs?: number;

  @IsOptional() @IsNumber()
  retryCount?: number;

  @IsOptional() @IsNumber()
  pricingPerUnit?: number;

  @IsOptional() @IsNumber()
  costPer1KTokens?: number;

  @IsOptional() @IsString()
  pricingUnit?: string;

  @IsOptional() @IsNumber()
  dailyBudget?: number;

  @IsOptional() @IsNumber()
  monthlyBudget?: number;

  @IsOptional() @IsNumber()
  requestsPerMinute?: number;

  @IsOptional() @IsNumber()
  requestsPerDay?: number;

  @IsOptional() @IsObject()
  quotas?: Record<string, unknown>;

  @IsOptional() @IsObject()
  rateLimits?: Record<string, unknown>;

  @IsOptional() @IsObject()
  circuitBreakerSettings?: Record<string, unknown>;

  @IsOptional() @IsNumber()
  priority?: number;

  @IsOptional() @IsNumber()
  fallbackPriority?: number;

  @IsOptional() @IsBoolean()
  enabled?: boolean;

  @IsOptional() @IsBoolean()
  byokEnabled?: boolean;

  @IsOptional() @IsBoolean()
  supportsStreaming?: boolean;

  @IsOptional() @IsBoolean()
  supportsVision?: boolean;

  @IsOptional() @IsBoolean()
  supportsImageGeneration?: boolean;

  @IsOptional() @IsBoolean()
  supportsFunctionCalling?: boolean;

  @IsOptional() @IsBoolean()
  supportsJsonMode?: boolean;

  @IsOptional() @IsString()
  apiFormat?: string;

  @IsOptional() @IsString()
  endpointPath?: string;

  @IsOptional() @IsString()
  authHeaderName?: string;

  @IsOptional() @IsString()
  authHeaderTemplate?: string;

  @IsOptional() @IsObject()
  requestTemplate?: Record<string, unknown>;

  @IsOptional() @IsObject()
  responseMapping?: Record<string, unknown>;

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
  apiBaseUrl?: string;

  @IsOptional() @IsString()
  apiKey?: string;

  @IsOptional() @IsString()
  organizationId?: string;

  @IsOptional() @IsUrl()
  docsUrl?: string;

  @IsOptional() @IsUrl()
  logoUrl?: string;

  @IsOptional() @IsIn(AI_PROVIDER_TYPES)
  providerType?: string;

  @IsOptional() @IsIn(AI_PROVIDER_CATEGORIES)
  category?: string;

  @IsOptional() @IsString()
  healthCheckEndpoint?: string;

  @IsOptional() @IsObject()
  capabilities?: Record<string, unknown>;

  @IsOptional() @IsArray()
  supportedModels?: string[];

  @IsOptional() @IsArray()
  modelList?: string[];

  @IsOptional() @IsString()
  defaultModel?: string;

  @IsOptional() @IsNumber()
  maxTokens?: number;

  @IsOptional() @IsNumber()
  temperature?: number;

  @IsOptional() @IsNumber()
  topP?: number;

  @IsOptional() @IsNumber()
  timeoutMs?: number;

  @IsOptional() @IsNumber()
  retryCount?: number;

  @IsOptional() @IsNumber()
  pricingPerUnit?: number;

  @IsOptional() @IsNumber()
  costPer1KTokens?: number;

  @IsOptional() @IsString()
  pricingUnit?: string;

  @IsOptional() @IsNumber()
  dailyBudget?: number;

  @IsOptional() @IsNumber()
  monthlyBudget?: number;

  @IsOptional() @IsNumber()
  requestsPerMinute?: number;

  @IsOptional() @IsNumber()
  requestsPerDay?: number;

  @IsOptional() @IsObject()
  quotas?: Record<string, unknown>;

  @IsOptional() @IsObject()
  rateLimits?: Record<string, unknown>;

  @IsOptional() @IsObject()
  circuitBreakerSettings?: Record<string, unknown>;

  @IsOptional() @IsNumber()
  priority?: number;

  @IsOptional() @IsNumber()
  fallbackPriority?: number;

  @IsOptional() @IsBoolean()
  enabled?: boolean;

  @IsOptional() @IsBoolean()
  byokEnabled?: boolean;

  @IsOptional() @IsBoolean()
  supportsStreaming?: boolean;

  @IsOptional() @IsBoolean()
  supportsVision?: boolean;

  @IsOptional() @IsBoolean()
  supportsImageGeneration?: boolean;

  @IsOptional() @IsBoolean()
  supportsFunctionCalling?: boolean;

  @IsOptional() @IsBoolean()
  supportsJsonMode?: boolean;

  @IsOptional() @IsString()
  apiFormat?: string;

  @IsOptional() @IsString()
  endpointPath?: string;

  @IsOptional() @IsString()
  authHeaderName?: string;

  @IsOptional() @IsString()
  authHeaderTemplate?: string;

  @IsOptional() @IsObject()
  requestTemplate?: Record<string, unknown>;

  @IsOptional() @IsObject()
  responseMapping?: Record<string, unknown>;

  @IsOptional() @IsNumber()
  sortOrder?: number;
}

export class ImportProvidersDto {
  @IsArray()
  providers: CreateProviderDto[];
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
