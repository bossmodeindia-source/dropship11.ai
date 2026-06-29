// dto/user-ai-connections.dto.ts
import { IsString, IsUUID, IsBoolean, IsOptional, IsNumber, Min } from 'class-validator';

export class ConnectProviderDto {
  @IsUUID()
  providerId: string;

  @IsString()
  apiKey: string;

  @IsOptional() @IsString()
  secondaryKey?: string;

  @IsOptional() @IsBoolean()
  allowPlatformFallback?: boolean;

  @IsOptional() @IsNumber() @Min(1)
  quotaLimit?: number;
}

export class UpdateConnectionDto {
  @IsOptional() @IsBoolean()
  allowPlatformFallback?: boolean;

  @IsOptional() @IsNumber() @Min(1)
  quotaLimit?: number;
}
