import {
  IsString, IsOptional, IsNumber, IsArray,
  Min, MaxLength, IsNotEmpty,
} from 'class-validator';

export class CreateShopifyProductDto {
  @IsString() @IsNotEmpty() @MaxLength(500)
  title: string;

  @IsOptional() @IsString()
  bodyHtml?: string;

  @IsOptional() @IsString() @MaxLength(100)
  vendor?: string;

  @IsOptional() @IsString() @MaxLength(100)
  productType?: string;

  @IsOptional() @IsArray() @IsString({ each: true })
  tags?: string[];

  @IsOptional() @IsString()
  status?: 'active' | 'draft' | 'archived';

  // At least one variant with price is required by Shopify
  @IsNumber() @Min(0)
  price: number;

  @IsOptional() @IsNumber() @Min(0)
  compareAtPrice?: number;

  @IsOptional() @IsString()
  sku?: string;

  @IsOptional() @IsArray() @IsString({ each: true })
  imageUrls?: string[];
}

export class UpdateShopifyProductDto {
  @IsOptional() @IsString() @MaxLength(500)
  title?: string;

  @IsOptional() @IsString()
  bodyHtml?: string;

  @IsOptional() @IsNumber() @Min(0)
  price?: number;

  @IsOptional() @IsString()
  status?: 'active' | 'draft' | 'archived';

  @IsOptional() @IsArray() @IsString({ each: true })
  tags?: string[];
}
