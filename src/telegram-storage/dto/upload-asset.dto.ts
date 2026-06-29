import {
  IsEnum, IsOptional, IsString, IsUUID,
  IsNotEmpty, MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AssetType } from '../telegram-storage.schema';

export class UploadAssetDto {
  @ApiProperty({ enum: ['video','image','reel','zip','backup','creative','pdf','report','strategy','export','website-build','other'] })
  @IsEnum(['video','image','reel','zip','backup','creative','pdf','report','strategy','export','website-build','other'])
  assetType: AssetType;

  @ApiPropertyOptional()
  @IsOptional() @IsUUID()
  projectId?: string;

  @ApiPropertyOptional()
  @IsOptional() @IsUUID()
  campaignId?: string;

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: { type: 'string' } })
  @IsOptional()
  tags?: Record<string, string>;
}

export class ProvisionBotDto {
  @ApiProperty({ description: 'Desired bot name shown in BotFather' })
  @IsString() @IsNotEmpty() @MaxLength(64)
  botName: string;

  @ApiProperty({ description: 'Desired bot username (without @)' })
  @IsString() @IsNotEmpty() @MaxLength(32)
  botUsername: string;
}

export class AdminSetMtprotoDto {
  @ApiProperty()
  @IsString() @IsNotEmpty()
  sessionName: string;

  @ApiProperty()
  @IsString() @IsNotEmpty()
  apiId: string;

  @ApiProperty()
  @IsString() @IsNotEmpty()
  apiHash: string;

  @ApiProperty()
  @IsString() @IsNotEmpty()
  sessionString: string;

  @ApiProperty()
  @IsString() @IsNotEmpty()
  phoneNumber: string;
}
