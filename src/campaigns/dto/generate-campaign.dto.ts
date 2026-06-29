import { IsString, IsOptional, IsUUID, IsNumber, IsObject, Min } from 'class-validator';
export class GenerateCampaignDto {
  @IsUUID() productId: string;
  @IsOptional() @IsString() platform?: string;
  @IsOptional() @IsString() objective?: string;
  @IsOptional() @IsObject() targetAudience?: Record<string, unknown>;
  @IsOptional() @IsNumber() @Min(1) budgetDaily?: number;
  @IsOptional() @IsNumber() @Min(1) budgetTotal?: number;
}
