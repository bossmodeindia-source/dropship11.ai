import { IsUUID, IsEnum, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class LaunchMetaCampaignDto {
  @ApiProperty({ description: 'Product ID to run ads for' })
  @IsUUID()
  productId: string;

  @ApiPropertyOptional({
    enum: ['RUN_ADS', 'TEST_ADS'],
    description:
      'Override the product decision. Defaults to product.decision if it is RUN_ADS or TEST_ADS.',
  })
  @IsEnum(['RUN_ADS', 'TEST_ADS'])
  @IsOptional()
  decision?: 'RUN_ADS' | 'TEST_ADS';
}
