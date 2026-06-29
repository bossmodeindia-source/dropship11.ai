import { IsOptional, IsString, IsBoolean, IsEnum } from 'class-validator';

export class UpdateUserDto {
  @IsOptional() @IsEnum(['user', 'admin', 'superadmin']) role?: 'user' | 'admin' | 'superadmin';
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsString() fullName?: string;
  @IsOptional() @IsString() companyName?: string;
  @IsOptional() @IsEnum(['AI', 'BOT']) aiMode?: 'AI' | 'BOT';
}
