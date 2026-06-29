import { IsNumber, IsOptional, Min } from 'class-validator';

export class ScoreProductDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  estimatedSellingPrice?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  demandSearchVolume?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  competitorCount?: number;
}
