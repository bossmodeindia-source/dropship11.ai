import {
  IsString, IsNotEmpty, IsOptional, IsEnum, IsUrl,
  MinLength, MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SubmitProviderRequestDto {
  @ApiProperty({ example: 'Groq', description: 'Provider display name' })
  @IsString() @IsNotEmpty() @MaxLength(80)
  providerName: string;

  @ApiPropertyOptional({ example: 'https://groq.com' })
  @IsOptional() @IsUrl()
  providerUrl?: string;

  @ApiPropertyOptional({ example: 'https://console.groq.com/docs' })
  @IsOptional() @IsUrl()
  docsUrl?: string;

  @ApiProperty({
    enum: ['reasoning','image_generation','video_generation','voice','embedding','multimodal'],
    example: 'reasoning',
  })
  @IsEnum(['reasoning','image_generation','video_generation','voice','embedding','multimodal'])
  category: string;

  @ApiProperty({
    example: 'Groq offers blazing-fast inference for Llama models — ideal for script generation.',
    description: 'Why does this provider benefit the platform? (min 50 chars)',
  })
  @IsString() @MinLength(50) @MaxLength(2000)
  useCase: string;

  @ApiPropertyOptional({ example: '~$0.10 per 1M tokens' })
  @IsOptional() @IsString() @MaxLength(200)
  estimatedPricing?: string;
}

export class ReviewProviderRequestDto {
  @ApiProperty({ enum: ['approved','rejected'], example: 'approved' })
  @IsEnum(['approved','rejected'])
  decision: 'approved' | 'rejected';

  @ApiProperty({ example: 'Meets stability, pricing, and security requirements.' })
  @IsString() @IsNotEmpty() @MinLength(10) @MaxLength(1000)
  adminNote: string;

  /** Only required when decision === 'approved'. */
  @ApiPropertyOptional({ example: 'groq' })
  @IsOptional() @IsString() @MaxLength(50)
  providerKey?: string;
}
