import { IsUUID, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class GenerateCreativesDto {
  @ApiProperty({ description: 'Product UUID to generate creatives for' })
  @IsUUID()
  productId!: string;

  @ApiPropertyOptional({ description: 'Campaign UUID to associate the creatives with' })
  @IsUUID()
  @IsOptional()
  campaignId?: string;
}
