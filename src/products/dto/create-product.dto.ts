import { IsString, IsNumber, IsOptional, IsArray, Min, MaxLength } from 'class-validator';
export class CreateProductDto {
  @IsString() @MaxLength(500) title: string;
  @IsOptional() @IsString() description?: string;
  @IsNumber() @Min(0) supplierPrice: number;
  @IsOptional() @IsNumber() @Min(0) sellingPrice?: number;
  @IsOptional() @IsString() supplierType?: string;
  @IsOptional() @IsString() currency?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) imageUrls?: string[];
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[];
  @IsOptional() @IsString() externalId?: string;
  @IsOptional()
  @IsNumber()
  estimatedSellingPrice?: number;
}
