import {
  IsUUID, IsOptional, IsString, IsIn,
  IsUrl, IsArray, IsNumber, Min, Max, IsInt,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ── Text-to-Image ─────────────────────────────────────────────────────────────

export class GenerateImageDto {
  @ApiProperty({ description: 'Text prompt describing the image to generate' })
  @IsString()
  prompt: string;

  @ApiPropertyOptional({ example: 'flux-schnell-image' })
  @IsString()
  @IsOptional()
  model?: string;

  @ApiPropertyOptional({ enum: ['1:1', '16:9', '9:16', '4:3', '3:4'], default: '1:1' })
  @IsIn(['1:1', '16:9', '9:16', '4:3', '3:4'])
  @IsOptional()
  aspectRatio?: string;

  @ApiPropertyOptional({ enum: ['basic', 'high'] })
  @IsIn(['basic', 'high'])
  @IsOptional()
  quality?: string;

  @ApiPropertyOptional({ enum: ['1K', '2K', '4K'] })
  @IsIn(['1K', '2K', '4K'])
  @IsOptional()
  resolution?: string;
}

// ── Image-to-Image ────────────────────────────────────────────────────────────

export class GenerateI2IDto {
  @ApiProperty({ description: 'URL of the primary reference image' })
  @IsUrl()
  imageUrl: string;

  @ApiPropertyOptional({
    description: 'Additional reference image URLs for multi-image models (up to 14)',
    type: [String],
  })
  @IsArray()
  @IsUrl({}, { each: true })
  @IsOptional()
  imagesList?: string[];

  @ApiPropertyOptional({ description: 'Optional guiding prompt' })
  @IsString()
  @IsOptional()
  prompt?: string;

  @ApiPropertyOptional({ example: 'flux-kontext-dev-i2i' })
  @IsString()
  @IsOptional()
  model?: string;

  @ApiPropertyOptional({ enum: ['1:1', '16:9', '9:16', '4:3', '3:4'], default: '1:1' })
  @IsIn(['1:1', '16:9', '9:16', '4:3', '3:4'])
  @IsOptional()
  aspectRatio?: string;

  @ApiPropertyOptional({ enum: ['basic', 'high'] })
  @IsIn(['basic', 'high'])
  @IsOptional()
  quality?: string;

  @ApiPropertyOptional({ enum: ['1K', '2K', '4K'] })
  @IsIn(['1K', '2K', '4K'])
  @IsOptional()
  resolution?: string;

  @ApiPropertyOptional({ description: 'Blend strength 0–1. Default 0.6', minimum: 0, maximum: 1 })
  @IsNumber()
  @Min(0)
  @Max(1)
  @Type(() => Number)
  @IsOptional()
  strength?: number;
}

// ── Text-to-Video ─────────────────────────────────────────────────────────────

export class GenerateVideoDto {
  @ApiProperty({ description: 'Text prompt describing the video to generate' })
  @IsString()
  prompt: string;

  @ApiPropertyOptional({ example: 'seedance-lite-t2v' })
  @IsString()
  @IsOptional()
  model?: string;

  @ApiPropertyOptional({ enum: ['9:16', '16:9', '1:1', '4:3', '3:4'], default: '9:16' })
  @IsIn(['9:16', '16:9', '1:1', '4:3', '3:4'])
  @IsOptional()
  aspectRatio?: string;

  @ApiPropertyOptional({ minimum: 5, maximum: 15 })
  @IsInt()
  @Min(5)
  @Max(15)
  @Type(() => Number)
  @IsOptional()
  duration?: number;

  @ApiPropertyOptional({ enum: ['480p', '720p', '1080p'] })
  @IsIn(['480p', '720p', '1080p'])
  @IsOptional()
  resolution?: string;

  @ApiPropertyOptional({ enum: ['basic', 'high'] })
  @IsIn(['basic', 'high'])
  @IsOptional()
  quality?: string;

  @ApiPropertyOptional({ description: 'Mode for models that support it (e.g. fun|normal|spicy)' })
  @IsString()
  @IsOptional()
  mode?: string;
}

// ── Image-to-Video ────────────────────────────────────────────────────────────

export class GenerateI2VDto {
  @ApiProperty({ description: 'URL of the start-frame image to animate' })
  @IsUrl()
  imageUrl: string;

  @ApiPropertyOptional({ description: 'Optional motion or scene prompt' })
  @IsString()
  @IsOptional()
  prompt?: string;

  @ApiPropertyOptional({ example: 'kling-v2-1-i2v-standard' })
  @IsString()
  @IsOptional()
  model?: string;

  @ApiPropertyOptional({ enum: ['9:16', '16:9', '1:1', '4:3', '3:4'], default: '9:16' })
  @IsIn(['9:16', '16:9', '1:1', '4:3', '3:4'])
  @IsOptional()
  aspectRatio?: string;

  @ApiPropertyOptional({ minimum: 5, maximum: 15 })
  @IsInt()
  @Min(5)
  @Max(15)
  @Type(() => Number)
  @IsOptional()
  duration?: number;

  @ApiPropertyOptional({ enum: ['480p', '720p', '1080p'] })
  @IsIn(['480p', '720p', '1080p'])
  @IsOptional()
  resolution?: string;

  @ApiPropertyOptional({ enum: ['basic', 'high'] })
  @IsIn(['basic', 'high'])
  @IsOptional()
  quality?: string;
}

// ── Video-to-Video ────────────────────────────────────────────────────────────

export class GenerateV2VDto {
  @ApiProperty({ description: 'URL of the source video to process' })
  @IsUrl()
  videoUrl: string;

  @ApiPropertyOptional({ example: 'video-background-remove' })
  @IsString()
  @IsOptional()
  model?: string;
}

// ── Lip Sync ──────────────────────────────────────────────────────────────────

export class LipSyncDto {
  @ApiProperty({ description: 'URL of the audio file (.mp3, .wav, .m4a)' })
  @IsUrl()
  audioUrl: string;

  @ApiPropertyOptional({ description: 'Portrait image URL — required for portrait-image mode' })
  @IsUrl()
  @ValidateIf((o) => !o.videoUrl)
  @IsOptional()
  imageUrl?: string;

  @ApiPropertyOptional({ description: 'Source video URL — required for video-lipsync mode' })
  @IsUrl()
  @ValidateIf((o) => !o.imageUrl)
  @IsOptional()
  videoUrl?: string;

  @ApiPropertyOptional({ description: 'Optional prompt to guide motion style' })
  @IsString()
  @IsOptional()
  prompt?: string;

  @ApiPropertyOptional({ example: 'ltx-2-3-lipsync' })
  @IsString()
  @IsOptional()
  model?: string;

  @ApiPropertyOptional({ enum: ['480p', '720p', '1080p'] })
  @IsIn(['480p', '720p', '1080p'])
  @IsOptional()
  resolution?: string;
}

// ── Product ad-media bundle ───────────────────────────────────────────────────

export class GenerateAdMediaDto {
  @ApiProperty({ description: 'Product UUID to generate ad media for' })
  @IsUUID()
  productId: string;

  @ApiPropertyOptional({ description: 'Campaign UUID to associate this asset with' })
  @IsUUID()
  @IsOptional()
  campaignId?: string;

  @ApiPropertyOptional({ example: 'flux-schnell-image' })
  @IsString()
  @IsOptional()
  imageModel?: string;

  @ApiPropertyOptional({ example: 'seedance-lite-t2v' })
  @IsString()
  @IsOptional()
  videoModel?: string;
}

// ── Legacy (backward compat) ──────────────────────────────────────────────────

/** @deprecated Use GenerateAdMediaDto */
export class GenerateMediaDto extends GenerateAdMediaDto {
  @ApiPropertyOptional({ description: 'Custom image prompt (overrides auto-generated)' })
  @IsString()
  @IsOptional()
  imagePrompt?: string;

  @ApiPropertyOptional({ description: 'Custom video prompt (overrides auto-generated)' })
  @IsString()
  @IsOptional()
  videoPrompt?: string;

  @ApiPropertyOptional({ enum: ['1:1', '16:9', '9:16', '4:3', '3:4'], default: '1:1' })
  @IsIn(['1:1', '16:9', '9:16', '4:3', '3:4'])
  @IsOptional()
  imageAspectRatio?: string;

  @ApiPropertyOptional({ enum: ['9:16', '16:9', '1:1'], default: '9:16' })
  @IsIn(['9:16', '16:9', '1:1'])
  @IsOptional()
  videoAspectRatio?: string;
}
