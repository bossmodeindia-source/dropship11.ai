import { IsNumber, IsString, IsOptional, IsUrl } from 'class-validator';

/**
 * TelegramAuthDto — payload from Telegram Login Widget
 * https://core.telegram.org/widgets/login
 *
 * The widget redirects to your callback URL with these query params:
 *   ?id=...&first_name=...&username=...&photo_url=...&auth_date=...&hash=...
 */
export class TelegramAuthDto {
  @IsNumber()
  id: number;

  @IsString()
  first_name: string;

  @IsOptional()
  @IsString()
  last_name?: string;

  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsUrl()
  photo_url?: string;

  @IsNumber()
  auth_date: number;

  /** HMAC-SHA256 of the data-check-string, keyed with SHA256(BOT_TOKEN) */
  @IsString()
  hash: string;
}
